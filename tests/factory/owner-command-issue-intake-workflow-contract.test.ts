import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL(
    "../../.github/workflows/owner-command-issue-intake.yml",
    import.meta.url,
  ),
);
const ENABLE_GATE = "vars.OWNER_COMMAND_INTAKE_ENABLED == 'true'";
const DISPATCH_GATE =
  "${{ vars.OWNER_COMMAND_INTAKE_ENABLED == 'true' && needs.intake.outputs.proceed == 'true' && needs.intake.outputs.verb == 'approve' }}";
const EXPECTED_INTAKE_ENV = {
  GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
  GITHUB_REPOSITORY: "${{ github.repository }}",
  TARGET_ISSUE_NUMBER: "${{ github.event.issue.number }}",
  COMMENT_ID: "${{ github.event.comment.id }}",
};
const FORBIDDEN_SOURCE = [
  "task-agent",
  "task-apply",
  "git push",
  "claude-code-action",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "workflow_dispatch",
  "id-token",
  "issues: write",
  "/actions/workflows/",
] as const;

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected mapping");
  }
  return value as Mapping;
}

function parseWorkflow(source: string): Mapping {
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error("invalid workflow YAML");
  return mapping(document.toJS());
}

function contractFailures(source: string): string[] {
  const failures: string[] = [];
  for (const forbidden of FORBIDDEN_SOURCE) {
    if (source.includes(forbidden)) failures.push(`forbidden:${forbidden}`);
  }
  const parsed = parseWorkflow(source);
  const jobs = mapping(parsed.jobs);
  if (JSON.stringify(parsed.on) !== JSON.stringify({
    issue_comment: { types: ["created"] },
  })) failures.push("trigger");
  if (JSON.stringify(parsed.permissions) !== JSON.stringify({})) {
    failures.push("root-permissions");
  }
  if (JSON.stringify(Object.keys(jobs)) !== JSON.stringify([
    "intake",
    "dispatch-approve",
  ])) {
    failures.push("job-set");
  }
  const intake = mapping(jobs.intake);
  if (intake.if !== ENABLE_GATE) failures.push("gate:intake");
  if (JSON.stringify(intake.permissions) !== JSON.stringify({
    contents: "read",
    issues: "read",
  })) failures.push("intake-permissions");
  if (JSON.stringify(mapping(intake.outputs)) !== JSON.stringify({
    proceed: "${{ steps.intake.outputs.proceed }}",
    verb: "${{ steps.intake.outputs.verb }}",
    approved_revision: "${{ steps.intake.outputs.approved_revision }}",
  })) failures.push("intake-outputs");
  const rawSteps = intake.steps;
  if (!Array.isArray(rawSteps)) {
    failures.push("steps");
    return failures;
  }
  const steps = rawSteps.map(mapping);
  const checkout = steps[0];
  const setup = steps[1];
  const entrypoint = steps[2];
  if (
    steps.length !== 3 ||
    checkout?.uses !==
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0" ||
    JSON.stringify(checkout.with) !== JSON.stringify({
      "persist-credentials": false,
      "sparse-checkout": "scripts/factory",
    })
  ) failures.push("checkout");
  if (
    setup?.uses !==
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020" ||
    JSON.stringify(setup.with) !== JSON.stringify({ "node-version": "22" })
  ) failures.push("setup-node");
  if (
    entrypoint?.id !== "intake" ||
    entrypoint.run !==
      "node --experimental-strip-types scripts/factory/intake-owner-command-issue.mts" ||
    JSON.stringify(mapping(entrypoint.env)) !==
      JSON.stringify(EXPECTED_INTAKE_ENV)
  ) failures.push("entrypoint");
  const dispatch = mapping(jobs["dispatch-approve"]);
  if (dispatch.needs !== "intake") failures.push("dispatch-needs");
  if (dispatch.if !== DISPATCH_GATE) failures.push("gate:dispatch-approve");
  if (JSON.stringify(mapping(dispatch.permissions)) !== JSON.stringify({
    actions: "write",
  })) failures.push("dispatch-permissions");
  const dispatchSteps = dispatch.steps;
  if (!Array.isArray(dispatchSteps) || dispatchSteps.length !== 1) {
    failures.push("dispatch-steps");
  } else {
    const step = mapping(dispatchSteps[0]);
    if (
      step.name !== "Dispatch triage readiness promotion" ||
      JSON.stringify(mapping(step.env)) !== JSON.stringify({
        GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      }) ||
      step.run !==
        "gh workflow run triage-issues.yml --repo ${{ github.repository }} --ref main -f issue_number=${{ github.event.issue.number }} -f triage_mode=readiness -f approved_revision=${{ needs.intake.outputs.approved_revision }}"
    ) failures.push("dispatch-step");
  }
  return failures;
}

const SOURCE = readFileSync(WORKFLOW_PATH, "utf8");

describe("owner command issue intake workflow contract", () => {
  it("has no task, contents-write, model, or broad credential path", () => {
    expect(contractFailures(SOURCE)).toEqual([]);
  });

  it.each(FORBIDDEN_SOURCE)(
    "M-KEYSTONE-A catches injected forbidden source %s",
    (forbidden) => {
      expect(contractFailures(`${SOURCE}\n# ${forbidden}\n`))
        .toContain(`forbidden:${forbidden}`);
    },
  );

  it("M-DARK gates intake and approve dispatch on the shared enable variable", () => {
    const jobs = mapping(parseWorkflow(SOURCE).jobs);
    expect(mapping(jobs.intake).if).toBe(ENABLE_GATE);
    expect(mapping(jobs["dispatch-approve"]).if).toBe(DISPATCH_GATE);
    expect(String(mapping(jobs["dispatch-approve"]).if)).not.toContain(
      "FACTORY_PAUSED",
    );
  });

  it("M-DARK catches a removed or widened job gate", () => {
    const removed = SOURCE.replace(`    if: ${ENABLE_GATE}\n`, "");
    const widened = SOURCE.replace(
      ENABLE_GATE,
      `${ENABLE_GATE} || github.actor == 'attacker'`,
    );
    expect(contractFailures(removed)).toContain("gate:intake");
    expect(contractFailures(widened)).toContain("gate:intake");
  });

  it("dispatch-approve is approve-only, actions-write-only, and passes readiness plus the captured revision", () => {
    const jobs = mapping(parseWorkflow(SOURCE).jobs);
    const intake = mapping(jobs.intake);
    const dispatch = mapping(jobs["dispatch-approve"]);
    expect(mapping(intake.outputs)).toEqual({
      proceed: "${{ steps.intake.outputs.proceed }}",
      verb: "${{ steps.intake.outputs.verb }}",
      approved_revision: "${{ steps.intake.outputs.approved_revision }}",
    });
    expect(dispatch.needs).toBe("intake");
    expect(dispatch.if).toBe(DISPATCH_GATE);
    expect(mapping(dispatch.permissions)).toEqual({ actions: "write" });
    const steps = (dispatch.steps as unknown[]).map(mapping);
    expect(String(steps[0]?.run)).toContain("triage_mode=readiness");
    expect(String(steps[0]?.run)).toContain(
      "approved_revision=${{ needs.intake.outputs.approved_revision }}",
    );
    expect(String(steps[0]?.run)).not.toContain("implement-ready-issues.yml");
    expect(SOURCE).not.toContain("OWNER_TASK_APPLY_ENABLED:");
  });

  it("pins read-only permissions and catches either write mutation", () => {
    const jobWrite = SOURCE.replace("      contents: read", "      contents: write");
    const issueWrite = SOURCE.replace("      issues: read", "      issues: write");
    expect(contractFailures(jobWrite)).toContain("intake-permissions");
    expect(contractFailures(issueWrite)).toContain("intake-permissions");
  });

  it("pins the created-comment trigger, checkout confinement, and entrypoint", () => {
    const parsed = parseWorkflow(SOURCE);
    const intake = mapping(mapping(parsed.jobs).intake);
    const steps = (intake.steps as unknown[]).map(mapping);
    expect(parsed.on).toEqual({ issue_comment: { types: ["created"] } });
    expect(steps[0]).toEqual(expect.objectContaining({
      uses: "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      with: {
        "persist-credentials": false,
        "sparse-checkout": "scripts/factory",
      },
    }));
    expect(steps[2]).toEqual(expect.objectContaining({
      id: "intake",
      run: "node --experimental-strip-types scripts/factory/intake-owner-command-issue.mts",
    }));
    // MUTATION-CHECK: exact equality kills widening the intake env to carry
    // raw webhook content such as COMMENT_BODY from github.event.comment.body.
    expect(mapping(steps[2]!.env)).toEqual(EXPECTED_INTAKE_ENV);
  });

  it("catches a dispatch trigger mutation", () => {
    const mutated = SOURCE.replace(
      "  issue_comment:\n    types: [created]",
      "  workflow_dispatch:",
    );
    expect(contractFailures(mutated)).toEqual(expect.arrayContaining([
      "forbidden:workflow_dispatch",
      "trigger",
    ]));
  });

  it("catches checkout, setup, and entrypoint mutations", () => {
    const persisted = SOURCE.replace(
      "persist-credentials: false",
      "persist-credentials: true",
    );
    const broadCheckout = SOURCE.replace(
      "sparse-checkout: scripts/factory",
      "sparse-checkout: .",
    );
    const changedNode = SOURCE.replace('node-version: "22"', 'node-version: "23"');
    const changedEntrypoint = SOURCE.replace(
      "intake-owner-command-issue.mts",
      "other-entrypoint.mts",
    );
    const contentEnv = SOURCE.replace(
      "          COMMENT_ID: ${{ github.event.comment.id }}",
      "          COMMENT_ID: ${{ github.event.comment.id }}\n" +
        "          COMMENT_BODY: ${{ github.event.comment.body }}",
    );
    expect(contractFailures(persisted)).toContain("checkout");
    expect(contractFailures(broadCheckout)).toContain("checkout");
    expect(contractFailures(changedNode)).toContain("setup-node");
    expect(contractFailures(changedEntrypoint)).toContain("entrypoint");
    expect(contractFailures(contentEnv)).toContain("entrypoint");
  });
});
