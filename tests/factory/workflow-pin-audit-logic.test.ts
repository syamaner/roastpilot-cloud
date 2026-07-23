import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_CLAUDE_CODE_ACTION_SHA,
  findUnpinnedActionReferences,
  findWildcardAllowlistUsages,
  findWorkflowPinViolations,
  isWorkflowPinAuditManifestPath,
} from "../../scripts/factory/workflow-pin-audit-logic.mts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GITHUB_DIR = join(REPOSITORY_ROOT, ".github");
const WORKFLOWS_DIR = join(GITHUB_DIR, "workflows");
const ACTIONS_DIR = join(GITHUB_DIR, "actions");

function listFilesRecursively(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursively(path) : [path];
  });
}

function repositoryRelativePath(path: string): string {
  return relative(REPOSITORY_ROOT, path).replaceAll("\\", "/");
}

describe("isWorkflowPinAuditManifestPath (issue #102)", () => {
  it.each([
    ".github/workflows/review.yml",
    ".github/workflows/nested/review.yaml",
    ".github/actions/action.yml",
    ".github/actions/review/action.yml",
    ".github/actions/review/nested/action.yaml",
    ".github\\actions\\review\\action.yml",
  ])("includes audited workflow or composite manifest %s", (path) => {
    expect(isWorkflowPinAuditManifestPath(path)).toBe(true);
  });

  it.each([
    ".github/actions/review/metadata.yml",
    ".github/workflows/review.json",
    "examples/.github/workflows/review.yml",
  ])("excludes non-audited path %s", (path) => {
    expect(isWorkflowPinAuditManifestPath(path)).toBe(false);
  });
});

describe("findUnpinnedActionReferences (issue #102)", () => {
  it("accepts the expected action pin and its case-insensitive equivalent", () => {
    const upperSha = EXPECTED_CLAUDE_CODE_ACTION_SHA.toUpperCase();
    const content = [
      "steps:",
      `  - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
      `  - uses: Anthropics/Claude-Code-Action@${upperSha}`,
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("flags a mixed-case repository with a floating ref", () => {
    const content = [
      "steps:",
      "  - uses: Anthropics/Claude-Code-Action@main",
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining("@main"),
      }),
    ]);
  });

  it.each([
    "attacker/claude-code-action@main",
    `evilanthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
  ])("rejects wrong repository identity %s", (reference) => {
    const content = `steps:\n  - uses: ${reference}\n`;
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining(reference),
      }),
    ]);
  });

  it.each(["v1", "abc123", "1".repeat(40)])(
    "flags non-approved ref %s",
    (ref) => {
      const content = `steps:\n  - uses: anthropics/claude-code-action@${ref}\n`;
      expect(findUnpinnedActionReferences(content)).toHaveLength(1);
    },
  );

  it("flags a mutable suffix on the approved SHA", () => {
    const content = `steps:\n  - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}-main\n`;
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining(
          `${EXPECTED_CLAUDE_CODE_ACTION_SHA}-main`,
        ),
      }),
    ]);
  });

  it.each(["#mutable", "'mutable", '"mutable'])(
    "does not truncate decoded ref suffix %s",
    (suffix) => {
      const reference = `anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}${suffix}`;
      const content = `steps:\n  - uses: '${reference.replaceAll("'", "''")}'\n`;
      expect(findUnpinnedActionReferences(content)).toEqual([
        expect.objectContaining({
          kind: "unpinned-action",
          detail: expect.stringContaining(
            `${EXPECTED_CLAUDE_CODE_ACTION_SHA}${suffix}`,
          ),
        }),
      ]);
    },
  );

  it("preserves the duplicated provenance-scalar invariant", () => {
    const driftedSha = "2".repeat(40);
    const content = [
      "env:",
      `  IMPLEMENT_AGENT_ACTION_REF: "anthropics/claude-code-action@${driftedSha}"`,
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({ kind: "unpinned-action", line: 2 }),
    ]);
  });

  it("rejects an owner-prefix lookalike in the dedicated provenance field", () => {
    const content = [
      "env:",
      `  IMPLEMENT_AGENT_ACTION_REF: "evilanthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}"`,
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining("evilanthropics"),
      }),
    ]);
  });

  it("rejects a non-string dedicated provenance value", () => {
    const content = "env:\n  IMPLEMENT_AGENT_ACTION_REF: [invalid]\n";
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining("non-string"),
      }),
    ]);
  });

  it("still rejects drifted action refs in other embedded scalars", () => {
    const content = [
      "metadata:",
      '  OTHER_ACTION_REF: "anthropics/claude-code-action@main"',
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({
        kind: "unpinned-action",
        line: 2,
        detail: expect.stringContaining('"main"'),
      }),
    ]);
  });

  it("resolves an aliased action reference structurally", () => {
    const content = [
      "action: &review-action Anthropics/Claude-Code-Action@main",
      "steps:",
      "  - uses: *review-action",
    ].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([
      expect.objectContaining({ kind: "unpinned-action", line: 3 }),
    ]);
  });

  it("does not inspect comments as action references", () => {
    const content =
      "# uses: anthropics/claude-code-action@main\nsteps: []\n";
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("does not crash on non-string keys or non-scalar uses values", () => {
    const content = ["1: unrelated", "uses: [not, a, scalar]"].join("\n");
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });
});

describe("findWildcardAllowlistUsages (issue #102)", () => {
  it("accepts explicit and intentionally empty allowlists", () => {
    const content = [
      "with:",
      "  allowed_bots: claude,claude[bot]",
      '  allowed_non_write_users: ""',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("accepts an explicit sequence, including an empty YAML item", () => {
    const content = [
      "with:",
      "  allowed_bots:",
      "    -",
      "    - claude[bot]",
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("flags a wildcard behind a quoted key", () => {
    const content = 'with:\n  "allowed_bots": "*"\n';
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 2 }),
    ]);
  });

  it.each(["ALLOWED_BOTS", "Allowed_Non_Write_Users"])(
    "normalizes mixed-case action input key %s",
    (key) => {
      const content = `with:\n  ${key}: "*"\n`;
      expect(findWildcardAllowlistUsages(content)).toEqual([
        expect.objectContaining({ kind: "wildcard-allowlist", line: 2 }),
      ]);
    },
  );

  it("flags a wildcard scalar through an anchor and alias", () => {
    const content = [
      'wildcard: &wildcard "*"',
      "with:",
      "  allowed_non_write_users: *wildcard",
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 3 }),
    ]);
  });

  it("flags a wildcard behind an aliased allowlist key", () => {
    const content = [
      "allowlist-key: &allowlist-key allowed_bots",
      "with:",
      '  *allowlist-key : "*"',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 3 }),
    ]);
  });

  it("handles a cyclic allowlist alias without recursing indefinitely", () => {
    const content = "with:\n  allowed_bots: &cycle [*cycle]\n";
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("flags an allowlist key inside an anchored mapping", () => {
    const content = [
      "defaults: &defaults",
      '  allowed_bots: "*"',
      "with: *defaults",
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 2 }),
    ]);
  });

  it("flags an explicitly tagged string wildcard", () => {
    const content = 'with:\n  allowed_bots: !!str "*"\n';
    expect(findWildcardAllowlistUsages(content)).toHaveLength(1);
  });

  it("flags a wildcard in a flow mapping and sequence", () => {
    const content =
      'with: { allowed_bots: ["claude[bot]", "*"], other: value }\n';
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 1 }),
    ]);
  });

  it("flags a wildcard in a block scalar", () => {
    const content = ["with:", "  allowed_bots: |-", "    *"].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 2 }),
    ]);
  });

  it("flags a YAML-escaped wildcard", () => {
    const content = 'with:\n  allowed_bots: "\\x2A"\n';
    expect(content).not.toContain("*");
    expect(findWildcardAllowlistUsages(content)).toHaveLength(1);
  });

  it("reports the wildcard list item line", () => {
    const content = [
      "with:",
      "  allowed_bots:",
      "    - claude[bot]",
      '    - "*"',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([
      expect.objectContaining({ kind: "wildcard-allowlist", line: 4 }),
    ]);
  });

  it("does not flag wildcards on unrelated keys or in comments", () => {
    const content = [
      "with:",
      '  file_glob: "*"',
      '  allowed_bots: claude # not "*"',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });
});

describe("findWorkflowPinViolations (issue #102)", () => {
  it("combines action and allowlist findings in source order", () => {
    const content = [
      "steps:",
      "  - uses: anthropics/claude-code-action@main",
      "    with:",
      '      allowed_bots: "*"',
    ].join("\n");
    const violations = findWorkflowPinViolations(content);
    expect(violations.map((violation) => violation.kind)).toEqual([
      "unpinned-action",
      "wildcard-allowlist",
    ]);
    expect(violations.map((violation) => violation.line)).toEqual([2, 4]);
  });

  it("fails closed on malformed YAML", () => {
    const violations = findWorkflowPinViolations(
      'steps:\n  - uses: "unterminated\n',
    );
    expect(violations).toEqual([
      expect.objectContaining({
        kind: "invalid-yaml",
        line: 3,
        detail: expect.stringContaining("invalid YAML"),
      }),
    ]);
  });

  it("fails closed on an unquoted bare wildcard, which YAML treats as an invalid alias", () => {
    const violations = findWorkflowPinViolations(
      "with:\n  allowed_bots: *\n",
    );
    expect(violations).toEqual([
      expect.objectContaining({ kind: "invalid-yaml", line: 2 }),
    ]);
  });

  it("fails closed on excessive alias expansion", () => {
    const aliases = (anchor: string): string =>
      Array.from({ length: 11 }, () => `*${anchor}`).join(", ");
    const content = [
      "a: &a [value]",
      `b: &b [${aliases("a")}]`,
      `c: &c [${aliases("b")}]`,
      `d: [${aliases("c")}]`,
    ].join("\n");
    expect(findWorkflowPinViolations(content)).toEqual([
      expect.objectContaining({
        kind: "invalid-yaml",
        line: 1,
        detail: expect.stringContaining("resource exhaustion"),
      }),
    ]);
  });

  it("returns no findings for a clean document", () => {
    expect(findWorkflowPinViolations("name: example\njobs: {}\n")).toEqual([]);
  });
});

describe("live audited manifests (issue #102)", () => {
  const auditedFiles = listFilesRecursively(GITHUB_DIR).filter((path) =>
    isWorkflowPinAuditManifestPath(repositoryRelativePath(path)),
  );

  it("discovers at least one real manifest and audits each structurally", () => {
    expect(auditedFiles.length).toBeGreaterThan(0);

    const failures = auditedFiles.flatMap((path) =>
      findWorkflowPinViolations(readFileSync(path, "utf8")).map(
        (violation) =>
          `${repositoryRelativePath(path)}:${violation.line} -- ${violation.detail}`,
      ),
    );
    expect(failures).toEqual([]);
  });

  it("discovers every workflow YAML and any composite action manifest", () => {
    const workflowFiles = listFilesRecursively(WORKFLOWS_DIR).filter((path) =>
      /\.ya?ml$/i.test(path),
    );
    const actionFiles = existsSync(ACTIONS_DIR)
      ? listFilesRecursively(ACTIONS_DIR).filter((path) =>
          /^action\.ya?ml$/i.test(basename(path)),
        )
      : [];
    const expected = [...workflowFiles, ...actionFiles]
      .map(repositoryRelativePath)
      .sort();
    expect(auditedFiles.map(repositoryRelativePath).sort()).toEqual(expected);
  });

  it("covers the live IMPLEMENT_AGENT_ACTION_REF provenance scalar", () => {
    const implementWorkflow = auditedFiles.find((path) =>
      path.endsWith("/implement-ready-issues.yml"),
    );
    expect(implementWorkflow).toBeDefined();
    const content = readFileSync(implementWorkflow!, "utf8");
    expect(content).toContain("IMPLEMENT_AGENT_ACTION_REF");
    expect(content).toMatch(
      new RegExp(
        `^\\s*IMPLEMENT_AGENT_ACTION_REF:\\s*["']anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}["']\\s*(?:#.*)?$`,
        "m",
      ),
    );
  });
});
