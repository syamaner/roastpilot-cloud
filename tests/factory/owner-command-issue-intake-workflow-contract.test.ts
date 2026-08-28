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
const APPROVE_GATE =
  "${{ vars.OWNER_COMMAND_INTAKE_ENABLED == 'true' && needs.intake.outputs.proceed == 'true' && needs.intake.outputs.verb == 'approve' }}";
const DISPATCH_COMMAND =
  "gh workflow run triage-issues.yml --repo ${{ github.repository }} --ref main -f issue_number=${{ github.event.issue.number }} -f triage_mode=readiness -f approved_revision=${{ needs.intake.outputs.approved_revision }}";
const EXPECTED_INTAKE_OUTPUTS = {
  proceed: "${{ steps.intake.outputs.proceed }}",
  verb: "${{ steps.intake.outputs.verb }}",
  approved_revision: "${{ steps.intake.outputs.approved_revision }}",
};
const EXPECTED_INTAKE_ENV = {
  GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
  GITHUB_REPOSITORY: "${{ github.repository }}",
  TARGET_ISSUE_NUMBER: "${{ github.event.issue.number }}",
  COMMENT_ID: "${{ github.event.comment.id }}",
};
const FORBIDDEN_EXECUTABLE_SOURCE = [
  "task-agent",
  "task-apply",
  "OWNER_TASK_APPLY_ENABLED",
  "contents: write",
  "git push",
  "claude-code-action",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "workflow_dispatch",
  "id-token",
  "issues: write",
  "/actions/workflows/",
  "implement-ready-issues.yml",
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
  const parsed = parseWorkflow(source);
  const executableSource = JSON.stringify(parsed);
  for (const forbidden of FORBIDDEN_EXECUTABLE_SOURCE) {
    const structuralForm = forbidden.replace(": ", '\":\"');
    if (
      executableSource.includes(forbidden) ||
      executableSource.includes(structuralForm)
    ) {
      failures.push(`forbidden:${forbidden}`);
    }
  }
  const jobs = mapping(parsed.jobs);
  if (JSON.stringify(parsed.on) !== JSON.stringify({
    issue_comment: { types: ["created"] },
  })) failures.push("trigger");
  if (JSON.stringify(parsed.permissions) !== JSON.stringify({})) {
    failures.push("root-permissions");
  }
  if (
    JSON.stringify(Object.keys(jobs)) !==
    JSON.stringify(["intake", "dispatch-approve"])
  ) {
    failures.push("job-set");
  }
  const intake = mapping(jobs.intake);
  if (intake.if !== ENABLE_GATE) failures.push("gate:intake");
  if (
    JSON.stringify(intake.outputs) !== JSON.stringify(EXPECTED_INTAKE_OUTPUTS)
  ) failures.push("intake-outputs");
  if (JSON.stringify(intake.permissions) !== JSON.stringify({
    contents: "read",
    issues: "read",
  })) failures.push("intake-permissions");
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
  if (dispatch.if !== APPROVE_GATE) failures.push("gate:dispatch-approve");
  if (JSON.stringify(dispatch.permissions) !== JSON.stringify({
    actions: "write",
  })) failures.push("dispatch-permissions");
  const rawDispatchSteps = dispatch.steps;
  if (!Array.isArray(rawDispatchSteps)) {
    failures.push("dispatch-steps");
    return failures;
  }
  const dispatchSteps = rawDispatchSteps.map(mapping);
  const dispatchStep = dispatchSteps[0];
  if (
    dispatchSteps.length !== 1 ||
    dispatchStep?.run !== DISPATCH_COMMAND ||
    JSON.stringify(mapping(dispatchStep?.env)) !== JSON.stringify({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
    })
  ) failures.push("dispatch-step");

  const actionWriteJobs = Object.entries(jobs)
    .filter(([, rawJob]) => mapping(mapping(rawJob).permissions).actions === "write")
    .map(([jobName]) => jobName);
  if (JSON.stringify(actionWriteJobs) !== JSON.stringify(["dispatch-approve"])) {
    failures.push("actions-write-scope");
  }
  return failures;
}

const SOURCE = readFileSync(WORKFLOW_PATH, "utf8");

describe("owner command issue intake workflow contract", () => {
  it("M-KEYSTONE-A has only the bounded approve dispatch write path", () => {
    expect(contractFailures(SOURCE)).toEqual([]);
  });

  it.each(FORBIDDEN_EXECUTABLE_SOURCE)(
    "M-KEYSTONE-A catches injected forbidden source %s",
    (forbidden) => {
      expect(contractFailures(
        `${SOURCE}\nforbidden-test: ${JSON.stringify(forbidden)}\n`,
      ))
        .toContain(`forbidden:${forbidden}`);
    },
  );

  it("M-DARK gates intake and the approve dispatch exactly", () => {
    const jobs = mapping(parseWorkflow(SOURCE).jobs);
    expect(mapping(jobs.intake).if).toBe(ENABLE_GATE);
    expect(mapping(jobs["dispatch-approve"]).if).toBe(APPROVE_GATE);
    expect(String(mapping(jobs["dispatch-approve"]).if)).not.toContain(
      "FACTORY_PAUSED",
    );
    expect(SOURCE).toContain("Activation checklist");
    expect(SOURCE).toContain("availability-only dispatch behavior");
  });

  it("M-DARK catches a removed or widened job gate", () => {
    const removed = SOURCE.replace(`    if: ${APPROVE_GATE}\n`, "");
    const widened = SOURCE.replace(
      APPROVE_GATE,
      `${APPROVE_GATE} || github.actor == 'attacker'`,
    );
    expect(contractFailures(removed)).toContain("gate:dispatch-approve");
    expect(contractFailures(widened)).toContain("gate:dispatch-approve");
  });

  it("pins read-only permissions and catches either write mutation", () => {
    const jobWrite = SOURCE.replace("      contents: read", "      contents: write");
    const issueWrite = SOURCE.replace("      issues: read", "      issues: write");
    expect(contractFailures(jobWrite)).toContain("intake-permissions");
    expect(contractFailures(issueWrite)).toContain("intake-permissions");
  });

  it("pins dispatch dependencies and exact actions-only permissions", () => {
    const parsed = parseWorkflow(SOURCE);
    const dispatch = mapping(mapping(parsed.jobs)["dispatch-approve"]);
    expect(dispatch.needs).toBe("intake");
    expect(dispatch.permissions).toEqual({ actions: "write" });

    const contentsWrite = SOURCE.replace(
      "      actions: write",
      "      actions: write\n      contents: write",
    );
    const issuesWrite = SOURCE.replace(
      "      actions: write",
      "      actions: write\n      issues: write",
    );
    expect(contractFailures(contentsWrite)).toContain("dispatch-permissions");
    expect(contractFailures(issuesWrite)).toContain("dispatch-permissions");
    expect(contractFailures(contentsWrite)).toContain(
      "forbidden:contents: write",
    );
    expect(contractFailures(issuesWrite)).toContain("forbidden:issues: write");
  });

  it("M-DISPATCH pins triage readiness and trusted issue provenance", () => {
    const dispatch = mapping(
      mapping(parseWorkflow(SOURCE).jobs)["dispatch-approve"],
    );
    const steps = (dispatch.steps as unknown[]).map(mapping);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual(expect.objectContaining({
      run: DISPATCH_COMMAND,
      env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
    }));

    const wrongWorkflow = SOURCE.replace(
      "workflow run triage-issues.yml",
      "workflow run implement-ready-issues.yml",
    );
    const wrongMode = SOURCE.replace("triage_mode=readiness", "triage_mode=full");
    const untrustedIssue = SOURCE.replace(
      "issue_number=${{ github.event.issue.number }}",
      "issue_number=${{ github.event.comment.body }}",
    );
    const missingRevision = SOURCE.replace(
      " -f approved_revision=${{ needs.intake.outputs.approved_revision }}",
      "",
    );
    const untrustedRevision = SOURCE.replace(
      "approved_revision=${{ needs.intake.outputs.approved_revision }}",
      "approved_revision=${{ github.event.issue.body }}",
    );
    expect(contractFailures(wrongWorkflow)).toContain("dispatch-step");
    expect(contractFailures(wrongMode)).toContain("dispatch-step");
    expect(contractFailures(untrustedIssue)).toContain("dispatch-step");
    expect(contractFailures(missingRevision)).toContain("dispatch-step");
    expect(contractFailures(untrustedRevision)).toContain("dispatch-step");
  });

  it("M-WF exports and dispatches the approve-only revision binding", () => {
    const jobs = mapping(parseWorkflow(SOURCE).jobs);
    expect(mapping(jobs.intake).outputs).toEqual(EXPECTED_INTAKE_OUTPUTS);
    expect(
      String(
        ((mapping(jobs["dispatch-approve"]).steps as unknown[]).map(mapping)[0]
          ?.run),
      ),
    ).toContain(
      "approved_revision=${{ needs.intake.outputs.approved_revision }}",
    );
    expect(mapping(jobs["dispatch-approve"]).if).toBe(APPROVE_GATE);
  });

  it("keeps respec inert by requiring the approve verb", () => {
    expect(APPROVE_GATE).toContain("needs.intake.outputs.verb == 'approve'");
    expect(APPROVE_GATE).not.toContain("respec");
    const respecGate = SOURCE.replace(
      "needs.intake.outputs.verb == 'approve'",
      "needs.intake.outputs.verb == 'respec'",
    );
    expect(contractFailures(respecGate)).toContain("gate:dispatch-approve");
  });

  it("keeps intake read-only and scopes actions write to dispatch only", () => {
    const jobs = mapping(parseWorkflow(SOURCE).jobs);
    expect(mapping(jobs.intake).permissions).toEqual({
      contents: "read",
      issues: "read",
    });
    expect(SOURCE.match(/actions: write/gu)).toHaveLength(1);
    expect(mapping(jobs["dispatch-approve"]).permissions).toEqual({
      actions: "write",
    });

    const intakeActionWrite = SOURCE.replace(
      "      issues: read",
      "      issues: read\n      actions: write",
    );
    expect(contractFailures(intakeActionWrite)).toEqual(expect.arrayContaining([
      "intake-permissions",
      "actions-write-scope",
    ]));
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
