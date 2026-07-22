import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_CLAUDE_CODE_ACTION_SHA,
  findUnpinnedActionUsages,
  findWildcardAllowlistUsages,
  findWorkflowPinViolations,
} from "../../scripts/factory/workflow-pin-audit-logic.mts";

const WORKFLOWS_DIR = fileURLToPath(new URL("../../.github/workflows", import.meta.url));

describe("findUnpinnedActionUsages (F1-S7, issue #10)", () => {
  it("finds nothing when every usage pins to the expected SHA", () => {
    const content = `
      - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA} # v1.0.176
      - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}
    `;
    expect(findUnpinnedActionUsages(content)).toEqual([]);
  });

  it("flags a floating-tag usage (@main)", () => {
    const content = "      - uses: anthropics/claude-code-action@main\n";
    const violations = findUnpinnedActionUsages(content);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "unpinned-action", line: 1 });
    expect(violations[0].detail).toContain('"main"');
  });

  it("flags a floating major-version tag (@v1)", () => {
    const content = "      - uses: anthropics/claude-code-action@v1\n";
    expect(findUnpinnedActionUsages(content)).toHaveLength(1);
  });

  it("flags a DIFFERENT full 40-char SHA -- a drifted or partial version bump, not just a non-SHA ref", () => {
    const driftedSha = "1111111111111111111111111111111111111111";
    const content = `      - uses: anthropics/claude-code-action@${driftedSha}\n`;
    const violations = findUnpinnedActionUsages(content);
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain(driftedSha);
    expect(violations[0].detail).toContain(EXPECTED_CLAUDE_CODE_ACTION_SHA);
  });

  it("reports the correct 1-based line number for a multi-line file", () => {
    const content = [
      "name: example",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: anthropics/claude-code-action@main",
    ].join("\n");
    const violations = findUnpinnedActionUsages(content);
    expect(violations).toEqual([expect.objectContaining({ line: 5 })]);
  });

  it("ignores an unrelated action's @ref entirely", () => {
    const content = "      - uses: actions/checkout@v7\n";
    expect(findUnpinnedActionUsages(content)).toEqual([]);
  });
});

describe("findWildcardAllowlistUsages (F1-S7, issue #10)", () => {
  it("finds nothing for an explicit allowlist or an intentionally empty one", () => {
    const content = [
      "          allowed_bots: 'claude,claude[bot]'",
      '          allowed_non_write_users: ""',
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("flags a bare unquoted wildcard on allowed_bots", () => {
    const content = "          allowed_bots: *\n";
    const violations = findWildcardAllowlistUsages(content);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "wildcard-allowlist", line: 1 });
  });

  it("flags a quoted wildcard on allowed_non_write_users (single or double quotes)", () => {
    expect(findWildcardAllowlistUsages("          allowed_non_write_users: '*'\n")).toHaveLength(1);
    expect(findWildcardAllowlistUsages('          allowed_non_write_users: "*"\n')).toHaveLength(1);
  });

  it("does NOT flag a `*` that appears inside an explicit list or a comment -- narrow key match only", () => {
    const content = [
      "          allowed_bots: 'claude,claude[bot]' # not a * wildcard",
      "          # allowed_bots: '*' -- commented out, never active",
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("does NOT flag an unrelated key whose value happens to be *", () => {
    const content = "          some_other_glob_field: '*'\n";
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });
});

describe("findWorkflowPinViolations (F1-S7, issue #10)", () => {
  it("combines both checks and sorts by line number", () => {
    const content = [
      "      - uses: anthropics/claude-code-action@main", // line 1: unpinned
      "          allowed_bots: '*'", // line 2: wildcard
    ].join("\n");
    const violations = findWorkflowPinViolations(content);
    expect(violations.map((v) => v.line)).toEqual([1, 2]);
    expect(violations.map((v) => v.kind)).toEqual(["unpinned-action", "wildcard-allowlist"]);
  });

  it("returns an empty array for a clean file", () => {
    expect(findWorkflowPinViolations("name: example\njobs: {}\n")).toEqual([]);
  });
});

describe("live workflow files (F1-S7, issue #10) -- the actual regression gate", () => {
  it("every real .github/workflows/*.yml file has zero pin/wildcard violations", () => {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    // A workflow file being findable at all is part of what this test
    // proves -- an empty directory listing would make the loop below
    // vacuously pass without ever checking anything.
    expect(files.length).toBeGreaterThan(0);

    const failures: string[] = [];
    for (const file of files) {
      const content = readFileSync(`${WORKFLOWS_DIR}/${file}`, "utf8");
      for (const violation of findWorkflowPinViolations(content)) {
        failures.push(`${file}:${violation.line} -- ${violation.detail}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("at least one workflow file actually uses claude-code-action -- otherwise the pin check above is vacuous", () => {
    const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    const anyUsesIt = files.some((file) =>
      readFileSync(`${WORKFLOWS_DIR}/${file}`, "utf8").includes("anthropics/claude-code-action@"),
    );
    expect(anyUsesIt).toBe(true);
  });
});
