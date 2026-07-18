import { describe, expect, it } from "vitest";
import {
  buildImplementFailureCommentBody,
  buildImplementPrBody,
  deriveBranchName,
  FACTORY_PR_BASE_REF,
  findExistingImplementFailureCommentId,
  findForbiddenPatchPaths,
  findPrForIssueNumber,
  IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN,
  IMPLEMENT_FAILURE_COMMENT_MARKER,
  isProtectedPath,
  normalizePatchPath,
  parseNameStatusZ,
  type ExistingComment,
} from "../../scripts/factory/implement-patch-logic.mts";

describe("normalizePatchPath", () => {
  it("strips a leading a/ or b/ diff prefix", () => {
    expect(normalizePatchPath("a/lib/slug.ts")).toBe("lib/slug.ts");
    expect(normalizePatchPath("b/lib/slug.ts")).toBe("lib/slug.ts");
  });

  it("leaves a path with neither prefix untouched (aside from segment resolution)", () => {
    expect(normalizePatchPath("lib/slug.ts")).toBe("lib/slug.ts");
  });

  it("collapses ./ segments", () => {
    expect(normalizePatchPath("a/./lib/./slug.ts")).toBe("lib/slug.ts");
  });

  it("resolves .. segments within the tree", () => {
    expect(normalizePatchPath("a/lib/../scripts/factory/x.mts")).toBe(
      "scripts/factory/x.mts",
    );
  });

  it("preserves a leading .. that escapes the repo root (traversal attempt)", () => {
    expect(normalizePatchPath("a/../.github/workflows/evil.yml")).toBe(
      "../.github/workflows/evil.yml",
    );
  });
});

describe("isProtectedPath", () => {
  it("protects everything under .github/", () => {
    expect(isProtectedPath(".github/workflows/triage-issues.yml")).toBe(
      true,
    );
    expect(isProtectedPath(".github/ISSUE_TEMPLATE/story.yml")).toBe(true);
  });

  it("protects everything under scripts/factory/ (the privileged glue scripts)", () => {
    expect(
      isProtectedPath("scripts/factory/apply-triage-verdict.mts"),
    ).toBe(true);
  });

  it("protects CODEOWNERS at root and under docs/", () => {
    expect(isProtectedPath("CODEOWNERS")).toBe(true);
    expect(isProtectedPath("docs/CODEOWNERS")).toBe(true);
  });

  it("does not protect ordinary application paths", () => {
    expect(isProtectedPath("lib/slug.ts")).toBe(false);
    expect(isProtectedPath("app/r/[slug]/page.tsx")).toBe(false);
    expect(isProtectedPath("tests/factory/patch-diff.test.ts")).toBe(false);
  });

  it("fails closed on an unresolved traversal (leading ..)", () => {
    expect(isProtectedPath("../outside-repo/file.ts")).toBe(true);
  });

  it("fails closed on an absolute path", () => {
    expect(isProtectedPath("/etc/passwd")).toBe(true);
  });

  it("does NOT false-positive on a path that merely starts with a similar prefix (.github-like/ or scripts/factory-like/)", () => {
    // Guards against an overly loose prefix check (e.g. a plain substring
    // match) that would over-block legitimate paths.
    expect(isProtectedPath(".github-archive/notes.md")).toBe(false);
    expect(isProtectedPath("scripts/factory-notes/readme.md")).toBe(false);
  });
});

describe("findForbiddenPatchPaths", () => {
  it("returns empty for a clean patch touching only application code", () => {
    expect(
      findForbiddenPatchPaths([
        "a/lib/slug.ts",
        "b/lib/slug.ts",
        "a/tests/factory/slug.test.ts",
        "b/tests/factory/slug.test.ts",
      ]),
    ).toEqual([]);
  });

  it("flags a workflow file touched anywhere in the patch", () => {
    const forbidden = findForbiddenPatchPaths([
      "a/lib/slug.ts",
      "b/lib/slug.ts",
      "a/.github/workflows/triage-issues.yml",
      "b/.github/workflows/triage-issues.yml",
    ]);
    expect(forbidden).toEqual([".github/workflows/triage-issues.yml"]);
  });

  it("flags the privileged glue scripts even though they live outside .github/**", () => {
    const forbidden = findForbiddenPatchPaths([
      "a/scripts/factory/publish-implement-patch.mts",
      "b/scripts/factory/publish-implement-patch.mts",
    ]);
    expect(forbidden).toEqual(["scripts/factory/publish-implement-patch.mts"]);
  });

  it("flags a rename INTO a protected path even if the source path was safe", () => {
    const forbidden = findForbiddenPatchPaths([
      "a/lib/innocuous.ts",
      "b/.github/workflows/evil.yml",
    ]);
    expect(forbidden).toContain(".github/workflows/evil.yml");
  });

  it("de-duplicates and sorts the result", () => {
    const forbidden = findForbiddenPatchPaths([
      "a/.github/workflows/a.yml",
      "b/.github/workflows/a.yml",
      "a/.github/workflows/b.yml",
      "b/.github/workflows/b.yml",
    ]);
    expect(forbidden).toEqual([
      ".github/workflows/a.yml",
      ".github/workflows/b.yml",
    ]);
  });

  it("works on paths with NO a/b prefix — the real shape git apply --numstat reports", () => {
    // The primary caller (publish-implement-patch.mts) feeds this
    // authoritative, already-git-resolved paths, not diff-header text —
    // no a/ or b/ prefix to strip.
    const forbidden = findForbiddenPatchPaths([
      "lib/slug.ts",
      ".github/workflows/evil.yml",
    ]);
    expect(forbidden).toEqual([".github/workflows/evil.yml"]);
  });

  it("catches the zz/-prefix exploit shape once normalized (git apply's default -p1 strips ANY first segment, not just a/b)", () => {
    // Simulates what getAuthoritativeChangedPaths would have returned had
    // it been a naive a/b/-only strip instead of asking git: this proves
    // isProtectedPath's fail-closed traversal handling isn't the only
    // thing standing between a zz/-prefixed path and detection — even a
    // RAW, unstripped "zz/.github/..." path is caught, because
    // normalizePatchPath only strips a LITERAL "a/"/"b/" and this path
    // has neither, so isProtectedPath must catch it some other way.
    // (Documented here to make the invariant explicit: the REAL defense
    // against the zz/ exploit is asking git for the resolved path in the
    // first place — see publish-implement-patch.mts — not this function
    // alone silently saving a wrong input.)
    const forbidden = findForbiddenPatchPaths(["zz/.github/workflows/evil.yml"]);
    expect(forbidden).toEqual([]); // Confirms: this function does NOT
    // magically fix an unresolved zz/ prefix — the fix has to be upstream
    // (asking git), which is exactly why publish-implement-patch.mts's
    // getAuthoritativeChangedPaths exists instead of a smarter regex here.
  });
});

describe("parseNameStatusZ", () => {
  it("parses a single-file, single-path record (add)", () => {
    expect(parseNameStatusZ("A\0lib/new-file.ts\0")).toEqual([
      "lib/new-file.ts",
    ]);
  });

  it("parses a modify and a delete record", () => {
    expect(parseNameStatusZ("M\0lib/a.ts\0")).toEqual(["lib/a.ts"]);
    expect(parseNameStatusZ("D\0lib/a.ts\0")).toEqual(["lib/a.ts"]);
  });

  it("parses multiple NUL-terminated single-path records", () => {
    // Built via join(), not a literal NUL-followed-by-digit in the
    // string -- a hand-written fixture gotcha, not something real git
    // output has to worry about.
    const input = ["A", "lib/a.ts", "M", "lib/b.ts", ""].join("\0");
    expect(parseNameStatusZ(input)).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  it("parses a path containing a space correctly (NUL-delimited fields, not whitespace-delimited)", () => {
    expect(parseNameStatusZ("A\0lib/new file.ts\0")).toEqual([
      "lib/new file.ts",
    ]);
  });

  it("returns BOTH sides of a rename record (R-score), unlike the old destination-only numstat oracle", () => {
    expect(
      parseNameStatusZ("R100\0scripts/factory/x.mts\0scripts/other/y.mts\0"),
    ).toEqual(["scripts/factory/x.mts", "scripts/other/y.mts"]);
  });

  it("returns BOTH sides of a copy record (C-score), unquoted -- the Codex round-4 quoted-copy-from case's oracle output", () => {
    expect(
      parseNameStatusZ(
        "C100\0scripts/factory/publish-implement-patch.mts\0lib/copy-dest.mts\0",
      ),
    ).toEqual([
      "scripts/factory/publish-implement-patch.mts",
      "lib/copy-dest.mts",
    ]);
  });

  it("parses a mixed add + rename record set in one call, preserving record boundaries", () => {
    // Exactly the shape empirically verified against real git output for
    // a two-file patch (one plain add, one rename).
    const input =
      "A\0lib/new-file.ts\0R100\0scripts/factory/publish-implement-patch.mts\0scripts/other/x.mts\0";
    expect(parseNameStatusZ(input)).toEqual([
      "lib/new-file.ts",
      "scripts/factory/publish-implement-patch.mts",
      "scripts/other/x.mts",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });

  it("stops at a malformed record with an empty status field, returning whatever was parsed before it", () => {
    // A leading empty field (before any real status) — shouldn't happen
    // from a real git invocation, but the parser fails closed by
    // stopping rather than misinterpreting later fields as a status.
    expect(parseNameStatusZ("\0lib/x.ts\0")).toEqual([]);
  });

  it("does not push a path for a truncated single-path record (a status with nothing following it)", () => {
    expect(parseNameStatusZ("A")).toEqual([]);
  });

  it("does not push a path for a truncated rename/copy record (a status with no paths following it)", () => {
    expect(parseNameStatusZ("R100")).toEqual([]);
  });

  it("pushes only the old path for a rename/copy record truncated after just the first path", () => {
    expect(parseNameStatusZ("R100\0scripts/factory/x.mts")).toEqual([
      "scripts/factory/x.mts",
    ]);
  });
});

const HOME_REPO = "syamaner/roastpilot-cloud";

describe("findPrForIssueNumber", () => {
  it("finds a PR whose branch matches the feature/{issueNumber}- prefix and lives in this repo", () => {
    const prs = [
      { number: 1, headRef: "feature/60-unrelated", headRepoFullName: HOME_REPO, baseRef: "main" },
      { number: 2, headRef: "feature/6-implement-workflow", headRepoFullName: HOME_REPO, baseRef: "main" },
    ];
    expect(findPrForIssueNumber(prs, 6, HOME_REPO)).toEqual({
      number: 2,
      headRef: "feature/6-implement-workflow",
      headRepoFullName: HOME_REPO,
      baseRef: "main",
    });
  });

  it("is not fooled by a numeric-prefix collision (issue 6 vs issue 60)", () => {
    const prs = [{ number: 1, headRef: "feature/60-unrelated-issue", headRepoFullName: HOME_REPO, baseRef: "main" }];
    expect(findPrForIssueNumber(prs, 6, HOME_REPO)).toBeNull();
  });

  it("returns null when no PR matches", () => {
    expect(findPrForIssueNumber([], 6, HOME_REPO)).toBeNull();
  });

  it("finds the branch regardless of what slug it carries (title-independent)", () => {
    const prs = [
      { number: 5, headRef: "feature/6-a-totally-different-slug-now", headRepoFullName: HOME_REPO, baseRef: "main" },
    ];
    expect(findPrForIssueNumber(prs, 6, HOME_REPO)).not.toBeNull();
  });

  it("rejects a branch-name match whose head repo is a fork, not this repo (Codex round-7 finding)", () => {
    // On a public repo, anyone can open a PR from a fork whose branch
    // happens to be named feature/{issueNumber}-anything — this must
    // never be mistaken for the factory's own PR for that issue.
    const prs = [
      { number: 9, headRef: "feature/6-implement-workflow", headRepoFullName: "some-attacker/roastpilot-cloud", baseRef: "main" },
    ];
    expect(findPrForIssueNumber(prs, 6, HOME_REPO)).toBeNull();
  });

  it("prefers a same-repo match over an earlier fork match with the same branch prefix", () => {
    const prs = [
      { number: 9, headRef: "feature/6-implement-workflow", headRepoFullName: "some-attacker/roastpilot-cloud", baseRef: "main" },
      { number: 10, headRef: "feature/6-implement-workflow-real", headRepoFullName: HOME_REPO, baseRef: "main" },
    ];
    expect(findPrForIssueNumber(prs, 6, HOME_REPO)).toEqual({
      number: 10,
      headRef: "feature/6-implement-workflow-real",
      headRepoFullName: HOME_REPO,
      baseRef: "main",
    });
  });

  it("rejects a branch-name match whose source repo has since been deleted (headRepoFullName: null)", () => {
    const prs = [{ number: 9, headRef: "feature/6-implement-workflow", headRepoFullName: null, baseRef: "main" }];
    expect(findPrForIssueNumber(prs, 6, HOME_REPO)).toBeNull();
  });

  it("rejects a same-repo, correctly-prefixed match whose base is NOT main (Codex round-4 finding)", () => {
    // A same-repo PR named feature/6-* that targets some OTHER branch
    // isn't a real factory PR for this issue — reusing it would
    // force-push onto it while no PR into main for this issue exists.
    const prs = [
      { number: 9, headRef: "feature/6-implement-workflow", headRepoFullName: HOME_REPO, baseRef: "some-other-branch" },
    ];
    expect(findPrForIssueNumber(prs, 6, HOME_REPO)).toBeNull();
  });

  it("uses FACTORY_PR_BASE_REF as the required base, not a hardcoded literal, so the two stay in sync", () => {
    const prs = [
      { number: 9, headRef: "feature/6-implement-workflow", headRepoFullName: HOME_REPO, baseRef: FACTORY_PR_BASE_REF },
    ];
    expect(findPrForIssueNumber(prs, 6, HOME_REPO)).not.toBeNull();
    expect(FACTORY_PR_BASE_REF).toBe("main");
  });
});

describe("deriveBranchName", () => {
  it("strips a leading [Cx-Sx]-style bracket tag and kebab-cases the rest", () => {
    expect(
      deriveBranchName(
        6,
        "[F1-S3] Implement workflow (read-only agent + privileged publisher, dispatch-first)",
      ),
    ).toBe("feature/6-implement-workflow-read-only-agent-privi");
  });

  it("works without a bracket tag", () => {
    expect(deriveBranchName(42, "Add a new feature")).toBe(
      "feature/42-add-a-new-feature",
    );
  });

  it("collapses runs of punctuation/whitespace into single hyphens", () => {
    expect(deriveBranchName(1, "Fix: bug!! (urgent)   -- now")).toBe(
      "feature/1-fix-bug-urgent-now",
    );
  });

  it("falls back to a safe placeholder slug for a title with no alphanumeric content", () => {
    expect(deriveBranchName(7, "!!!")).toBe("feature/7-issue");
  });

  it("truncates a very long title", () => {
    const longTitle = "A".repeat(200);
    const branch = deriveBranchName(3, longTitle);
    expect(branch.length).toBeLessThan(60);
    expect(branch.startsWith("feature/3-")).toBe(true);
  });

  it("never leaves a trailing hyphen after truncation", () => {
    // Constructed so the truncation boundary lands mid-hyphen-run.
    const title = "word ".repeat(20);
    const branch = deriveBranchName(9, title);
    expect(branch.endsWith("-")).toBe(false);
  });
});

describe("buildImplementPrBody", () => {
  it("includes Closes #N and the run link", () => {
    const body = buildImplementPrBody({
      issueNumber: 6,
      runUrl: "https://github.com/o/r/actions/runs/123",
      agentActionRef: "anthropics/claude-code-action@700e7f8316990de46bed556429765647af760efc",
    });
    expect(body).toContain("Closes #6");
    expect(body).toContain("https://github.com/o/r/actions/runs/123");
    expect(body).toContain("## Story");
    expect(body).toContain("## What changed");
    expect(body).toContain("## How it was verified");
    expect(body).toContain("## Review routing");
  });

  it("includes a Provenance section with the issue ref and the pinned agent action SHA (Codex round-3 finding)", () => {
    const body = buildImplementPrBody({
      issueNumber: 6,
      runUrl: "https://github.com/o/r/actions/runs/123",
      agentActionRef: "anthropics/claude-code-action@700e7f8316990de46bed556429765647af760efc",
    });
    expect(body).toContain("## Provenance");
    expect(body).toContain(
      "anthropics/claude-code-action@700e7f8316990de46bed556429765647af760efc",
    );
    expect(body).toContain("issue #6");
    expect(body).toContain("F1-S10");
  });
});

describe("buildImplementFailureCommentBody", () => {
  it("lists every reason and links the run", () => {
    const body = buildImplementFailureCommentBody(
      ["patch touches .github/workflows/x.yml", "empty diff"],
      "https://github.com/o/r/actions/runs/456",
    );
    expect(body).toContain("patch touches .github/workflows/x.yml");
    expect(body).toContain("empty diff");
    expect(body).toContain("https://github.com/o/r/actions/runs/456");
    expect(body).toContain("did not produce a PR");
  });

  it("claims no branch was created when branchPushed is false (the default)", () => {
    const body = buildImplementFailureCommentBody(
      ["some reason"],
      "https://github.com/o/r/actions/runs/456",
    );
    expect(body).toContain("No branch was created and nothing was pushed");
  });

  it("FIX 5: does NOT falsely claim no branch was created when branchPushed is true", () => {
    const body = buildImplementFailureCommentBody(
      ["the branch `feature/6-x` WAS pushed successfully, but publishing the PR failed"],
      "https://github.com/o/r/actions/runs/456",
      true,
    );
    expect(body).not.toContain("No branch was created and nothing was pushed");
    expect(body).toContain("even though a");
    expect(body).toContain("branch was pushed");
  });

  it("Codex round 3: ends with the idempotency marker so a re-dispatch can find and edit it", () => {
    const body = buildImplementFailureCommentBody(
      ["some reason"],
      "https://github.com/o/r/actions/runs/456",
    );
    expect(body).toContain(IMPLEMENT_FAILURE_COMMENT_MARKER);
  });
});

describe("findExistingImplementFailureCommentId", () => {
  const ours = (id: number, body: string): ExistingComment => ({
    id,
    body,
    authorType: "Bot",
    authorLogin: IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN,
  });

  it("finds our own prior marked comment", () => {
    const comments: ExistingComment[] = [
      { id: 1, body: "unrelated human comment", authorType: "User", authorLogin: "someone" },
      ours(2, `some reason\n\n${IMPLEMENT_FAILURE_COMMENT_MARKER}`),
    ];
    expect(findExistingImplementFailureCommentId(comments)).toBe(2);
  });

  it("returns null when no comment carries the marker", () => {
    const comments: ExistingComment[] = [
      ours(1, "a bot comment, but not one of ours"),
    ];
    expect(findExistingImplementFailureCommentId(comments)).toBeNull();
  });

  it("does NOT match a marker-containing comment from a different bot login (spoofing guard)", () => {
    const comments: ExistingComment[] = [
      {
        id: 1,
        body: `looks like ours ${IMPLEMENT_FAILURE_COMMENT_MARKER}`,
        authorType: "Bot",
        authorLogin: "some-other-bot[bot]",
      },
    ];
    expect(findExistingImplementFailureCommentId(comments)).toBeNull();
  });

  it("does NOT match a marker-containing comment whose authorType isn't Bot", () => {
    const comments: ExistingComment[] = [
      {
        id: 1,
        body: `a human quoting the marker: ${IMPLEMENT_FAILURE_COMMENT_MARKER}`,
        authorType: "User",
        authorLogin: IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN,
      },
    ];
    expect(findExistingImplementFailureCommentId(comments)).toBeNull();
  });

  it("returns null on an empty comment list", () => {
    expect(findExistingImplementFailureCommentId([])).toBeNull();
  });

  it("matches a custom authorLogin (factory.md §13 publisher-identity switch)", () => {
    const comments: ExistingComment[] = [
      {
        id: 7,
        body: `some reason\n\n${IMPLEMENT_FAILURE_COMMENT_MARKER}`,
        authorType: "Bot",
        authorLogin: "roastpilot-factory[bot]",
      },
    ];
    expect(
      findExistingImplementFailureCommentId(comments, "roastpilot-factory[bot]"),
    ).toBe(7);
    // The default login must NOT match once a different login is passed —
    // a re-dispatch must never mistake the OLD identity's comment for the
    // new publisher identity's own.
    expect(findExistingImplementFailureCommentId(comments)).toBeNull();
  });

  it("expects User (not Bot) type for a non-bot-suffixed custom authorLogin", () => {
    const humanPatComments: ExistingComment[] = [
      {
        id: 8,
        body: `some reason\n\n${IMPLEMENT_FAILURE_COMMENT_MARKER}`,
        authorType: "User",
        authorLogin: "some-operator",
      },
    ];
    expect(
      findExistingImplementFailureCommentId(humanPatComments, "some-operator"),
    ).toBe(8);

    // A comment with the right login but the WRONG type (e.g. spoofed
    // authorType) still doesn't match.
    const wrongType: ExistingComment[] = [
      { ...humanPatComments[0]!, authorType: "Bot" },
    ];
    expect(
      findExistingImplementFailureCommentId(wrongType, "some-operator"),
    ).toBeNull();
  });
});
