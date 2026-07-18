import { describe, expect, it } from "vitest";
import {
  extractChangedPathsFromDiff,
  isEmptyDiff,
} from "../../scripts/factory/patch-diff.mts";

const SAMPLE_MODIFY_DIFF = `diff --git a/lib/slug.ts b/lib/slug.ts
index abc1234..def5678 100644
--- a/lib/slug.ts
+++ b/lib/slug.ts
@@ -1,3 +1,4 @@
+// a comment
 export function isValidSlug() {}
`;

const SAMPLE_ADD_DIFF = `diff --git a/lib/new-file.ts b/lib/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/lib/new-file.ts
@@ -0,0 +1,2 @@
+export const x = 1;
+
`;

const SAMPLE_DELETE_DIFF = `diff --git a/lib/old-file.ts b/lib/old-file.ts
deleted file mode 100644
index abc1234..0000000
--- a/lib/old-file.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const x = 1;
-
`;

const SAMPLE_RENAME_DIFF = `diff --git a/lib/old-name.ts b/lib/new-name.ts
similarity index 100%
rename from lib/old-name.ts
rename to lib/new-name.ts
`;

describe("extractChangedPathsFromDiff", () => {
  it("extracts both sides of a modified file", () => {
    expect(extractChangedPathsFromDiff(SAMPLE_MODIFY_DIFF)).toEqual([
      "a/lib/slug.ts",
      "b/lib/slug.ts",
    ]);
  });

  it("extracts a newly added file", () => {
    expect(extractChangedPathsFromDiff(SAMPLE_ADD_DIFF)).toEqual([
      "a/lib/new-file.ts",
      "b/lib/new-file.ts",
    ]);
  });

  it("extracts a deleted file", () => {
    expect(extractChangedPathsFromDiff(SAMPLE_DELETE_DIFF)).toEqual([
      "a/lib/old-file.ts",
      "b/lib/old-file.ts",
    ]);
  });

  it("extracts BOTH the old and new path of a rename (a rename into a protected path is as dangerous as a direct edit)", () => {
    expect(extractChangedPathsFromDiff(SAMPLE_RENAME_DIFF)).toEqual([
      "a/lib/old-name.ts",
      "b/lib/new-name.ts",
    ]);
  });

  it("handles multiple files in one diff", () => {
    const combined = SAMPLE_MODIFY_DIFF + SAMPLE_ADD_DIFF;
    expect(extractChangedPathsFromDiff(combined)).toEqual([
      "a/lib/new-file.ts",
      "a/lib/slug.ts",
      "b/lib/new-file.ts",
      "b/lib/slug.ts",
    ]);
  });

  it("returns an empty array for an empty diff", () => {
    expect(extractChangedPathsFromDiff("")).toEqual([]);
  });

  it("returns an empty array for text with no diff --git headers", () => {
    expect(extractChangedPathsFromDiff("not a diff\njust some text\n")).toEqual(
      [],
    );
  });

  it("catches an attempted path-traversal filename inside a diff header (still extracted, guard rejects it downstream)", () => {
    const trickyDiff = `diff --git a/../../etc/passwd b/../../etc/passwd
--- a/../../etc/passwd
+++ b/../../etc/passwd
@@ -1 +1 @@
-root:x:0:0
+pwned
`;
    expect(extractChangedPathsFromDiff(trickyDiff)).toEqual([
      "a/../../etc/passwd",
      "b/../../etc/passwd",
    ]);
  });
});

describe("isEmptyDiff", () => {
  it("is true for an empty string", () => {
    expect(isEmptyDiff("")).toBe(true);
  });

  it("is true for whitespace-only content", () => {
    expect(isEmptyDiff("\n\n  \n")).toBe(true);
  });

  it("is false when at least one file changed", () => {
    expect(isEmptyDiff(SAMPLE_MODIFY_DIFF)).toBe(false);
  });
});
