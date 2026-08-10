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

function filenameIdMap(
  entries: readonly InventoryEntry[],
  label: string,
): Map<string, string> {
  const byFilename = new Map<string, string>();
  const filenameById = new Map<string, string>();
  for (const entry of entries) {
    if (byFilename.has(entry.filename)) {
      throw new Error(
        `${label} inventory repeats workflow filename ${entry.filename}`,
      );
    }
    const existingFilename = filenameById.get(entry.id);
    if (existingFilename !== undefined) {
      throw new Error(
        `${label} inventory reuses workflow ID ${entry.id} for ${existingFilename} and ${entry.filename}`,
      );
    }
    byFilename.set(entry.filename, entry.id);
    filenameById.set(entry.id, entry.filename);
  }
  return byFilename;
}

function assertGatedMappings(
  disableIds: ReadonlyMap<string, string>,
  enableIds: ReadonlyMap<string, string>,
  gatedFilenames: readonly string[],
): void {
  for (const filename of gatedFilenames) {
    const disableId = disableIds.get(filename);
    if (disableId === undefined) {
      throw new Error(`Missing disable workflow ID mapping for ${filename}`);
    }
    const enableId = enableIds.get(filename);
    if (enableId === undefined) {
      throw new Error(`Missing enable workflow ID mapping for ${filename}`);
    }
    if (disableId !== enableId) {
      throw new Error(
        `Disable/enable workflow ID mismatch for ${filename}: ${disableId} != ${enableId}`,
      );
    }
  }
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
const disableIdsByFilename = filenameIdMap(disableEntries, "Disable");
const enableIdsByFilename = filenameIdMap(enableEntries, "Enable");

const workflowFiles = readdirSync(WORKFLOW_DIRECTORY)
  .filter((filename) => /\.ya?ml$/.test(filename))
  .sort();
// Deliberately coarse: literal-substring over-inclusion is safe. A future
// workflow could evade this detector by gating through expression indirection;
// it must instead retain the literal or be consciously added to
// UNAFFECTED_WORKFLOWS. That .github/** + tests/factory/** change draws the
// factory-security-reviewer lens.
const gatedWorkflows = workflowFiles.filter((filename) =>
  readFileSync(new URL(filename, WORKFLOW_DIRECTORY), "utf8").includes(
    "FACTORY_PAUSED",
  ),
);

describe("factory halt and resume inventory", () => {
  it("disables every workflow gated by FACTORY_PAUSED", () => {
    for (const filename of gatedWorkflows) {
      expect(
        disableIdsByFilename.has(filename),
        `Missing §3 disable inventory line for gated workflow ${filename}`,
      ).toBe(true);
    }
  });

  it("re-enables every workflow gated by FACTORY_PAUSED", () => {
    for (const filename of gatedWorkflows) {
      expect(
        enableIdsByFilename.has(filename),
        `Missing resume enable inventory line for gated workflow ${filename}`,
      ).toBe(true);
    }
  });

  it("keeps the disable and enable workflow ID sets strictly equal", () => {
    assertGatedMappings(
      disableIdsByFilename,
      enableIdsByFilename,
      gatedWorkflows,
    );
    const disableIds = [...disableIdsByFilename.values()].sort();
    const enableIds = [...enableIdsByFilename.values()].sort();
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
    const inventoriedUnaffected = [...UNAFFECTED_WORKFLOWS]
      .filter(
        (filename) =>
          disableIdsByFilename.has(filename) ||
          enableIdsByFilename.has(filename),
      )
      .sort();
    expect(
      inventoriedUnaffected,
      "Unaffected workflows must not appear in the halt/resume inventory",
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

  it("rejects empty, malformed, and non-bijective inventory fixtures", () => {
    expect(() => parseInventoryBlock("echo no inventory", "disable")).toThrow(
      "Inventory has no disable lines",
    );
    expect(() =>
      parseInventoryBlock(
        "gh api -X PUT repos/example/repo/actions/workflows/123/disable # Triage Issues",
        "disable",
      ),
    ).toThrow("add a .yml filename");
    expect(() =>
      filenameIdMap(
        [
          { id: "123", action: "disable", filename: "first.yml" },
          { id: "123", action: "disable", filename: "second.yml" },
        ],
        "Fixture",
      ),
    ).toThrow(
      "Fixture inventory reuses workflow ID 123 for first.yml and second.yml",
    );
    expect(() =>
      assertGatedMappings(
        new Map([["first.yml", "123"]]),
        new Map<string, string>(),
        ["first.yml"],
      ),
    ).toThrow("Missing enable workflow ID mapping for first.yml");
  });
});
