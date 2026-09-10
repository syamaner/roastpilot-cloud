import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/dev-snowflake-contract.yml", import.meta.url),
);
const WORKFLOWS_DIRECTORY = fileURLToPath(
  new URL("../../.github/workflows/", import.meta.url),
);
const ACTIONS_DIRECTORY = fileURLToPath(
  new URL("../../.github/actions/", import.meta.url),
);
const RELAXATION_FLAG = "--allow-missing-manifest-grants";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected mapping");
  }
  return value as Mapping;
}

function parseWorkflow(path: string): Mapping {
  return mapping(parse(readFileSync(path, "utf8")));
}

function workflowSteps(workflow: Mapping): Mapping[] {
  return Object.values(mapping(workflow.jobs)).flatMap((jobValue) => {
    const steps = mapping(jobValue).steps;
    if (!Array.isArray(steps)) return [];
    return steps.map(mapping);
  });
}

function jobSteps(workflow: Mapping, jobId: string): Mapping[] {
  const steps = mapping(mapping(workflow.jobs)[jobId]).steps;
  if (!Array.isArray(steps)) throw new Error(`job ${jobId} has no steps`);
  return steps.map(mapping);
}

const source = readFileSync(WORKFLOW_PATH, "utf8");
const workflow = parseWorkflow(WORKFLOW_PATH);
const contractCheckSteps = jobSteps(workflow, "contract-check");

function namedStep(id: string): Mapping {
  const step = contractCheckSteps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`missing step ${id}`);
  return step;
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("DEV Snowflake contract workflow", () => {
  it("W-1 relaxes only the pre-deploy grants invocation", () => {
    expect(namedStep("grants").run).toBe(
      "python3 assert_dev_ci_grants.py --allow-missing-manifest-grants",
    );
  });

  it("W-2 keeps the post-deploy grants invocation strict", () => {
    const run = namedStep("grants-post").run;
    expect(run).toBe("python3 assert_dev_ci_grants.py");
    expect(run).not.toContain("allow-missing");
  });

  it("W-3 uses the relaxation flag at exactly one grants-audit call site", () => {
    const flaggedRuns = readdirSync(WORKFLOWS_DIRECTORY)
      .filter((name) => /\.ya?ml$/.test(name))
      .flatMap((name) =>
        workflowSteps(parseWorkflow(`${WORKFLOWS_DIRECTORY}/${name}`)),
      )
      .map((step) => step.run)
      .filter(
        (run): run is string =>
          typeof run === "string" && run.includes("assert_dev_ci_grants.py"),
      )
      .filter((run) => run.includes(RELAXATION_FLAG));

    expect(flaggedRuns).toEqual([
      "python3 assert_dev_ci_grants.py --allow-missing-manifest-grants",
    ]);

    const rawOccurrences = [WORKFLOWS_DIRECTORY, ACTIONS_DIRECTORY]
      .flatMap(filesUnder)
      .map((path) => readFileSync(path, "utf8"))
      .reduce(
        (count, contents) => count + contents.split(RELAXATION_FLAG).length - 1,
        0,
      );
    expect(rawOccurrences).toBe(1);
  });

  it("W-4 preserves the post-deploy audit gate", () => {
    expect(namedStep("grants-post").if).toBe(
      "always() && steps.grants.outcome == 'success'",
    );
  });

  it("W-5 keeps all three contract gates failure-propagating", () => {
    for (const id of ["grants", "deploy", "grants-post"]) {
      expect(namedStep(id)["continue-on-error"]).toBeUndefined();
    }
  });

  it("W-6 keeps pre-audit, deploy, and post-audit in relative order", () => {
    expect(
      contractCheckSteps
        .map((step) => step.id)
        .filter((id) => ["grants", "deploy", "grants-post"].includes(String(id))),
    ).toEqual(["grants", "deploy", "grants-post"]);
  });

  it("keeps each contract gate step id unique across the workflow", () => {
    for (const id of ["grants", "deploy", "grants-post"]) {
      expect(
        workflowSteps(workflow).filter((candidate) => candidate.id === id),
      ).toHaveLength(1);
    }
  });

  it("pins both grants audits to the Snowflake script directory", () => {
    expect(namedStep("grants")["working-directory"]).toBe("snowflake");
    expect(namedStep("grants-post")["working-directory"]).toBe("snowflake");
  });

  it("W-7 keeps the pre-audit and deploy unconditionally eligible", () => {
    expect(namedStep("grants").if).toBeUndefined();
    expect(namedStep("deploy").if).toBeUndefined();
  });

  it("W-8 keeps contract-check failures job-fatal", () => {
    expect(
      mapping(mapping(workflow.jobs)["contract-check"])["continue-on-error"],
    ).toBeUndefined();
  });
});

describe("ref boundary (#437, D-437-A)", () => {
  it("T-437-1..4 pins the code-visible ref boundary", () => {
    const contractCheck = mapping(mapping(workflow.jobs)["contract-check"]);

    expect(contractCheck.environment).toBe("dev-snowflake-ci");
    expect(mapping(workflow.on)).toEqual({ workflow_dispatch: {} });
    expect(source).not.toContain("github.ref");
    expect(source).not.toContain("github.head_ref");
    expect(source).toContain(
      "protected-branches-only deployment-branch policy plus a required reviewer",
    );
    expect(source).toContain(
      "protected-branches-only is effectively main-only",
    );
    expect(source).toContain(
      "a future branch gaining branch protection would inherit access to the writable key automatically",
    );
    expect(source).toContain("test pins only the code-visible surface");
  });

  it("T-437-5 fails closed when another trigger is added", () => {
    const mutatedSource = source.replace(
      "  workflow_dispatch: {}",
      "  workflow_dispatch: {}\n  push: {}",
    );
    const mutatedWorkflow = mapping(parse(mutatedSource));

    expect(() =>
      expect(mapping(mutatedWorkflow.on)).toEqual({ workflow_dispatch: {} }),
    ).toThrow();
  });

  it("T-437-6 fails closed when contract-check loses its Environment", () => {
    const mutatedSource = source.replace(
      "    environment: dev-snowflake-ci\n",
      "",
    );
    const mutatedWorkflow = mapping(parse(mutatedSource));

    expect(() =>
      expect(
        mapping(mapping(mutatedWorkflow.jobs)["contract-check"]).environment,
      ).toBe("dev-snowflake-ci"),
    ).toThrow();
  });

  it("T-437-7 fails closed when an in-workflow ref expression appears", () => {
    for (const forbiddenRef of ["github.ref", "github.head_ref"]) {
      const mutatedSource = `${source}\n# ${forbiddenRef}\n`;

      expect(() => expect(mutatedSource).not.toContain(forbiddenRef)).toThrow();
    }
  });

  it("T-437-8 fails closed when a decision substring is removed", () => {
    const decisionSubstring = "test pins only the code-visible surface";
    const mutatedSource = source.replace(decisionSubstring, "");

    expect(() =>
      expect(mutatedSource).toContain(decisionSubstring),
    ).toThrow();
  });
});
