import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  verifyNodeImportClosure,
  type NodeExternalModuleRule,
} from "../../scripts/factory/node-import-closure-verifier.mts";
import {
  GITHUB_COMPARE_DIFF_FILE_LIMIT as leafFileLimit,
  MAX_PR_DIFF_BYTES as leafDiffLimit,
  generateDelimiterNonce as leafNonce,
  neutralizeDiffDelimiterBreakout as leafNeutralize,
  truncateToByteBudget as leafTruncate,
  wrapUntrustedDiffBlock as leafWrap,
} from "../../scripts/factory/untrusted-diff-fence.mts";
import { truncateToByteBudget as legacyTruncate } from "../../scripts/factory/spec-grounding-logic.mts";
import {
  GITHUB_COMPARE_DIFF_FILE_LIMIT as legacyFileLimit,
  MAX_PR_DIFF_BYTES as legacyDiffLimit,
  neutralizeDiffDelimiterBreakout as legacyNeutralize,
  wrapUntrustedDiffBlock as legacyWrap,
} from "../../scripts/factory/spec-grounding-runner-logic.mts";
import { generateDelimiterNonce as legacyNonce } from "../../scripts/factory/spec-grounding-runner.mts";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRYPOINTS = [
  "scripts/factory/apply-owner-task.mts",
  "scripts/factory/intake-owner-command.mts",
  "scripts/factory/intake-owner-command-issue.mts",
  "scripts/factory/post-owner-command-response.mts",
] as const;
const NODE_BUILTINS: readonly NodeExternalModuleRule[] = [
  {
    kind: "node-builtin",
    specifier: "node:crypto",
    resolvedTarget: "node:crypto",
  },
  {
    kind: "node-builtin",
    specifier: "node:fs",
    resolvedTarget: "node:fs",
  },
  {
    kind: "node-builtin",
    specifier: "node:path",
    resolvedTarget: "node:path",
  },
];

function verify(entrypoints: readonly string[]) {
  return verifyNodeImportClosure({
    repositoryRoot: REPOSITORY_ROOT,
    trustedRoot: "scripts/factory",
    trustedSourceClass: "protected-glue",
    rootsComplete: true,
    entrypoints,
    externalModules: NODE_BUILTINS,
  });
}

describe("credentialed sparse-checkout entrypoint import closure", () => {
  it("T-U1.3 admits all entrypoints with Node builtins and repository leaves only", () => {
    const result = verify(ENTRYPOINTS);

    expect(result.violations).toEqual([]);
    expect(result.files).toEqual([
      "scripts/factory/apply-owner-task.mts",
      "scripts/factory/derive-issue-command-authorization.mts",
      "scripts/factory/factory-owner-allowlist.mts",
      "scripts/factory/github-api.mts",
      "scripts/factory/implement-patch-logic.mts",
      "scripts/factory/intake-owner-command-issue.mts",
      "scripts/factory/intake-owner-command.mts",
      "scripts/factory/owner-command-logic.mts",
      "scripts/factory/owner-task-patch-logic.mts",
      "scripts/factory/patch-analysis-format.mts",
      "scripts/factory/post-owner-command-response-logic.mts",
      "scripts/factory/post-owner-command-response.mts",
      "scripts/factory/untrusted-diff-fence.mts",
      "scripts/factory/untrusted-text.mts",
    ]);
  });

  it("keeps issue intake inside the protected dependency-free closure", () => {
    const result = verify(["scripts/factory/intake-owner-command-issue.mts"]);

    expect(result.violations).toEqual([]);
    expect(result.files).toEqual([
      "scripts/factory/derive-issue-command-authorization.mts",
      "scripts/factory/factory-owner-allowlist.mts",
      "scripts/factory/github-api.mts",
      "scripts/factory/intake-owner-command-issue.mts",
      "scripts/factory/owner-command-logic.mts",
    ]);
  });

  it("T-U1.3 keeps intake's pinned import closure unchanged", () => {
    const result = verify(["scripts/factory/intake-owner-command.mts"]);

    expect(result.violations).toEqual([]);
    expect(result.files).toEqual([
      "scripts/factory/factory-owner-allowlist.mts",
      "scripts/factory/github-api.mts",
      "scripts/factory/intake-owner-command.mts",
      "scripts/factory/owner-command-logic.mts",
      "scripts/factory/post-owner-command-response-logic.mts",
      "scripts/factory/untrusted-diff-fence.mts",
      "scripts/factory/untrusted-text.mts",
    ]);
  });

  it("rejects the package-dependent markdown parser as a regression witness", () => {
    const result = verify(["scripts/factory/spec-grounding-logic.mts"]);

    expect(result.files).toEqual([]);
    expect(result.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "unapproved-external-module",
        detail: expect.stringContaining('external module "markdown-it"'),
      }),
    ]));
  });

  it("preserves every historical fence export by identity", () => {
    expect(legacyTruncate).toBe(leafTruncate);
    expect(legacyNeutralize).toBe(leafNeutralize);
    expect(legacyWrap).toBe(leafWrap);
    expect(legacyDiffLimit).toBe(leafDiffLimit);
    expect(legacyFileLimit).toBe(leafFileLimit);
    expect(legacyNonce).toBe(leafNonce);
  });
});
