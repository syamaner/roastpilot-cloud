import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/triage-issues.yml", import.meta.url),
);

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Mapping;
}

function parseWorkflow(): Mapping {
  const document = parseDocument(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(document.errors).toEqual([]);
  return document.toJS() as Mapping;
}

function namedStep(job: Mapping, name: string): Mapping {
  const steps = job.steps;
  expect(Array.isArray(steps)).toBe(true);
  const step = (steps as unknown[]).find(
    (candidate) => mapping(candidate).name === name,
  );
  expect(step, `missing workflow step ${name}`).toBeDefined();
  return mapping(step);
}

describe("triage factory App mint isolation", () => {
  it("mints only issues:write in the apply job with the pinned fail-open action", () => {
    const jobs = mapping(parseWorkflow().jobs);
    const apply = mapping(jobs.apply);
    const mint = namedStep(apply, "Mint factory App token");

    expect(mint).toMatchObject({
      id: "factory_token",
      if: "${{ vars.FACTORY_PUBLISHER_APP_ID != '' }}",
      "continue-on-error": true,
      uses:
        "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349",
    });
    expect(mapping(mint.with)).toEqual({
      "app-id": "${{ vars.FACTORY_PUBLISHER_APP_ID }}",
      "private-key": "${{ secrets.FACTORY_PUBLISHER_PRIVATE_KEY }}",
      "permission-issues": "write",
    });
    expect(mapping(mint.with)).not.toHaveProperty("permission-contents");
    expect(mapping(mint.with)).not.toHaveProperty("permission-pull-requests");
    expect(mapping(apply.permissions)).toEqual({
      contents: "read",
      issues: "write",
    });
  });

  it("keeps every App credential reference out of the read-only triage agent job", () => {
    const jobs = mapping(parseWorkflow().jobs);
    const triage = mapping(jobs.triage);
    const apply = mapping(jobs.apply);
    const serializedTriage = JSON.stringify(triage);
    const forbiddenAgentFragments = [
      "create-github-app-token",
      "FACTORY_PUBLISHER_PRIVATE_KEY",
      "FACTORY_APP_TOKEN",
      "steps.factory_token.outputs.token",
    ];

    for (const fragment of forbiddenAgentFragments) {
      expect(serializedTriage).not.toContain(fragment);
    }
    expect(mapping(triage.permissions)).toEqual({
      contents: "read",
      issues: "read",
    });
    expect(mapping(namedStep(triage, "Run the triage skill").with)).toMatchObject({
      github_token: "${{ secrets.GITHUB_TOKEN }}",
      allowed_bots: "",
    });

    const mintJobs = Object.entries(jobs)
      .filter(([, job]) => JSON.stringify(job).includes("create-github-app-token"))
      .map(([name]) => name);
    expect(mintJobs).toEqual(["apply"]);
    expect(JSON.stringify(apply)).toContain("FACTORY_PUBLISHER_PRIVATE_KEY");
  });

  it("surfaces the fail-open consequence and wires only the apply script env", () => {
    const jobs = mapping(parseWorkflow().jobs);
    const apply = mapping(jobs.apply);
    const warning = namedStep(apply, "Warn if triage labels use GITHUB_TOKEN");
    const applyVerdict = namedStep(
      apply,
      "Validate and apply the triage verdict",
    );

    expect(warning.if).toBe(
      "${{ steps.factory_token.outcome != 'success' }}",
    );
    expect(mapping(warning.env)).toEqual({
      MINT_OUTCOME: "${{ steps.factory_token.outcome }}",
    });
    expect(String(warning.run)).toContain("::warning::");
    expect(String(warning.run)).toContain(
      "ready-to-spec will be applied by GITHUB_TOKEN",
    );
    expect(String(warning.run)).toContain("story-planner will not auto-fire");
    expect(mapping(applyVerdict.env)).toMatchObject({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      FACTORY_APP_TOKEN: "${{ steps.factory_token.outputs.token }}",
    });
  });
});
