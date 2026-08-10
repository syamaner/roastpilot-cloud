import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const RUNBOOK_PATH = new URL("../../docs/factory-runbook.md", import.meta.url);
const WORKFLOW_DIRECTORY = new URL("../../.github/workflows/", import.meta.url);
const INVENTORY_LINE =
  /actions\/workflows\/(\d+)\/(disable|enable)\b.*#\s*(\S+\.ya?ml)/;
const INVENTORY_ACTION = /actions\/workflows\/\d+\/(?:disable|enable)\b/;
const UNAFFECTED_WORKFLOWS = new Set([
  "ci.yml",
  "codeql.yml",
  "dependency-review.yml",
  "claude-code-review.yml",
  "dev-snowflake-contract.yml",
]);

type InventoryEntry = {
  id: string;
  action: "disable" | "enable";
  filename: string;
};

function sectionBetween(
  document: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = document.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing section marker: ${startMarker}`);
  const end = document.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing section marker: ${endMarker}`);
  return document.slice(start, end);
}

function fencedBashBlockAfter(section: string, marker: string): string {
  const markerIndex = section.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing block marker: ${marker}`);
  const match = /```bash\n([\s\S]*?)```/.exec(section.slice(markerIndex));
  if (match?.[1] === undefined) {
    throw new Error(`Missing bash block after: ${marker}`);
  }
  return match[1];
}

function sectionAfter(document: string, marker: string): string {
  const start = document.indexOf(marker);
  if (start < 0) throw new Error(`Missing section marker: ${marker}`);
  return document.slice(start);
}

function parseInventoryBlock(
  block: string,
  expectedAction: "disable" | "enable",
): InventoryEntry[] {
  const actionLines = block
    .split("\n")
    .filter((line) => INVENTORY_ACTION.test(line));
  if (actionLines.length === 0) {
    throw new Error(`Inventory has no ${expectedAction} lines`);
  }

  return actionLines.map((line) => {
    const match = INVENTORY_LINE.exec(line);
    if (match === null) {
      throw new Error(`Malformed inventory line; add a .yml filename: ${line}`);
    }
    const id = match[1];
    const action = match[2];
    const filename = match[3];
    if (
      id === undefined ||
      filename === undefined ||
      (action !== "disable" && action !== "enable")
    ) {
      throw new Error(`Malformed inventory line: ${line}`);
    }
    if (action !== expectedAction) {
      throw new Error(
        `Expected ${expectedAction} inventory line but found ${action}: ${line}`,
      );
    }
    return { id, action, filename };
  });
}

const runbook = readFileSync(RUNBOOK_PATH, "utf8");
const killSwitch = sectionBetween(
  runbook,
  "## Kill-switch: stopping the factory",
  "## Resuming after a pause — clear the flag, then don't skip the backfill",
);
const disableSection = sectionBetween(
  killSwitch,
  "### 3. Disable the workflows",
  "### Emergency halt — full procedure",
);
const resumeSection = sectionBetween(
  runbook,
  "## Resuming after a pause — clear the flag, then don't skip the backfill",
  "## Cost/budget caps",
);
const disableBlock = fencedBashBlockAfter(
  disableSection,
  "### 3. Disable the workflows",
);
const enableBlock = fencedBashBlockAfter(
  resumeSection,
  "1. **Re-enable the workflows",
);
const disableEntries = parseInventoryBlock(disableBlock, "disable");
const enableEntries = parseInventoryBlock(enableBlock, "enable");

const workflowFiles = readdirSync(WORKFLOW_DIRECTORY)
  .filter((filename) => /\.ya?ml$/.test(filename))
  .sort();
const gatedWorkflows = workflowFiles.filter((filename) =>
  readFileSync(new URL(filename, WORKFLOW_DIRECTORY), "utf8").includes(
    "FACTORY_PAUSED",
  ),
);

describe("factory halt and resume inventory", () => {
  it("disables every workflow gated by FACTORY_PAUSED", () => {
    for (const filename of gatedWorkflows) {
      expect(
        disableEntries.some((entry) => entry.filename === filename),
        `Missing §3 disable inventory line for gated workflow ${filename}`,
      ).toBe(true);
    }
  });

  it("re-enables every workflow gated by FACTORY_PAUSED", () => {
    for (const filename of gatedWorkflows) {
      expect(
        enableEntries.some((entry) => entry.filename === filename),
        `Missing resume enable inventory line for gated workflow ${filename}`,
      ).toBe(true);
    }
  });

  it("keeps the disable and enable workflow ID sets strictly equal", () => {
    const disableIds = [
      ...new Set(disableEntries.map((entry) => entry.id)),
    ].sort();
    const enableIds = [...new Set(enableEntries.map((entry) => entry.id))].sort();
    expect(enableIds).toEqual(disableIds);
  });

  it("classifies every workflow as gated or explicitly unaffected", () => {
    const unclassified = workflowFiles.filter(
      (filename) =>
        !gatedWorkflows.includes(filename) &&
        !UNAFFECTED_WORKFLOWS.has(filename),
    );
    expect(
      unclassified,
      "Gate/classify every new workflow and update the runbook halt inventory or closed unaffected allowlist",
    ).toEqual([]);
  });

  it("enumerates all non-completed runs repo-wide with real pagination", () => {
    const cancelSection = sectionBetween(
      killSwitch,
      "### 2. Cancel any run already queued or in-progress",
      "### 3. Disable the workflows",
    );
    const enumeration = fencedBashBlockAfter(
      cancelSection,
      "**List every non-completed run",
    );
    expect(enumeration).toContain("gh api --paginate");
    expect(enumeration).toContain('select(.status != "completed")');
    expect(enumeration).not.toContain("gh run list --workflow");
    expect(enumeration).not.toContain("--limit");
  });

  it("documents the credentialed Snowflake workflow exclusion", () => {
    const exclusion = sectionAfter(
      disableSection,
      "#### Exclusion: `dev-snowflake-contract.yml`",
    );
    expect(exclusion).toContain("EXCLUDED");
    expect(exclusion).toContain("§2 cancel");
    expect(exclusion).toContain("§3 disable");
  });

  it("documents both conditional event-backfill paths", () => {
    expect(resumeSection).toMatch(
      /codex-verdict-status\.yml --ref main[^\n]*-f pr_number/,
    );
    const ownerBackfill = resumeSection.slice(
      resumeSection.indexOf("**Conditional Step 5 (9e)"),
    );
    expect(ownerBackfill).toContain("@claude question");
    expect(ownerBackfill).toContain("@claude task");
    expect(ownerBackfill).toMatch(/re-issue[^.]*fresh PR comment/);
  });

  it("rejects empty and malformed inventory fixtures", () => {
    expect(() => parseInventoryBlock("echo no inventory", "disable")).toThrow(
      "Inventory has no disable lines",
    );
    expect(() =>
      parseInventoryBlock(
        "gh api -X PUT repos/example/repo/actions/workflows/123/disable # Triage Issues",
        "disable",
      ),
    ).toThrow("add a .yml filename");
  });
});
