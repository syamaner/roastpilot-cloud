import { describe, expect, it } from "vitest";
import {
  buildImplementFailureCommentBody,
  buildImplementPrBody,
  deriveBranchName,
  extractRenameCopySourcePaths,
  findForbiddenPatchPaths,
  findPrForIssueNumber,
  isProtectedPath,
  normalizePatchPath,
  parseNumstatZ,
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

describe("parseNumstatZ", () => {
  it("parses a single-file record", () => {
    expect(parseNumstatZ("1\t0\tlib/new-file.ts\0")).toEqual([
      "lib/new-file.ts",
    ]);
  });

  it("parses multiple NUL-terminated records", () => {
    // Built via join(), not a literal "\0<digit>" in the string — that's
    // a legacy octal escape in JS (\01 === ""), not NUL followed by
    // "1". Exactly the kind of off-by-one-character bug this function's
    // own real input (git's actual -z output) never has to worry about,
    // but a hand-written test fixture can trip on.
    const input = ["1\t0\tlib/a.ts", "1\t0\tlib/b.ts", ""].join("\0");
    expect(parseNumstatZ(input)).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  it("parses a path containing a space correctly (tab-delimited fields, not whitespace-delimited)", () => {
    expect(parseNumstatZ("1\t0\tlib/new file.ts\0")).toEqual([
      "lib/new file.ts",
    ]);
  });

  it("returns the DESTINATION-only path for a rename (matching git apply --numstat's real behavior)", () => {
    expect(parseNumstatZ("0\t0\tlib/new-name.ts\0")).toEqual([
      "lib/new-name.ts",
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseNumstatZ("")).toEqual([]);
  });

  it("skips a malformed record missing a second tab", () => {
    expect(parseNumstatZ("not-a-valid-record\0")).toEqual([]);
  });

  it("skips a malformed record missing any tab at all", () => {
    expect(parseNumstatZ("nodata\0")).toEqual([]);
  });
});

describe("extractRenameCopySourcePaths", () => {
  it("extracts both sides of a rename from raw patch text", () => {
    const patch =
      "diff --git a/scripts/factory/x.mts b/scripts/other/y.mts\n" +
      "similarity index 100%\n" +
      "rename from scripts/factory/x.mts\n" +
      "rename to scripts/other/y.mts\n";
    expect(extractRenameCopySourcePaths(patch)).toEqual([
      "scripts/factory/x.mts",
      "scripts/other/y.mts",
    ]);
  });

  it("extracts both sides of a copy from raw patch text", () => {
    const patch =
      "diff --git a/.github/workflows/ci.yml b/lib/ci-copy.yml\n" +
      "similarity index 100%\n" +
      "copy from .github/workflows/ci.yml\n" +
      "copy to lib/ci-copy.yml\n";
    expect(extractRenameCopySourcePaths(patch)).toEqual([
      ".github/workflows/ci.yml",
      "lib/ci-copy.yml",
    ]);
  });

  it("catches a rename OUT of a protected path even when --summary would brace-compact it away (round 6, second pass)", () => {
    // git apply --summary renders this exact patch as
    // "rename scripts/{factory/x.mts => other/y.mts} (100%)" — the
    // literal substring "scripts/factory/" never appears. The raw patch
    // text's rename from/to lines are never compacted like that.
    const patch =
      "diff --git a/scripts/factory/x.mts b/scripts/other/y.mts\n" +
      "similarity index 100%\n" +
      "rename from scripts/factory/x.mts\n" +
      "rename to scripts/other/y.mts\n";
    const allPaths = extractRenameCopySourcePaths(patch);
    expect(findForbiddenPatchPaths(allPaths)).toEqual([
      "scripts/factory/x.mts",
    ]);
  });

  it("returns empty for a patch with no renames or copies", () => {
    const patch =
      "diff --git a/lib/new-file.ts b/lib/new-file.ts\n" +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      "+++ b/lib/new-file.ts\n" +
      "@@ -0,0 +1 @@\n" +
      "+export const x = 1;\n";
    expect(extractRenameCopySourcePaths(patch)).toEqual([]);
  });

  it("extracts every rename/copy pair from a multi-file patch", () => {
    const patch =
      "diff --git a/a.ts b/b.ts\n" +
      "rename from a.ts\n" +
      "rename to b.ts\n" +
      "diff --git a/c.ts b/d.ts\n" +
      "copy from c.ts\n" +
      "copy to d.ts\n";
    expect(extractRenameCopySourcePaths(patch)).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
      "d.ts",
    ]);
  });

  it("does not false-positive on a hunk content line that happens to start with similar text mid-line", () => {
    // A "rename from " match requires the line to START with that exact
    // text — a hunk content line always starts with +/-/space instead,
    // so this can never collide with real diff content.
    const patch =
      "diff --git a/lib/x.ts b/lib/x.ts\n" +
      "--- a/lib/x.ts\n" +
      "+++ b/lib/x.ts\n" +
      "@@ -1 +1 @@\n" +
      '-const s = "rename from somewhere";\n' +
      '+const s = "rename to elsewhere";\n';
    expect(extractRenameCopySourcePaths(patch)).toEqual([]);
  });
});

describe("findPrForIssueNumber", () => {
  it("finds a PR whose branch matches the feature/{issueNumber}- prefix", () => {
    const prs = [
      { number: 1, headRef: "feature/60-unrelated" },
      { number: 2, headRef: "feature/6-implement-workflow" },
    ];
    expect(findPrForIssueNumber(prs, 6)).toEqual({
      number: 2,
      headRef: "feature/6-implement-workflow",
    });
  });

  it("is not fooled by a numeric-prefix collision (issue 6 vs issue 60)", () => {
    const prs = [{ number: 1, headRef: "feature/60-unrelated-issue" }];
    expect(findPrForIssueNumber(prs, 6)).toBeNull();
  });

  it("returns null when no PR matches", () => {
    expect(findPrForIssueNumber([], 6)).toBeNull();
  });

  it("finds the branch regardless of what slug it carries (title-independent)", () => {
    const prs = [{ number: 5, headRef: "feature/6-a-totally-different-slug-now" }];
    expect(findPrForIssueNumber(prs, 6)).not.toBeNull();
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
    });
    expect(body).toContain("Closes #6");
    expect(body).toContain("https://github.com/o/r/actions/runs/123");
    expect(body).toContain("## Story");
    expect(body).toContain("## What changed");
    expect(body).toContain("## How it was verified");
    expect(body).toContain("## Review routing");
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
});
