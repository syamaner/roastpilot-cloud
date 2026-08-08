import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/codex-verdict-status.yml", import.meta.url),
);
const ENTRYPOINT_PATH = fileURLToPath(
  new URL("../../scripts/factory/publish-codex-verdict-status.mts", import.meta.url),
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

function job(name = "post-advisory-status"): Mapping {
  return mapping(mapping(workflow().jobs)[name]);
}

function steps(jobName = "post-advisory-status"): Mapping[] {
  const value = job(jobName).steps;
  if (!Array.isArray(value)) throw new Error("job has no steps");
  return value.map(mapping);
}

function allSteps(): Mapping[] {
  return Object.keys(mapping(workflow().jobs)).flatMap((jobName) => steps(jobName));
}

function namedStep(name: string): Mapping {
  const found = steps().find((step) => step.name === name);
  if (!found) throw new Error(`missing step ${name}`);
  return found;
}

function environmentReadNames(source: string): string[] {
  const names = [
    ...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/gu),
    ...source.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/gu),
    ...source.matchAll(/requireEnv\("([A-Z][A-Z0-9_]*)"\)/gu),
  ].map((match) => match[1]);
  for (const destructuring of source.matchAll(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env/gu,
  )) {
    names.push(...[...destructuring[1].matchAll(
      /(?:^|,)\s*([A-Z][A-Z0-9_]*)/gu,
    )].map((match) => match[1]));
  }
  return names;
}

describe("Codex advisory-status workflow contract", () => {
  it("W1 pins the dark double gate byte-for-byte", () => {
    const expectedGate =
      "(github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main') && vars.CODEX_ADVISORY_STATUS_ENABLED == 'true' && vars.FACTORY_PAUSED != 'true'";
    expect(job("resolve-trusted-revision").if).toBe(expectedGate);
    expect(job().if).toBe(expectedGate);
  });

  it("W2 pins default-deny and the exact four job scopes", () => {
    expect(workflow().permissions).toEqual({});
    expect(job().permissions).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "read",
      statuses: "write",
    });
  });

  it("W3 pins both actions to the reviewed 40-hex revisions", () => {
    expect(steps().filter((step) => typeof step.uses === "string")
      .map((step) => step.uses)).toEqual([
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    ]);
  });

  it("W4 pins the complete trigger set", () => {
    expect(workflow().on).toEqual({
      pull_request: {
        types: ["opened", "reopened", "ready_for_review", "converted_to_draft", "synchronize"],
      },
      pull_request_review: { types: ["submitted", "edited", "dismissed"] },
      issue_comment: { types: ["created", "edited", "deleted"] },
      workflow_dispatch: {
        inputs: { pr_number: { required: true, type: "string" } },
      },
    });
  });

  it("W5 keeps expressions out of every shell body", () => {
    for (const step of allSteps()) {
      if (typeof step.run === "string") expect(step.run).not.toContain("${{");
    }
  });

  it("W6 pins concurrency without an unsupported queue or environment", () => {
    expect(job().concurrency).toEqual({
      group: "codex-advisory-status-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}",
      "cancel-in-progress": false,
    });
    expect(mapping(job().concurrency)).not.toHaveProperty("queue");
    expect(job()).not.toHaveProperty("environment");
  });

  it("W7 pins the privileged post boundary", () => {
    const post = namedStep("Post advisory Codex verdict status");
    expect(Object.keys(mapping(post.env)).sort()).toEqual([
      "GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "TARGET_PR_NUMBER",
    ]);
    expect(mapping(post.env).GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(post.run).toBe(
      "node --experimental-strip-types scripts/factory/publish-codex-verdict-status.mts",
    );
    expect(post.if).toBe("steps.validate-target.outputs.skip != 'true'");
  });

  it("W8 requires a string PR number for dispatch", () => {
    expect(mapping(mapping(mapping(workflow().on).workflow_dispatch).inputs).pr_number)
      .toEqual({ required: true, type: "string" });
  });

  it("W9 locks Path A and the closed environment grammar", () => {
    const source = readFileSync(ENTRYPOINT_PATH, "utf8");
    expect(source).not.toMatch(
      /reconcileHeadFreshness|statusLedger|TRIGGER_ASSERTED_HEAD_CHANGE|anchored/u,
    );
    expect(new Set(environmentReadNames(`
      process.env.DOT;
      process.env["DOUBLE"];
      process.env['SINGLE'];
      requireEnv("REQUIRED");
      const { SIMPLE, ALIASED: local, DEFAULTED = "fallback" } = process.env;
    `))).toEqual(new Set([
      "DOT", "DOUBLE", "SINGLE", "REQUIRED", "SIMPLE", "ALIASED", "DEFAULTED",
    ]));
    const names = environmentReadNames(source);
    expect(new Set(names)).toEqual(new Set([
      "GH_TOKEN", "GITHUB_REPOSITORY", "TARGET_PR_NUMBER", "GITHUB_RUN_ID",
    ]));
    expect(names.every((name) => [
      "GH_TOKEN", "GITHUB_REPOSITORY", "TARGET_PR_NUMBER", "GITHUB_RUN_ID",
    ].includes(name))).toBe(true);
  });

  it("W10 pins the credential-free trusted-revision resolver output", () => {
    const resolver = job("resolve-trusted-revision");
    expect(resolver.permissions).toEqual({});
    expect(resolver.outputs).toEqual({
      "trusted-sha": "${{ steps.resolve.outputs.trusted-sha }}",
    });
  });

  it("W11 binds the privileged checkout to the trusted resolver output", () => {
    expect(job().needs).toBe("resolve-trusted-revision");
    const checkout = steps().find((step) =>
      step.uses === "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0"
    );
    expect(checkout).toBeDefined();
    expect(mapping(checkout?.with).ref).toBe(
      "${{ needs.resolve-trusted-revision.outputs.trusted-sha }}",
    );
  });
});
