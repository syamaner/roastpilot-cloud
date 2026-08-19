import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/implement-ready-issues.yml", import.meta.url),
);
const PUBLISHER_PATH = fileURLToPath(
  new URL("../../scripts/factory/publish-implement-patch.mts", import.meta.url),
);

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected mapping");
  }
  return value as Mapping;
}

function workflow(): Mapping {
  const document = parseDocument(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(document.errors).toEqual([]);
  return mapping(document.toJS());
}

function job(name: string): Mapping {
  return mapping(mapping(workflow().jobs)[name]);
}

function steps(name: string): Mapping[] {
  const value = job(name).steps;
  if (!Array.isArray(value)) {
    throw new Error(`${name} steps are not an array`);
  }
  return value.map(mapping);
}

function step(name: string, stepName: string): Mapping {
  const found = steps(name).find((candidate) => candidate.name === stepName);
  if (!found) {
    throw new Error(`missing ${name} step ${stepName}`);
  }
  return found;
}

describe("implement cost workflow contract", () => {
  it("W1: declares both bounded extractor job outputs", () => {
    expect(mapping(job("implement").outputs)).toMatchObject({
      cost_usd: "${{ steps.extract-implement-cost.outputs.cost_usd }}",
      num_turns: "${{ steps.extract-implement-cost.outputs.num_turns }}",
    });
  });

  it("W2/G6/F2: restores trusted scripts, then extracts before Run local gates", () => {
    const names = steps("implement").map((candidate) => candidate.name);
    const restoreIndex = names.indexOf("Restore trusted implement cost extractor");
    const extractorIndex = names.indexOf("Extract bounded implement cost");
    expect(restoreIndex).toBeGreaterThan(-1);
    expect(extractorIndex).toBeGreaterThan(restoreIndex);
    const restore = step("implement", "Restore trusted implement cost extractor");
    expect(mapping(restore.env).DISPATCH_SHA).toBe("${{ github.sha }}");
    const restoreRun = String(restore.run);
    expect(restoreRun).toContain("set -euo pipefail");
    expect(restoreRun).toContain(
      "for f in scripts/factory/extract-implement-cost.mts scripts/factory/implement-cost-logic.mts; do",
    );
    expect(restoreRun).toContain('rm -f "$f"');
    expect(restoreRun).toContain('git show "$DISPATCH_SHA:$f" > "$f"');
    expect(restoreRun).not.toContain("git checkout");
    expect(restoreRun).not.toContain("${{");
    expect(restoreRun).not.toContain("github.sha");
    expect(names.indexOf("Extract bounded implement cost")).toBeGreaterThan(-1);
    expect(extractorIndex).toBeLessThan(
      names.indexOf("Run local gates (independent of the agent's own self-report)"),
    );
  });

  it("W3: passes execution_file only through env, never through run", () => {
    const extractor = step("implement", "Extract bounded implement cost");
    expect(mapping(extractor.env).INPUT_EXECUTION_FILE).toBe(
      "${{ steps.implement.outputs.execution_file }}",
    );
    expect(mapping(extractor.env).INPUT_COST_OUTPUT_DIR).toBe(
      "${{ runner.temp }}/implement-cost",
    );
    expect(extractor.run).toBe(
      "node --experimental-strip-types scripts/factory/extract-implement-cost.mts",
    );
    expect(String(extractor.run)).not.toContain("execution_file");
  });

  it("W4/G7: keeps implement permissions exactly read-only", () => {
    expect(job("implement").permissions).toEqual({
      contents: "read",
      issues: "read",
    });
  });

  it("W5/G7: introduces no implement-job secret beyond the two existing action inputs", () => {
    const references = JSON.stringify(job("implement")).match(
      /secrets\.[A-Za-z0-9_]+/g,
    );
    expect([...new Set(references)].sort()).toEqual([
      "secrets.CLAUDE_CODE_OAUTH_TOKEN",
      "secrets.GITHUB_TOKEN",
    ]);
  });

  it("W6/G8: uploads only the bounded cost file and patch, never execution_file or transcript", () => {
    const uploads = steps("implement").filter(
      (candidate) =>
        typeof candidate.uses === "string" &&
        candidate.uses.startsWith("actions/upload-artifact@"),
    );
    expect(
      uploads.map((candidate) => mapping(candidate.with).path),
    ).toEqual([
      "${{ runner.temp }}/implement-cost/cost.json",
      "patch-output/patch.diff",
    ]);
    const costPath = mapping(uploads[0].with).path;
    expect(costPath).toContain("runner.temp");
    expect(costPath).not.toBe("cost.json");
    const serialized = JSON.stringify(uploads);
    expect(serialized).not.toContain("execution_file");
    expect(serialized).not.toContain("transcript");
  });

  it("W7: threads both outputs and re-validates them authoritatively", () => {
    const publisher = step("publish", "Validate and publish the implement patch");
    expect(mapping(publisher.env)).toMatchObject({
      IMPLEMENT_COST_USD: "${{ needs.implement.outputs.cost_usd }}",
      IMPLEMENT_NUM_TURNS: "${{ needs.implement.outputs.num_turns }}",
    });
    const source = readFileSync(PUBLISHER_PATH, "utf8");
    expect(source).toContain("validateImplementCostOutputs(");
    expect(source).toContain("process.env.IMPLEMENT_COST_USD");
    expect(source).toContain("process.env.IMPLEMENT_NUM_TURNS");
  });

  it("W8: uploads implement-cost only after trusted extraction succeeds", () => {
    const upload = step("implement", "Upload implement cost artifact");
    expect(upload.if).toBe(
      "steps.extract-implement-cost.outcome == 'success'",
    );
    expect(upload["continue-on-error"]).toBe(true);
    expect(mapping(upload.with)).toMatchObject({
      name: "implement-cost",
      path: "${{ runner.temp }}/implement-cost/cost.json",
    });
  });

  it("F3: all cost-observability steps are explicitly non-blocking", () => {
    for (const name of [
      "Set up Node for implement cost extraction",
      "Restore trusted implement cost extractor",
      "Extract bounded implement cost",
      "Upload implement cost artifact",
    ]) {
      expect(step("implement", name)["continue-on-error"], name).toBe(true);
    }
  });
});
