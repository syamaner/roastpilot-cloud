import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_CLAUDE_CODE_ACTION_SHA,
  findUnpinnedActionReferences,
  findWildcardAllowlistUsages,
  findWorkflowPinViolations,
} from "../../scripts/factory/workflow-pin-audit-logic.mts";

const WORKFLOWS_DIR = fileURLToPath(new URL("../../.github/workflows", import.meta.url));

describe("findUnpinnedActionReferences (F1-S7, issue #10)", () => {
  it("finds nothing when every reference pins to the expected SHA", () => {
    const content = `
      - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA} # v1.0.176
      - uses: anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}
    `;
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("flags a floating-tag usage (@main)", () => {
    const content = "      - uses: anthropics/claude-code-action@main\n";
    const violations = findUnpinnedActionReferences(content);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "unpinned-action", line: 1 });
    expect(violations[0].detail).toContain('"main"');
  });

  it("flags a floating major-version tag (@v1)", () => {
    const content = "      - uses: anthropics/claude-code-action@v1\n";
    expect(findUnpinnedActionReferences(content)).toHaveLength(1);
  });

  it("flags a DIFFERENT full 40-char SHA -- a drifted or partial version bump, not just a non-SHA ref", () => {
    const driftedSha = "1111111111111111111111111111111111111111";
    const content = `      - uses: anthropics/claude-code-action@${driftedSha}\n`;
    const violations = findUnpinnedActionReferences(content);
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
    const violations = findUnpinnedActionReferences(content);
    expect(violations).toEqual([expect.objectContaining({ line: 5 })]);
  });

  it("ignores an unrelated action's @ref entirely", () => {
    const content = "      - uses: actions/checkout@v7\n";
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("flags a hand-duplicated reference OUTSIDE any uses: line -- MEDIUM 2, factory-security review round 1 (a `uses:`-anchored check would miss this entirely, exactly the class implement-ready-issues.yml's own IMPLEMENT_AGENT_ACTION_REF env-var duplicate belongs to)", () => {
    const driftedSha = "2222222222222222222222222222222222222222";
    const content = `          MY_ACTION_REF: "anthropics/claude-code-action@${driftedSha}"\n`;
    const violations = findUnpinnedActionReferences(content);
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain(driftedSha);
  });

  it("does NOT flag a hand-duplicated reference that IS in sync -- proves the broadened check isn't just always-on", () => {
    const content = `          MY_ACTION_REF: "anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}"\n`;
    expect(findUnpinnedActionReferences(content)).toEqual([]);
  });

  it("catches two references on the SAME line -- doesn't assume one-match-per-line", () => {
    const driftedSha = "3333333333333333333333333333333333333333";
    const content = `anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA} anthropics/claude-code-action@${driftedSha}\n`;
    const violations = findUnpinnedActionReferences(content);
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain(driftedSha);
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

  it("does NOT flag a `*` on a line that is ENTIRELY a comment, with the # as the very first character (no leading whitespace)", () => {
    expect(findWildcardAllowlistUsages("#allowed_bots: '*'\n")).toEqual([]);
  });

  it("does NOT treat a mid-token # (not preceded by whitespace, not at line-start) as a comment start -- a wrong strip here would turn a non-wildcard value into a false-positive bare wildcard", () => {
    // If `#` here were wrongly treated as starting a comment, this would
    // strip down to `allowed_bots: *` and wrongly flag a bare wildcard --
    // the actual (odd but literal) value is `*#nocomment`, not `*`.
    expect(findWildcardAllowlistUsages("          allowed_bots: *#nocomment\n")).toEqual([]);
  });

  it("does NOT flag an unrelated key whose value happens to be *", () => {
    const content = "          some_other_glob_field: '*'\n";
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("flags a wildcard even with a trailing comment -- MEDIUM 1 bypass form 1, factory-security review round 1 (the previous end-anchored regex required the wildcard to be the LAST thing on the line)", () => {
    const violations = findWildcardAllowlistUsages("          allowed_bots: '*' # deliberately wide\n");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "wildcard-allowlist", line: 1 });
  });

  it("flags a wildcard even with an UNQUOTED trailing comment", () => {
    expect(findWildcardAllowlistUsages("          allowed_bots: * # wide open\n")).toHaveLength(1);
  });

  it("flags a wildcard in the YAML block-list form -- MEDIUM 1 bypass form 2, factory-security review round 1 (`key:` on one line, `- '*'` on the next; a same-line-only regex can never see this)", () => {
    const content = ["          allowed_bots:", "            - '*'"].join("\n");
    const violations = findWildcardAllowlistUsages(content);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "wildcard-allowlist", line: 2 });
  });

  it("does NOT flag a block list with an explicit entry, only a genuine wildcard entry within it", () => {
    const content = ["          allowed_bots:", "            - 'claude'", "            - 'claude[bot]'"].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("stops scanning a block list at the first dedented/non-list line -- doesn't wander into an unrelated later key's own list", () => {
    const content = [
      "          allowed_bots:",
      "            - 'claude'",
      "          allowed_non_write_users: ''",
      "          some_other_key:",
      "            - '*'", // belongs to some_other_key, not allowed_bots
    ].join("\n");
    expect(findWildcardAllowlistUsages(content)).toEqual([]);
  });

  it("flags a wildcard in the YAML flow-sequence form (`key: ['*']`)", () => {
    const violations = findWildcardAllowlistUsages("          allowed_bots: ['*']\n");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ kind: "wildcard-allowlist", line: 1 });
  });

  it("does NOT flag a flow-sequence with only explicit entries", () => {
    expect(findWildcardAllowlistUsages("          allowed_bots: ['claude', 'claude[bot]']\n")).toEqual([]);
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

  it("implement-ready-issues.yml's own hand-duplicated IMPLEMENT_AGENT_ACTION_REF env var is genuinely covered by the live gate above, not accidentally skipped (MEDIUM 2 regression pin -- this is the exact real-world occurrence that motivated broadening the check beyond `uses:` lines)", () => {
    const content = readFileSync(`${WORKFLOWS_DIR}/implement-ready-issues.yml`, "utf8");
    expect(content).toContain("IMPLEMENT_AGENT_ACTION_REF");
    expect(content).toContain(`anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`);
  });
});
