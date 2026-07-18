import { describe, expect, it } from "vitest";
import {
  buildImplementFailureCommentBody,
  buildImplementPrBody,
  deriveBranchName,
  findForbiddenPatchPaths,
  isProtectedPath,
  normalizePatchPath,
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
});
