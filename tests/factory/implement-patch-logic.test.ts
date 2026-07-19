import { describe, expect, it } from "vitest";
import {
  assertLabelDescriptionWithinLimit,
  buildCommitTrailer,
  buildGamingFlagAnnotation,
  buildImplementFailureCommentBody,
  buildImplementPrBody,
  buildPublishRejectedStepSummary,
  buildPublishSuccessStepSummary,
  deriveBranchName,
  extractModelIdFromTranscript,
  FACTORY_PR_BASE_REF,
  findAddedCoverageSuppressions,
  findAddedPackageJsonTestScriptEdits,
  findExistingImplementFailureCommentId,
  findForbiddenPatchPaths,
  findPrForIssueNumber,
  findTestFileEdits,
  GITHUB_LABEL_DESCRIPTION_MAX_LENGTH,
  IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN,
  IMPLEMENT_FAILURE_COMMENT_MARKER,
  isLabelAlreadyExistsError,
  isLabelNotFoundOnIssueError,
  isProtectedPath,
  isTestFilePath,
  NO_AUTO_CHAIN_LABEL,
  NO_AUTO_CHAIN_LABEL_DESCRIPTION,
  NO_REVIEW_AUTOMATION_LABEL,
  NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION,
  normalizePatchPath,
  parseNameStatusZ,
  sanitizeStepSummaryText,
  sanitizeStepSummaryUrl,
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

describe("isTestFilePath / findTestFileEdits (F1-S9 slice 1, issue #12)", () => {
  it("flags a vitest test file under tests/", () => {
    expect(isTestFilePath("tests/slug.test.ts")).toBe(true);
    expect(isTestFilePath("tests/factory/publish-implement-patch.test.ts")).toBe(true);
  });

  it("flags a playwright spec under e2e/", () => {
    expect(isTestFilePath("e2e/boot.spec.ts")).toBe(true);
  });

  it("flags a pytest file under snowflake/tests/", () => {
    expect(isTestFilePath("snowflake/tests/test_assert_dev_ci_grants.py")).toBe(true);
  });

  it("flags a *.test.tsx / *.spec.tsx file by filename suffix even outside the known directories", () => {
    expect(isTestFilePath("lib/component.test.tsx")).toBe(true);
    expect(isTestFilePath("lib/component.spec.tsx")).toBe(true);
  });

  it("flags a test_*.py / *_test.py file by filename convention even outside snowflake/tests/", () => {
    expect(isTestFilePath("scripts/test_helper.py")).toBe(true);
    expect(isTestFilePath("scripts/helper_test.py")).toBe(true);
  });

  it("does NOT flag an ordinary application file", () => {
    expect(isTestFilePath("lib/slug.ts")).toBe(false);
    expect(isTestFilePath("scripts/factory/implement-patch-logic.mts")).toBe(false);
    expect(isTestFilePath("snowflake/assert_dev_ci_grants.py")).toBe(false);
  });

  it("flags an edit to vitest's own test-discovery config (Codex + claude-review finding, F1-S9 slice 1, issue #12, ready round)", () => {
    // Narrowing vitest.config.ts's `include` glob can make a failing test
    // silently stop being discovered/run without touching a single test
    // file — the same gaming class as editing a test file directly.
    expect(isTestFilePath("vitest.config.ts")).toBe(true);
    expect(isTestFilePath("vitest.config.mts")).toBe(true);
    expect(isTestFilePath("vitest.config.js")).toBe(true);
    expect(isTestFilePath("vitest.config.mjs")).toBe(true);
    expect(isTestFilePath("vitest.config.cjs")).toBe(true);
  });

  it("flags an edit to playwright's own test-discovery config", () => {
    expect(isTestFilePath("playwright.config.ts")).toBe(true);
    expect(isTestFilePath("playwright.config.js")).toBe(true);
  });

  it("flags an edit to pytest's own discovery config under snowflake/, where this repo's pytest is actually invoked from", () => {
    expect(isTestFilePath("snowflake/pytest.ini")).toBe(true);
    expect(isTestFilePath("snowflake/pytest.toml")).toBe(true);
    expect(isTestFilePath("snowflake/pyproject.toml")).toBe(true);
    expect(isTestFilePath("snowflake/setup.cfg")).toBe(true);
    expect(isTestFilePath("snowflake/tox.ini")).toBe(true);
  });

  it("flags snowflake/pytest.toml specifically (Codex finding, F1-S9 slice 1, issue #12, ready round 2 — the pinned pytest 9.x reads pytest.toml as implicit config, same as pyproject.toml)", () => {
    expect(isTestFilePath("snowflake/pytest.toml")).toBe(true);
    // Not the root-level file — same "not what this repo's pytest would
    // ever read" reasoning as the other pytest config exact-matches.
    expect(isTestFilePath("pytest.toml")).toBe(false);
  });

  it("flags snowflake/conftest.py (Codex finding, F1-S9 slice 1, issue #12, ready round 3 — pytest loads conftest.py automatically and it can hook collection/reporting itself, the same class as the config files above)", () => {
    expect(isTestFilePath("snowflake/conftest.py")).toBe(true);
    // A repo-root conftest.py is DELIBERATELY not flagged: this repo's
    // pytest invocation (working-directory: snowflake, no ini file
    // anywhere) resolves rootdir to snowflake/ itself, and pytest's own
    // conftest.py collection never walks ABOVE rootdir — same "not what
    // this invocation would ever read" reasoning as the root-level
    // pyproject.toml/setup.cfg exclusion.
    expect(isTestFilePath("conftest.py")).toBe(false);
  });

  it("does NOT flag a root-level pyproject.toml/setup.cfg — not what this repo's pytest invocation would ever read", () => {
    // Deliberately narrow, per the finding: over-flagging is the safe
    // direction for a REAL discovery-config path, but a root pyproject.toml
    // in THIS repo would almost certainly be unrelated Next.js/npm
    // tooling — pytest's own config search starts from the invocation
    // directory (snowflake/, per ci.yml's working-directory), not the
    // repo root, so a root file isn't what it would ever read here.
    expect(isTestFilePath("pyproject.toml")).toBe(false);
    expect(isTestFilePath("setup.cfg")).toBe(false);
  });

  it("findTestFileEdits normalizes, de-duplicates, and sorts the result", () => {
    const edits = findTestFileEdits([
      "a/tests/slug.test.ts",
      "b/tests/slug.test.ts",
      "a/lib/slug.ts",
      "b/lib/slug.ts",
      "b/e2e/boot.spec.ts",
    ]);
    expect(edits).toEqual(["e2e/boot.spec.ts", "tests/slug.test.ts"]);
  });

  it("findTestFileEdits returns empty for a clean patch", () => {
    expect(findTestFileEdits(["a/lib/slug.ts", "b/lib/slug.ts"])).toEqual([]);
  });

  it("findTestFileEdits still flags a test file that was only RENAMED (both sides reported, same shape findForbiddenPatchPaths relies on)", () => {
    // getAuthoritativeChangedPaths reports both the old and new path of a
    // rename/copy — a test file renamed OUT of tests/ (old path) still
    // shows up here via its old path, and a rename INTO tests/ (new path)
    // via its new path; either way this must not miss it.
    expect(findTestFileEdits(["lib/old-name.ts", "tests/new-name.test.ts"])).toEqual([
      "tests/new-name.test.ts",
    ]);
  });
});

describe("findAddedCoverageSuppressions (F1-S9 slice 1, issue #12)", () => {
  it("flags an ADDED Python pragma", () => {
    const patch = [
      "diff --git a/snowflake/foo.py b/snowflake/foo.py",
      "index abc..def 100644",
      "--- a/snowflake/foo.py",
      "+++ b/snowflake/foo.py",
      "@@ -1,1 +1,2 @@",
      " existing_line = 1",
      "+new_line = 2  # pragma: no cover",
    ].join("\n");
    const matches = findAddedCoverageSuppressions(patch);
    expect(matches).toEqual([
      { path: "snowflake/foo.py", line: "new_line = 2  # pragma: no cover" },
    ]);
  });

  it("flags an ADDED v8-ignore comment (this repo's live vitest coverage provider)", () => {
    const patch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "index abc..def 100644",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+/* v8 ignore next */ export const y = 2;",
    ].join("\n");
    const matches = findAddedCoverageSuppressions(patch);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe("lib/foo.ts");
  });

  it("flags c8/istanbul ignore comments defensively even though unused in this repo today", () => {
    const c8Patch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+/* c8 ignore next */ export const y = 2;",
    ].join("\n");
    expect(findAddedCoverageSuppressions(c8Patch)).toHaveLength(1);

    const istanbulPatch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+/* istanbul ignore next */ export const y = 2;",
    ].join("\n");
    expect(findAddedCoverageSuppressions(istanbulPatch)).toHaveLength(1);
  });

  it("flags istanbul's LINE-comment form too, not just its block-comment form (independent factory-security-reviewer finding, F1-S9 slice 1, issue #12 — an earlier version's docstring claimed c8/istanbul coverage broadly while the regex only matched their block form)", () => {
    const patch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+// istanbul ignore next",
    ].join("\n");
    expect(findAddedCoverageSuppressions(patch)).toHaveLength(1);
  });

  it("flags v8/c8's line-comment form too, for the same categorical reason", () => {
    const v8Patch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+// v8 ignore next",
    ].join("\n");
    expect(findAddedCoverageSuppressions(v8Patch)).toHaveLength(1);

    const c8Patch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+// c8 ignore next",
    ].join("\n");
    expect(findAddedCoverageSuppressions(c8Patch)).toHaveLength(1);
  });

  it("flags Python's # pragma: no branch, not just # pragma: no cover", () => {
    const patch = [
      "diff --git a/snowflake/foo.py b/snowflake/foo.py",
      "--- a/snowflake/foo.py",
      "+++ b/snowflake/foo.py",
      "@@ -1,1 +1,2 @@",
      " existing_line = 1",
      "+if x:  # pragma: no branch",
    ].join("\n");
    expect(findAddedCoverageSuppressions(patch)).toHaveLength(1);
  });

  it("does NOT flag an EXISTING (unmodified, context-line) suppression this diff doesn't touch", () => {
    const patch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,2 +1,3 @@",
      " export const x = 1; // pragma: no cover",
      "+export const y = 2;",
      " export const z = 3;",
    ].join("\n");
    expect(findAddedCoverageSuppressions(patch)).toEqual([]);
  });

  it("does NOT flag the +++ file-header line itself as an added line", () => {
    const patch = [
      "diff --git a/lib/pragma.ts b/lib/pragma.ts",
      "new file mode 100644",
      "index 0000000..abc1234",
      "--- /dev/null",
      "+++ b/lib/pragma.ts",
      "@@ -0,0 +1,1 @@",
      "+export const x = 1;",
    ].join("\n");
    // The file itself is even named "pragma.ts" — proves the +++ header
    // line for it is never misread as added content regardless.
    expect(findAddedCoverageSuppressions(patch)).toEqual([]);
  });

  it("is NOT bypassed by an added ++-prefixed decoy line immediately before a real suppression (independent Codex + claude-review finding, F1-S9 slice 1, issue #12 — a real, trivially craftable classifier bypass)", () => {
    // An added line whose own CODE starts with `++` (e.g. `++counter;`)
    // serializes in a real diff as the raw line `+++counter;` — an
    // earlier version of this function's `+++`-header check ran
    // UNCONDITIONALLY (not gated on hunk state), so this decoy line was
    // misread as a fake file header, resetting inHunk to false and
    // silently skipping every added line that followed for the rest of
    // this file's hunk — including the REAL suppression comment right
    // after it. This is the exact PoC: without the fix, the pragma below
    // would never be detected at all.
    const pragmaPatch = [
      "diff --git a/snowflake/foo.py b/snowflake/foo.py",
      "--- a/snowflake/foo.py",
      "+++ b/snowflake/foo.py",
      "@@ -1,1 +1,3 @@",
      " x = 1",
      "+++counter",
      "+y = 2  # pragma: no cover",
    ].join("\n");
    const pragmaMatches = findAddedCoverageSuppressions(pragmaPatch);
    expect(pragmaMatches).toHaveLength(1);
    expect(pragmaMatches[0]?.line).toContain("pragma: no cover");

    const v8Patch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,1 +1,3 @@",
      " export const x = 1;",
      "+++counter;",
      "+/* v8 ignore next */ export const y = 2;",
    ].join("\n");
    const v8Matches = findAddedCoverageSuppressions(v8Patch);
    expect(v8Matches).toHaveLength(1);
    expect(v8Matches[0]?.line).toContain("v8 ignore");

    // Decisive proof the decoy line itself is correctly treated as
    // ordinary added CODE, not a header: it must not have reset
    // currentPath to something else, and it must not itself be reported
    // as a match (it carries no suppression pattern).
    expect(pragmaMatches[0]?.path).toBe("snowflake/foo.py");
  });

  it("does NOT flag a removed (-) line carrying a suppression", () => {
    const patch = [
      "diff --git a/lib/foo.ts b/lib/foo.ts",
      "--- a/lib/foo.ts",
      "+++ b/lib/foo.ts",
      "@@ -1,2 +1,1 @@",
      "-export const x = 1; // pragma: no cover",
      " export const z = 3;",
    ].join("\n");
    expect(findAddedCoverageSuppressions(patch)).toEqual([]);
  });

  it("flags multiple added suppressions across multiple files independently", () => {
    const patch = [
      "diff --git a/lib/a.ts b/lib/a.ts",
      "--- a/lib/a.ts",
      "+++ b/lib/a.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+/* v8 ignore next */ export const y = 2;",
      "diff --git a/snowflake/b.py b/snowflake/b.py",
      "--- a/snowflake/b.py",
      "+++ b/snowflake/b.py",
      "@@ -1,1 +1,2 @@",
      " x = 1",
      "+y = 2  # pragma: no cover",
    ].join("\n");
    const matches = findAddedCoverageSuppressions(patch);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.path)).toEqual(["lib/a.ts", "snowflake/b.py"]);
  });

  it("returns empty for a clean patch with no suppressions at all", () => {
    const patch = [
      "diff --git a/lib/a.ts b/lib/a.ts",
      "--- a/lib/a.ts",
      "+++ b/lib/a.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+export const y = 2;",
    ].join("\n");
    expect(findAddedCoverageSuppressions(patch)).toEqual([]);
  });
});

describe("findAddedPackageJsonTestScriptEdits (Codex finding, F1-S9 slice 1, issue #12, ready round 2)", () => {
  it("flags an added/redefined test script line in package.json", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -2,3 +2,3 @@",
      '   "scripts": {',
      '-    "test": "vitest run",',
      '+    "test": "echo ok",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual(['"test": "echo ok",']);
  });

  it("flags a test:-prefixed script variant (e.g. test:unit)", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -2,2 +2,2 @@",
      '   "scripts": {',
      '+    "test:unit": "echo ok",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual(['"test:unit": "echo ok",']);
  });

  it("flags the coverage script key", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -2,2 +2,2 @@",
      '   "scripts": {',
      '+    "coverage": "echo ok",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual(['"coverage": "echo ok",']);
  });

  it("flags an added pretest lifecycle hook (Codex finding, F1-S9 slice 1, issue #12, ready round 3 — npm auto-runs pretest before npm test, so it can neuter the suite before it even starts)", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -2,2 +2,2 @@",
      '   "scripts": {',
      '+    "pretest": "echo skip > tests/index.test.ts",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual([
      '"pretest": "echo skip > tests/index.test.ts",',
    ]);
  });

  it("flags an added posttest lifecycle hook the same way", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -2,2 +2,2 @@",
      '   "scripts": {',
      '+    "posttest": "echo done",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual(['"posttest": "echo done",']);
  });

  it("does NOT flag an unrelated pre/post-prefixed lifecycle key like prepublish — the (pre|post)? prefix is anchored to the base key, not a general substring", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -2,2 +2,2 @@",
      '   "scripts": {',
      '+    "prepublish": "npm run build",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual([]);
  });

  it("flags a JSON-unicode-escaped 'test' script key (Codex finding, F1-S9 slice 1, issue #12, ready round 3 — decodes to the literal key 'test' but evades the literal-text pattern entirely)", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -2,2 +2,2 @@",
      '   "scripts": {',
      '+    "\\u0074\\u0065\\u0073\\u0074": "echo ok",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual([
      '"\\u0074\\u0065\\u0073\\u0074": "echo ok",',
    ]);
  });

  it("does NOT flag an ordinary dependency line just because it happens to contain a backslash — only a real \\u escape sequence trips the unicode-escape pattern", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -5,2 +5,3 @@",
      '   "dependencies": {',
      '+    "left-pad": "file:../vendor\\\\left-pad",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual([]);
  });

  it("does NOT flag a dependency-only package.json edit (the targeted-fix requirement — a blanket 'any package.json edit' flag would over-trigger on routine dependency bumps)", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -5,3 +5,3 @@",
      '   "dependencies": {',
      '-    "left-pad": "1.0.0",',
      '+    "left-pad": "1.0.1",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual([]);
  });

  it("does NOT flag a dependency whose NAME merely contains 'test' (e.g. jest-test-utils) — the script-KEY shape, not a substring match", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -5,2 +5,3 @@",
      '   "devDependencies": {',
      '+    "jest-test-utils": "^1.0.0",',
      "   },",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual([]);
  });

  it("does NOT flag a test-script-shaped line in a file OTHER than package.json", () => {
    const patch = [
      "diff --git a/lib/config.json b/lib/config.json",
      "--- a/lib/config.json",
      "+++ b/lib/config.json",
      "@@ -1,1 +1,2 @@",
      "   {",
      '+    "test": "echo ok",',
      "   }",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual([]);
  });

  it("returns empty for a clean patch that never touches package.json", () => {
    const patch = [
      "diff --git a/lib/a.ts b/lib/a.ts",
      "--- a/lib/a.ts",
      "+++ b/lib/a.ts",
      "@@ -1,1 +1,2 @@",
      " export const x = 1;",
      "+export const y = 2;",
    ].join("\n");
    expect(findAddedPackageJsonTestScriptEdits(patch)).toEqual([]);
  });
});

describe("buildGamingFlagAnnotation (F1-S9 slice 1, issue #12)", () => {
  it("names the exact test file(s) edited", () => {
    const body = buildGamingFlagAnnotation(
      { testFileEdits: ["tests/slug.test.ts"], suppressions: [], packageJsonTestScriptEdits: [] },
      true,
    );
    expect(body).toContain(NO_AUTO_CHAIN_LABEL);
    expect(body).toContain("tests/slug.test.ts");
  });

  it("names the exact suppression line(s) added, with their file", () => {
    const body = buildGamingFlagAnnotation(
      {
        testFileEdits: [],
        suppressions: [{ path: "lib/foo.ts", line: "/* v8 ignore next */" }],
        packageJsonTestScriptEdits: [],
      },
      true,
    );
    expect(body).toContain("lib/foo.ts");
    expect(body).toContain("/* v8 ignore next */");
  });

  it("includes both sections when both are present", () => {
    const body = buildGamingFlagAnnotation(
      {
        testFileEdits: ["tests/slug.test.ts"],
        suppressions: [{ path: "lib/foo.ts", line: "# pragma: no cover" }],
        packageJsonTestScriptEdits: [],
      },
      true,
    );
    expect(body).toContain("tests/slug.test.ts");
    expect(body).toContain("lib/foo.ts");
  });

  it("names the exact package.json test-script redefinition(s) added (F1-S9 slice 1, issue #12, ready round 2)", () => {
    const body = buildGamingFlagAnnotation(
      {
        testFileEdits: [],
        suppressions: [],
        packageJsonTestScriptEdits: ['"test": "echo ok",'],
      },
      true,
    );
    expect(body).toContain("package.json");
    expect(body).toContain('"test": "echo ok",');
  });

  it("says the label was applied when labelApplied is true", () => {
    const body = buildGamingFlagAnnotation(
      { testFileEdits: ["tests/slug.test.ts"], suppressions: [], packageJsonTestScriptEdits: [] },
      true,
    );
    expect(body).toContain(`labelled \`${NO_AUTO_CHAIN_LABEL}\`.`);
    expect(body).not.toContain("FAILED to apply");
  });

  it("says the label FAILED to apply — never claims it landed — when labelApplied is false (independent Codex + claude-review finding, F1-S9 slice 1, issue #12, round 3)", () => {
    const body = buildGamingFlagAnnotation(
      { testFileEdits: ["tests/slug.test.ts"], suppressions: [], packageJsonTestScriptEdits: [] },
      false,
    );
    expect(body).toContain(`the \`${NO_AUTO_CHAIN_LABEL}\` label FAILED to apply`);
    expect(body).toContain("flagged for manual review anyway");
    expect(body).not.toContain(`labelled \`${NO_AUTO_CHAIN_LABEL}\`.`);
  });

  it("neutralizes a backtick+Markdown-injection payload in an added line's own content (independent factory-security-reviewer finding, F1-S9 slice 1, issue #12)", () => {
    // The exact PoC: an added line whose content carries a literal
    // backtick that would otherwise break out of the single code span
    // this annotation wraps it in, injecting live Markdown (a link + a
    // mention) into the factory bot's own comment — capable of
    // spoofing/burying the very human-review signal this annotation
    // exists to provide. sanitizeStepSummaryText STRIPS backticks (it
    // doesn't escape them), so the link/mention TEXT still appears —
    // the security property is that it stays trapped inside ONE
    // unbroken code span, never rendered as live Markdown.
    const payload =
      "x = 1  # pragma: no cover `[click](https://attacker.example) @some-maintainer";
    const body = buildGamingFlagAnnotation(
      { testFileEdits: [], suppressions: [{ path: "lib/foo.ts", line: payload }], packageJsonTestScriptEdits: [] },
      true,
    );
    // The exact, deterministic expected rendering: the payload's own
    // backtick is gone, so `path` and `line` are each their OWN single,
    // unbroken code span — the payload's backtick never gets to close
    // the `line` span early and re-open Markdown parsing mid-string.
    expect(body).toContain(
      "- `lib/foo.ts`: `x = 1  # pragma: no cover [click](https://attacker.example) @some-maintainer`",
    );
    // Decisive proof the span isn't broken: this flagged line has
    // EXACTLY 4 backtick characters (2 wrapping `path`, 2 wrapping
    // `line`) — any more would mean the payload's own backtick survived
    // sanitization and split one of those spans into pieces.
    const flaggedLine = body.split("\n").find((l) => l.includes("lib/foo.ts"));
    expect(flaggedLine).toBeDefined();
    expect((flaggedLine?.match(/`/g) ?? []).length).toBe(4);
  });

  it("neutralizes a backtick+Markdown-injection payload in a test-file path too (the same injection class, not just the suppression line)", () => {
    const payload = "tests/`[click](https://attacker.example)`.test.ts";
    const body = buildGamingFlagAnnotation(
      { testFileEdits: [payload], suppressions: [], packageJsonTestScriptEdits: [] },
      true,
    );
    const flaggedLine = body.split("\n").find((l) => l.includes("attacker.example"));
    expect(flaggedLine).toBeDefined();
    // A single field on this line (just `path`, no `line` counterpart) —
    // exactly 2 backticks (one unbroken code span), not more.
    expect((flaggedLine?.match(/`/g) ?? []).length).toBe(2);
  });
});

describe("NO_AUTO_CHAIN_LABEL_DESCRIPTION", () => {
  it("stays within GitHub's label-description character limit", () => {
    expect(NO_AUTO_CHAIN_LABEL_DESCRIPTION.length).toBeLessThanOrEqual(
      GITHUB_LABEL_DESCRIPTION_MAX_LENGTH,
    );
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
  const baseContext = {
    issueNumber: 6,
    runUrl: "https://github.com/o/r/actions/runs/123",
    agentActionRef: "anthropics/claude-code-action@700e7f8316990de46bed556429765647af760efc",
    modelId: "claude-opus-4-1-20250805",
    promptVersion: "1b781ecabc1234567890abcdef1234567890abcd",
    dispatchActor: "syamaner",
  };

  it("includes Closes #N and the run link", () => {
    const body = buildImplementPrBody({
      ...baseContext,
      publishedViaFallback: false,
    });
    expect(body).toContain("Closes #6");
    expect(body).toContain("https://github.com/o/r/actions/runs/123");
    expect(body).toContain("## Story");
    expect(body).toContain("## What changed");
    expect(body).toContain("## How it was verified");
    expect(body).toContain("## Review routing");
  });

  it("includes the FULL provenance trailer — model, prompt/skill version, pinned agent action SHA, issue ref, and the dispatching human (F1-S10 slice 3, factory.md §13.12)", () => {
    const body = buildImplementPrBody({
      ...baseContext,
      publishedViaFallback: false,
    });
    expect(body).toContain("## Provenance");
    expect(body).toContain("claude-opus-4-1-20250805");
    expect(body).toContain(
      "anthropics/claude-code-action@700e7f8316990de46bed556429765647af760efc",
    );
    expect(body).toContain("1b781ecabc1234567890abcdef1234567890abcd");
    expect(body).toContain("#6");
    expect(body).toContain("@syamaner");
    expect(body).toContain("Co-Authored-By");
    expect(body).toContain("Signed-off-by");
    expect(body).toContain("Provenance-*");
  });

  it("renders the model as 'unavailable' (never fabricated) when modelId is null", () => {
    const body = buildImplementPrBody({
      ...baseContext,
      modelId: null,
      publishedViaFallback: false,
    });
    expect(body).toContain("unavailable");
    expect(body).not.toContain("claude-opus-4-1-20250805");
  });

  it("omits the fallback warning when publishedViaFallback is false", () => {
    const body = buildImplementPrBody({
      ...baseContext,
      publishedViaFallback: false,
    });
    expect(body).not.toContain("GITHUB_TOKEN fallback");
    expect(body).not.toContain("no-review-automation");
  });

  it("prepends a bold fallback warning when publishedViaFallback is true (adjudicated F2, #40 rework)", () => {
    const body = buildImplementPrBody({
      ...baseContext,
      publishedViaFallback: true,
    });
    expect(body).toContain("⚠️");
    expect(body).toContain("GITHUB_TOKEN fallback");
    expect(body).toContain("Do not merge without a manual review pass");
    expect(body).toContain(NO_REVIEW_AUTOMATION_LABEL);
    // The warning must lead the body, not be buried below the fold —
    // asserted structurally (its position precedes "## Story"), not just
    // "somewhere in the string".
    expect(body.indexOf("⚠️")).toBeLessThan(body.indexOf("## Story"));
    expect(body.indexOf("## Story")).toBeGreaterThan(-1);
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

describe("NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION", () => {
  it("stays within GitHub's label-description limit (regression guard, Codex round-3 P2)", () => {
    // An earlier draft was 119 chars, over GitHub's 100-char cap, which
    // made the label-create call 422 and get misread as "already
    // exists" by the (since-fixed) old catch — this guard fails loudly
    // if a future edit reintroduces that.
    expect(NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION.length).toBeLessThanOrEqual(
      GITHUB_LABEL_DESCRIPTION_MAX_LENGTH,
    );
  });
});

describe("assertLabelDescriptionWithinLimit", () => {
  it("does not throw when the description is within the limit", () => {
    expect(() => assertLabelDescriptionWithinLimit("short description", 100)).not.toThrow();
  });

  it("does not throw when the description is exactly at the limit", () => {
    expect(() => assertLabelDescriptionWithinLimit("x".repeat(100), 100)).not.toThrow();
  });

  it("throws a clear error when the description exceeds the limit", () => {
    expect(() => assertLabelDescriptionWithinLimit("x".repeat(101), 100)).toThrow(
      /label description is 101 chars, exceeds GitHub's 100-char limit/,
    );
  });

  it("defaults maxLength to GITHUB_LABEL_DESCRIPTION_MAX_LENGTH when unspecified", () => {
    expect(() =>
      assertLabelDescriptionWithinLimit("x".repeat(GITHUB_LABEL_DESCRIPTION_MAX_LENGTH + 1)),
    ).toThrow();
    expect(() =>
      assertLabelDescriptionWithinLimit("x".repeat(GITHUB_LABEL_DESCRIPTION_MAX_LENGTH)),
    ).not.toThrow();
  });
});

describe("isLabelAlreadyExistsError", () => {
  function githubApiError(status: number, body: unknown): Error {
    return new Error(
      `GitHub API POST /repos/o/r/labels failed: ${status} ${JSON.stringify(body)}`,
    );
  }

  it("returns true for GitHub's genuine 'already exists' 422", () => {
    const err = githubApiError(422, {
      message: "Validation Failed",
      errors: [{ resource: "Label", code: "already_exists", field: "name" }],
    });
    expect(isLabelAlreadyExistsError(err)).toBe(true);
  });

  it("returns false for a DIFFERENT 422 validation error (e.g. an over-length description) — the Codex round-3 P2 fix", () => {
    const err = githubApiError(422, {
      message: "Validation Failed",
      errors: [
        { resource: "Label", code: "invalid", field: "description" },
      ],
    });
    expect(isLabelAlreadyExistsError(err)).toBe(false);
  });

  it("returns false for a non-422 status even with an already_exists-shaped body", () => {
    const err = githubApiError(500, {
      message: "Validation Failed",
      errors: [{ resource: "Label", code: "already_exists", field: "name" }],
    });
    expect(isLabelAlreadyExistsError(err)).toBe(false);
  });

  it("returns false for an unparsable response body (never assumes the benign case)", () => {
    const err = new Error("GitHub API POST /repos/o/r/labels failed: 422 not json");
    expect(isLabelAlreadyExistsError(err)).toBe(false);
  });

  it("returns false for a 422 with no errors array at all", () => {
    const err = githubApiError(422, { message: "Validation Failed" });
    expect(isLabelAlreadyExistsError(err)).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isLabelAlreadyExistsError("not an error")).toBe(false);
    expect(isLabelAlreadyExistsError(undefined)).toBe(false);
  });
});

describe("isLabelNotFoundOnIssueError (F1-S9 slice 1, issue #12, ready round)", () => {
  function githubDeleteError(status: number, body: unknown): Error {
    return new Error(
      `GitHub API DELETE /repos/o/r/issues/50/labels/no-auto-chain failed: ${status} ${JSON.stringify(body)}`,
    );
  }

  it("returns true for a 404 (label not currently applied — the benign no-op case)", () => {
    const err = githubDeleteError(404, { message: "Label does not exist" });
    expect(isLabelNotFoundOnIssueError(err)).toBe(true);
  });

  it("returns false for a non-404 status — a real failure must not be misread as the benign case", () => {
    const err = githubDeleteError(500, { message: "Internal Server Error" });
    expect(isLabelNotFoundOnIssueError(err)).toBe(false);
  });

  it("returns false for a non-Error value", () => {
    expect(isLabelNotFoundOnIssueError("not an error")).toBe(false);
    expect(isLabelNotFoundOnIssueError(undefined)).toBe(false);
  });
});

describe("buildPublishSuccessStepSummary", () => {
  it("shows a minted identity and normal review-automation triggering when not on fallback", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
    });
    expect(summary).toContain("## Factory publish summary");
    expect(summary).toContain("#6");
    // publisherLogin is rendered as an inline code span by
    // sanitizeStepSummaryText (categorical fix, round 3) — verbatim
    // content, no escaping, since a code span alone neutralizes it.
    expect(summary).toContain("✅ Minted as `roastpilot-factory[bot]`");
    expect(summary).toContain("[#99](https://github.com/o/r/pull/99)");
    expect(summary).not.toContain("(refreshed");
    expect(summary).toContain("triggered normally");
    expect(summary).not.toContain("**Suppressed**");
    // Adjudicated fix (Codex P2, #46 reshape): must not imply the
    // Codex-wait rule is already satisfied just because it auto-reviewed.
    expect(summary).toContain("Codex auto-reviewed at creation");
    expect(summary).toContain("must still manually");
    expect(summary).toContain("@codex review");
    expect(summary).toContain("NOT satisfied automatically");
    // Adjudicated fix (Codex P1, post-#46-merge fix-forward): Claude Code
    // Review must NOT be reported as part of "triggered normally" — it
    // does not actually run on a factory-minted PR until #47 lands.
    expect(summary).toContain("Claude Code Review does NOT yet cover factory-authored PRs");
    expect(summary).toContain("#47");
  });

  it("shows the fallback identity, reason, suppressed review automation, and that Codex does not auto-trigger, when on fallback", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "github-actions[bot]",
      publishedViaFallback: true,
      fallbackReason: "FACTORY_PUBLISHER_APP_ID is not configured",
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
    });
    expect(summary).toContain("⚠️ Fell back to `GITHUB_TOKEN`");
    expect(summary).toContain("`github-actions[bot]`");
    expect(summary).toContain("`FACTORY_PUBLISHER_APP_ID is not configured`");
    expect(summary).toContain("⚠️ **Suppressed**");
    expect(summary).toContain("no-review-automation");
    expect(summary).toContain("Codex does NOT auto-trigger either");
  });

  it("reports the label as applied when labelApplied is true or omitted (undefined = not attempted, treated as the default success wording)", () => {
    const applied = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "github-actions[bot]",
      publishedViaFallback: true,
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
      labelApplied: true,
    });
    expect(applied).toContain("the `no-review-automation` label was applied");
    expect(applied).not.toContain("FAILED to apply");
  });

  it("reports the label as FAILED (Codex P2, #46 reshape) — never asserts it landed when applyNoReviewAutomationLabelBestEffort actually failed", () => {
    const failed = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "github-actions[bot]",
      publishedViaFallback: true,
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
      labelApplied: false,
    });
    expect(failed).toContain("attempted but FAILED to apply");
    expect(failed).not.toContain("the `no-review-automation` label was applied");
  });

  it("omits the reason suffix when fallbackReason is not provided", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "github-actions[bot]",
      publishedViaFallback: true,
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
    });
    expect(summary).toContain("⚠️ Fell back to `GITHUB_TOKEN`");
    // No " — `<reason>`" suffix when the reason is absent.
    expect(summary).not.toContain(" — `");
  });

  it("marks a refreshed PR distinctly from a newly-opened one", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      prNumber: 50,
      prUrl: "https://github.com/o/r/pull/50",
      wasRefresh: true,
    });
    expect(summary).toContain("(refreshed, not newly opened)");
  });

  it("reports the anti-gaming classifier as clean when gamingFlagged is false/omitted", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
    });
    expect(summary).toContain("✅ clean");
    expect(summary).not.toContain("FLAGGED");
  });

  it("reports the anti-gaming classifier as FLAGGED with the label applied", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
      gamingFlagged: true,
      gamingLabelApplied: true,
    });
    expect(summary).toContain("🚩 **FLAGGED**");
    expect(summary).toContain("labelled `no-auto-chain`");
    expect(summary).not.toContain("FAILED to apply the `no-auto-chain`");
  });

  it("reports the anti-gaming label as FAILED to apply — never claims it landed — when the apply call actually failed", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
      gamingFlagged: true,
      gamingLabelApplied: false,
    });
    expect(summary).toContain("FAILED to apply the `no-auto-chain` label");
    expect(summary).not.toContain("labelled `no-auto-chain`");
  });

  it("says a stale label was removed on a clean refresh (Codex + claude-review finding, F1-S9 slice 1, issue #12, ready round)", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      prNumber: 50,
      prUrl: "https://github.com/o/r/pull/50",
      wasRefresh: true,
      gamingFlagged: false,
      gamingLabelRemoved: true,
    });
    expect(summary).toContain("✅ clean");
    expect(summary).toContain("was removed");
    expect(summary).not.toContain("FLAGGED");
  });

  it("says removal of a stale label FAILED — never silently drops that signal — when removal was attempted and failed", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      prNumber: 50,
      prUrl: "https://github.com/o/r/pull/50",
      wasRefresh: true,
      gamingFlagged: false,
      gamingLabelRemoved: false,
    });
    expect(summary).toContain("FAILED to remove a stale");
    expect(summary).toContain("may still read as flagged");
  });

  it("says plain clean with no removal mention when gamingLabelRemoved is undefined (nothing to remove, or never attempted)", () => {
    const summary = buildPublishSuccessStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      prNumber: 99,
      prUrl: "https://github.com/o/r/pull/99",
      wasRefresh: false,
      gamingFlagged: false,
    });
    expect(summary).toContain("✅ clean");
    expect(summary).not.toContain("was removed");
    expect(summary).not.toContain("FAILED to remove");
  });
});

describe("buildPublishRejectedStepSummary", () => {
  it("lists every rejection reason and no PR", () => {
    const summary = buildPublishRejectedStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      reasons: ["the implement run produced no changes (empty patch)"],
    });
    expect(summary).toContain("## Factory publish summary");
    expect(summary).toContain("#6");
    expect(summary).toContain("none — publish rejected");
    // Rendered as an inline code span (categorical fix, round 3) —
    // brackets/parens appear verbatim, no escaping needed.
    expect(summary).toContain("`the implement run produced no changes (empty patch)`");
  });

  it("shows the fallback identity even on a rejected publish", () => {
    const summary = buildPublishRejectedStepSummary({
      issueNumber: 6,
      publisherLogin: "github-actions[bot]",
      publishedViaFallback: true,
      fallbackReason: "the mint step failed (outcome=failure)",
      reasons: ["unexpected error: network timeout"],
    });
    expect(summary).toContain("⚠️ Fell back to `GITHUB_TOKEN`");
    expect(summary).toContain("`the mint step failed (outcome=failure)`");
  });

  it("strips a newline and a backtick from a rejection reason before code-wrapping it, preserving brackets/parens verbatim", () => {
    const summary = buildPublishRejectedStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      reasons: [
        "patch touches pipeline-protected path(s): scripts/factory/evil.mts\n## Injected heading\n`code`",
      ],
    });
    // The newline-prefixed "## Injected heading" must not survive as its
    // own line/heading, and the backtick-wrapped "code" must not survive
    // as its own code span — both would break out of the wrapping code
    // span sanitizeStepSummaryText applies. The parenthetical "(s)" is
    // preserved verbatim inside that span; a code span itself is what
    // neutralizes it, not escaping.
    expect(summary).not.toContain("\n## Injected heading");
    expect(summary).not.toContain("`code`");
    expect(summary).toContain(
      "`patch touches pipeline-protected path(s): scripts/factory/evil.mts ## Injected heading code`",
    );
  });

  it("renders a [text](url) injection attempt in a reason as inert code, not a live link (Codex P2, categorical fix, round 3)", () => {
    const summary = buildPublishRejectedStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      reasons: [
        "patch touches pipeline-protected path: .github/workflows/[x](https://attacker.example).yml",
      ],
    });
    // The load-bearing assertion isn't "the raw text is absent" (it's
    // present, verbatim, inside the code span — that's fine and
    // intended) but that it's wrapped in backticks, which is what
    // actually prevents GitHub from rendering it as a live link.
    expect(summary).toContain(
      "`patch touches pipeline-protected path: .github/workflows/[x](https://attacker.example).yml`",
    );
  });

  it("renders a bare autolink-shaped URL in a reason as inert code, not a live autolink (the vector escaping alone never closed)", () => {
    const summary = buildPublishRejectedStepSummary({
      issueNumber: 6,
      publisherLogin: "roastpilot-factory[bot]",
      publishedViaFallback: false,
      reasons: ["network error contacting www.attacker.example during patch apply"],
    });
    expect(summary).toContain(
      "`network error contacting www.attacker.example during patch apply`",
    );
  });
});

describe("sanitizeStepSummaryText (categorical fix, round 3, post-#46-merge fix-forward: render as inert code, don't escape)", () => {
  it("wraps the value in a single-backtick inline code span", () => {
    expect(sanitizeStepSummaryText("plain text")).toBe("`plain text`");
  });

  it("collapses newlines to a space before wrapping", () => {
    expect(sanitizeStepSummaryText("line one\nline two\r\nline three")).toBe(
      "`line one line two line three`",
    );
  });

  it("strips backticks before wrapping (so the value can't break out of its own code span)", () => {
    expect(sanitizeStepSummaryText("a `dangerous` value")).toBe("`a dangerous value`");
  });

  it("preserves brackets/parens/angle-brackets/backslashes VERBATIM — a code span renders them literally, no escaping needed", () => {
    expect(sanitizeStepSummaryText("roastpilot-factory[bot]")).toBe(
      "`roastpilot-factory[bot]`",
    );
    expect(sanitizeStepSummaryText("the mint step failed (outcome=failure)")).toBe(
      "`the mint step failed (outcome=failure)`",
    );
    expect(sanitizeStepSummaryText("a\\b")).toBe("`a\\b`");
  });

  it("renders a [text](url) link-injection attempt as inert text, not a live link (round 1's finding, closed categorically)", () => {
    const malicious = ".github/workflows/[x](https://attacker.example).yml";
    const sanitized = sanitizeStepSummaryText(malicious);
    // Inside a code span, GitHub renders NOTHING as Markdown — the raw
    // [x](url) sequence is shown as literal text, not parsed as a link.
    // (It's present in the output, unescaped — that's fine and expected;
    // what matters is it's inside the ` `...` ` span, which the
    // integration-level test below confirms actually prevents rendering.)
    expect(sanitized).toBe(`\`${malicious}\``);
  });

  it("renders a BARE autolink-shaped URL as inert text — round 3's finding: escaping alone never closes this, code spans do", () => {
    // This is exactly what per-metacharacter escaping (rounds 1-2) could
    // never close: there is nothing to escape here — no bracket, no
    // paren, no angle bracket — yet GFM autolinks a bare recognized URL
    // shape regardless. A code span is the only construct that suppresses
    // autolinking too.
    expect(sanitizeStepSummaryText("see www.attacker.example for details")).toBe(
      "`see www.attacker.example for details`",
    );
  });

  it("clamps to 200 characters (before wrapping) with an ellipsis", () => {
    const long = "x".repeat(250);
    const result = sanitizeStepSummaryText(long);
    // 200 chars + the ellipsis + the two wrapping backticks.
    expect(result.length).toBe(203);
    expect(result.startsWith("`")).toBe(true);
    expect(result.endsWith("…`")).toBe(true);
  });

  it("does not clamp a value at or under the limit", () => {
    const exact = "x".repeat(200);
    expect(sanitizeStepSummaryText(exact)).toBe(`\`${exact}\``);
  });
});

describe("sanitizeStepSummaryUrl", () => {
  it("leaves a well-formed GitHub URL untouched", () => {
    const url = "https://github.com/syamaner/roastpilot-cloud/pull/99";
    expect(sanitizeStepSummaryUrl(url)).toBe(url);
  });

  it("strips brackets, parens, backticks, and newlines (link-structure risk, unlike plain body text)", () => {
    const malicious = "https://evil.example/x\n)[phishing](https://evil.example/y";
    const sanitized = sanitizeStepSummaryUrl(malicious);
    expect(sanitized).not.toMatch(/[`[\]()]/);
    expect(sanitized).not.toContain("\n");
  });

  it("clamps to 200 characters with an ellipsis", () => {
    const long = `https://github.com/o/r/pull/${"9".repeat(250)}`;
    const result = sanitizeStepSummaryUrl(long);
    expect(result.length).toBe(201);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("extractModelIdFromTranscript (F1-S10 slice 3, factory.md §13.12)", () => {
  it("extracts the model from the system/init message (the real claude-code-action transcript shape)", () => {
    const transcript = JSON.stringify([
      {
        type: "system",
        subtype: "init",
        model: "claude-opus-4-1-20250805",
        session_id: "abc-123",
      },
      { type: "assistant", message: { content: [] } },
      { type: "result", subtype: "success", is_error: false },
    ]);
    expect(extractModelIdFromTranscript(transcript)).toBe("claude-opus-4-1-20250805");
  });

  it("finds the init message even when it isn't first (defensive — real transcripts always lead with it, but this must not assume position)", () => {
    const transcript = JSON.stringify([
      { type: "assistant", message: { content: [] } },
      { type: "system", subtype: "init", model: "claude-sonnet-5" },
    ]);
    expect(extractModelIdFromTranscript(transcript)).toBe("claude-sonnet-5");
  });

  it("returns null for unparseable JSON", () => {
    expect(extractModelIdFromTranscript("{not valid json")).toBeNull();
  });

  it("returns null for a non-array top level", () => {
    expect(extractModelIdFromTranscript(JSON.stringify({ type: "system" }))).toBeNull();
  });

  it("returns null when no system/init message exists", () => {
    const transcript = JSON.stringify([{ type: "assistant", message: {} }]);
    expect(extractModelIdFromTranscript(transcript)).toBeNull();
  });

  it("returns null when the init message's model field is missing, empty, or not a string", () => {
    expect(
      extractModelIdFromTranscript(JSON.stringify([{ type: "system", subtype: "init" }])),
    ).toBeNull();
    expect(
      extractModelIdFromTranscript(
        JSON.stringify([{ type: "system", subtype: "init", model: "" }]),
      ),
    ).toBeNull();
    expect(
      extractModelIdFromTranscript(
        JSON.stringify([{ type: "system", subtype: "init", model: 42 }]),
      ),
    ).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(extractModelIdFromTranscript("[]")).toBeNull();
  });

  it("REJECTS (never truncates/sanitizes) a model value containing a newline — a corrupted/tampered transcript must not forge an extra commit trailer line (Codex P2, #55)", () => {
    const injected = "claude-sonnet\nSigned-off-by: mallory <mallory@example.com>";
    expect(
      extractModelIdFromTranscript(
        JSON.stringify([{ type: "system", subtype: "init", model: injected }]),
      ),
    ).toBeNull();
  });

  it("REJECTS a model value containing a bare carriage return too, not just \\n", () => {
    expect(
      extractModelIdFromTranscript(
        JSON.stringify([{ type: "system", subtype: "init", model: "claude\rSigned-off-by: x" }]),
      ),
    ).toBeNull();
  });
});

describe("buildCommitTrailer (F1-S10 slice 3, factory.md §13.12)", () => {
  const baseContext = {
    issueNumber: 6,
    agentActionRef: "anthropics/claude-code-action@700e7f8316990de46bed556429765647af760efc",
    modelId: "claude-opus-4-1-20250805",
    promptVersion: "1b781ecabc1234567890abcdef1234567890abcd",
    dispatchActor: "syamaner",
  };

  it("includes every required trailer line as a valid `Token: value` git trailer", () => {
    const trailer = buildCommitTrailer(baseContext);
    const lines = trailer.split("\n");
    expect(lines).toContain("Co-Authored-By: Claude <noreply@anthropic.com>");
    expect(lines).toContain("Signed-off-by: syamaner <syamaner@users.noreply.github.com>");
    expect(lines).toContain("Provenance-Model: claude-opus-4-1-20250805");
    expect(lines).toContain(
      "Provenance-Prompt-Version: 1b781ecabc1234567890abcdef1234567890abcd",
    );
    expect(lines).toContain(
      "Provenance-Agent-Action: anthropics/claude-code-action@700e7f8316990de46bed556429765647af760efc",
    );
    expect(lines).toContain("Provenance-Issue: #6");
    // Every line must itself be a single-line, colon-delimited trailer —
    // no embedded newlines that would break `git interpret-trailers`.
    for (const line of lines) {
      expect(line).toMatch(/^[A-Za-z0-9-]+: .+$/);
    }
  });

  it("renders 'unavailable' (never fabricated) for Provenance-Model when modelId is null", () => {
    const trailer = buildCommitTrailer({ ...baseContext, modelId: null });
    expect(trailer).toContain("Provenance-Model: unavailable");
    expect(trailer).not.toContain("claude-opus-4-1-20250805");
  });

  it("strips [ and ] from the dispatch actor's login when constructing the Signed-off-by email (defensive — this workflow is human-dispatch-only today, but a bot login would otherwise produce an invalid email local-part)", () => {
    const trailer = buildCommitTrailer({ ...baseContext, dispatchActor: "some-app[bot]" });
    expect(trailer).toContain("Signed-off-by: some-app[bot] <some-appbot@users.noreply.github.com>");
  });
});
