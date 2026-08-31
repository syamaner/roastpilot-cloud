import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const PROBE_PATH = fileURLToPath(new URL("../../.github/workflows/task-agent-read-confinement-probe.yml", import.meta.url));
const OWNER_INTAKE_PATH = fileURLToPath(new URL("../../.github/workflows/owner-command-intake.yml", import.meta.url));

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected mapping");
  return value as Mapping;
}

function parseWorkflow(source: string): Mapping {
  const document = parseDocument(source);
  if (document.errors.length > 0) throw new Error("workflow YAML is malformed");
  return mapping(document.toJS());
}

function steps(workflow: Mapping, jobName: string): Mapping[] {
  const raw = mapping(mapping(workflow.jobs)[jobName]).steps;
  if (!Array.isArray(raw)) throw new Error(`${jobName} has no steps`);
  return raw.map(mapping);
}

function namedStep(workflow: Mapping, jobName: string, name: string): Mapping {
  const found = steps(workflow, jobName).find((step) => step.name === name);
  if (found === undefined) throw new Error(`missing ${jobName} step ${name}`);
  return found;
}

function claudeArgument(action: Mapping, flag: "allowedTools" | "disallowedTools"): string {
  const args = mapping(action.with).claude_args;
  if (typeof args !== "string") throw new Error("missing claude_args");
  const match = args.match(new RegExp(`^--${flag} ("[^"]*")$`, "mu"));
  if (match?.[1] === undefined) throw new Error(`missing --${flag}`);
  return match[1];
}

const probeSource = readFileSync(PROBE_PATH, "utf8");
const ownerSource = readFileSync(OWNER_INTAKE_PATH, "utf8");
const probe = parseWorkflow(probeSource);
const CONTROL_JOB = "probe";
const CONTROL_ACTION = "Exercise the task-agent Read boundary";
const SCOPED_JOB = "probe-scoped";
const SCOPED_ACTION = "Exercise the scoped Read boundary";
const STEP_NAMES = [
  "Checkout repository state",
  "Set up Node.js",
  "Plant non-secret liveness canary",
  "Exercise the task-agent Read boundary",
  "Compute fail-closed confinement verdict",
  "List workspace filenames created during the probe",
  "Remove probe output and scratch",
];
const SCOPED_ALLOWED_TOOLS =
  '"Edit,MultiEdit,Write,Read(./**),Grep(./**),Glob(./**),LS(./**)"';

describe("task-agent read-confinement probe workflow contract", () => {
  it("TC-1 permits workflow_dispatch and no other trigger", () => {
    expect(probe.on).toEqual({ workflow_dispatch: null });
    for (const forbidden of ["issue_comment", "pull_request", "push", "schedule", "workflow_call"]) {
      expect(mapping(probe.on)).not.toHaveProperty(forbidden);
    }
  });

  it("TC-2 byte-pins the action and exact task-agent tool arguments", () => {
    const probeAction = namedStep(probe, "probe", "Exercise the task-agent Read boundary");
    const owner = parseWorkflow(ownerSource);
    const taskAction = namedStep(owner, "task-agent", "Implement the authorised owner task");
    expect(probeAction.uses).toBe(taskAction.uses);
    expect(claudeArgument(probeAction, "allowedTools")).toBe(claudeArgument(taskAction, "allowedTools"));
    expect(claudeArgument(probeAction, "disallowedTools")).toBe(claudeArgument(taskAction, "disallowedTools"));
  });

  it("TC-2a pins the scoped reader grant and forbids bare reader spellings", () => {
    const controlAction = namedStep(probe, CONTROL_JOB, CONTROL_ACTION);
    const scopedAction = namedStep(probe, SCOPED_JOB, SCOPED_ACTION);
    expect(scopedAction.uses).toBe(controlAction.uses);
    expect(claudeArgument(scopedAction, "allowedTools")).toBe(SCOPED_ALLOWED_TOOLS);
    expect(claudeArgument(scopedAction, "disallowedTools")).toBe(
      claudeArgument(controlAction, "disallowedTools"),
    );
    const scopedTools = SCOPED_ALLOWED_TOOLS.slice(1, -1).split(",");
    expect(scopedTools).toEqual([
      "Edit",
      "MultiEdit",
      "Write",
      "Read(./**)",
      "Grep(./**)",
      "Glob(./**)",
      "LS(./**)",
    ]);
    for (const bareReader of ["Read", "Grep", "Glob", "LS"]) {
      expect(scopedTools).not.toContain(bareReader);
    }
  });

  it("TC-3 binds both required action tokens, using the probe-only OAuth secret", () => {
    const action = namedStep(probe, "probe", "Exercise the task-agent Read boundary");
    expect(mapping(action.with)).toMatchObject({
      claude_code_oauth_token: "${{ secrets.PROBE_READ_CONFINEMENT_OAUTH_TOKEN }}",
      github_token: "${{ secrets.GITHUB_TOKEN }}",
      allowed_bots: "",
      show_full_output: false,
    });
  });

  it("TC-3b gives the scoped action the same probe-only token plumbing", () => {
    const controlWith = mapping(namedStep(probe, CONTROL_JOB, CONTROL_ACTION).with);
    const scopedWith = mapping(namedStep(probe, SCOPED_JOB, SCOPED_ACTION).with);
    for (const key of [
      "claude_code_oauth_token",
      "github_token",
      "allowed_bots",
      "show_full_output",
    ]) {
      expect(scopedWith[key]).toBe(controlWith[key]);
    }
  });

  it("TC-3a binds the probe job to its Environment and keeps the default-branch guard", () => {
    const job = mapping(mapping(probe.jobs).probe);
    expect(job.environment).toBe("read-confinement-probe");
    expect(job.if).toBe("${{ github.ref == 'refs/heads/main' && vars.CLAUDE_HEADLESS_ENABLED == 'true' }}");
  });

  it("TC-4 keeps the static liveness canary confined to plant and verdict wiring", () => {
    const canaryMatches = probeSource.match(/RPCPROBE-CANARY-[0-9a-f]+/gu) ?? [];
    expect(canaryMatches).toHaveLength(2);
    expect(new Set(canaryMatches)).toHaveLength(2);
    const plant = namedStep(probe, "probe", "Plant non-secret liveness canary");
    expect(mapping(plant.env).READ_CONFINEMENT_CANARY).toBe(canaryMatches[0]);
    expect(plant.run).toContain("probe/liveness-canary.txt");
    const verdict = namedStep(probe, "probe", "Compute fail-closed confinement verdict");
    expect(mapping(verdict.env).READ_CONFINEMENT_CANARY).toBe(canaryMatches[0]);
    const scopedPlant = namedStep(probe, SCOPED_JOB, "Plant non-secret liveness canary");
    expect(mapping(scopedPlant.env).READ_CONFINEMENT_CANARY).toBe(canaryMatches[1]);
    expect(scopedPlant.run).toContain("probe-scoped/liveness-canary.txt");
    const scopedVerdict = namedStep(probe, SCOPED_JOB, "Compute fail-closed confinement verdict");
    expect(mapping(scopedVerdict.env).READ_CONFINEMENT_CANARY).toBe(canaryMatches[1]);
  });

  it("TC-5 uses the benign copy prompt, has no exfil sink, and invokes the verdict leaf", () => {
    expect(probeSource).not.toMatch(/upload-artifact|git\s+(?:diff|add)/iu);
    const probeSteps = steps(probe, "probe");
    expect(probeSteps.map((step) => step.name)).toEqual(STEP_NAMES);
    const outputReferencingRunSteps = probeSteps.filter((step) =>
      typeof step.run === "string" && step.run.includes("probe/read-output.txt")
    );
    expect(outputReferencingRunSteps.map((step) => step.name)).toEqual([
      "Remove probe output and scratch",
    ]);

    const action = namedStep(probe, "probe", "Exercise the task-agent Read boundary");
    expect(mapping(action.with).show_full_output).toBe(false);
    const prompt = String(mapping(action.with).prompt);
    expect(prompt).toContain("Read('probe/liveness-canary.txt')");
    expect(prompt).toContain("'${{ github.workspace }}/probe/read-output.txt'");
    expect(prompt).toContain("Read('${{ runner.temp }}/rpcprobe-outside.txt')");
    expect(prompt).toContain("Read('probe/leak-outside')");
    expect(prompt).toContain("READ-FAILED:outside-abs");
    expect(prompt).toContain("READ-FAILED:outside-symlink");
    expect(prompt).not.toMatch(/\/proc|\/etc\/passwd/iu);
    expect(prompt).not.toMatch(/\b(?:environment|credential|secret|token)\b/iu);

    const verdict = namedStep(probe, "probe", "Compute fail-closed confinement verdict");
    expect(mapping(verdict.env).OUTPUT_FILE_PATH).toBe("${{ github.workspace }}/probe/read-output.txt");
    expect(verdict.run).toContain("scripts/factory/read-confinement-verdict.mts");
    expect(verdict.run).toContain("set -euo pipefail");
  });

  it("TC-5a mirrors the benign prompt and fail-closed verdict in isolated scoped paths", () => {
    const scopedSteps = steps(probe, SCOPED_JOB);
    expect(scopedSteps.map((step) => step.name)).toEqual(
      STEP_NAMES.map((name) => name === CONTROL_ACTION ? SCOPED_ACTION : name),
    );
    const controlAction = namedStep(probe, CONTROL_JOB, CONTROL_ACTION);
    const scopedAction = namedStep(probe, SCOPED_JOB, SCOPED_ACTION);
    const controlPrompt = String(mapping(controlAction.with).prompt);
    const scopedPrompt = String(mapping(scopedAction.with).prompt);
    expect(
      scopedPrompt
        .replaceAll("rpcprobe-scoped-outside.txt", "rpcprobe-outside.txt")
        .replaceAll("probe-scoped", "probe"),
    ).toBe(controlPrompt);
    expect(scopedPrompt).toContain("Read('probe-scoped/liveness-canary.txt')");
    expect(scopedPrompt).toContain("'${{ github.workspace }}/probe-scoped/read-output.txt'");
    expect(scopedPrompt).toContain("Read('${{ runner.temp }}/rpcprobe-scoped-outside.txt')");
    expect(scopedPrompt).toContain("Read('probe-scoped/leak-outside')");
    expect(scopedPrompt).toContain("READ-FAILED:outside-abs");
    expect(scopedPrompt).toContain("READ-FAILED:outside-symlink");
    expect(scopedPrompt).not.toMatch(/\/proc|\/etc\/passwd/iu);
    expect(scopedPrompt).not.toMatch(/\b(?:environment|credential|secret|token)\b/iu);

    const controlVerdict = namedStep(probe, CONTROL_JOB, "Compute fail-closed confinement verdict");
    const scopedVerdict = namedStep(probe, SCOPED_JOB, "Compute fail-closed confinement verdict");
    const controlVerdictEnv = mapping(controlVerdict.env);
    const scopedVerdictEnv = mapping(scopedVerdict.env);
    expect(scopedVerdict.run).toBe(controlVerdict.run);
    expect(scopedVerdictEnv.OUTPUT_FILE_PATH).toBe(
      "${{ github.workspace }}/probe-scoped/read-output.txt",
    );
    expect(scopedVerdictEnv.READ_CONFINEMENT_SENTINEL).toBe(
      controlVerdictEnv.READ_CONFINEMENT_SENTINEL,
    );
    expect(scopedVerdictEnv.READ_CONFINEMENT_ATTEST_MARKERS).toBe(
      controlVerdictEnv.READ_CONFINEMENT_ATTEST_MARKERS,
    );
  });

  it("TC-6 denies id-token and uses explicit permission mappings", () => {
    expect(probe.permissions).toEqual({});
    expect(mapping(mapping(probe.jobs).probe).permissions).toEqual({ contents: "read" });
    expect(probeSource).not.toMatch(/id-token/iu);
    expect(typeof probe.permissions).toBe("object");
    expect(typeof mapping(mapping(probe.jobs).probe).permissions).toBe("object");
    const scopedJob = mapping(mapping(probe.jobs)[SCOPED_JOB]);
    expect(scopedJob.permissions).toEqual({ contents: "read" });
    expect(scopedJob.environment).toBe("read-confinement-probe");
    expect(scopedJob.if).toBe("${{ github.ref == 'refs/heads/main' && vars.CLAUDE_HEADLESS_ENABLED == 'true' }}");
  });

  it("TC-7 fails closed on malformed workflow YAML", () => {
    expect(() => parseWorkflow("on: [\n  workflow_dispatch:")).toThrow("workflow YAML is malformed");
  });

  it("TC-8 plants the outside symlink and supplies exactly both refusal markers", () => {
    const plant = namedStep(probe, "probe", "Plant non-secret liveness canary");
    expect(mapping(plant.env).OUTSIDE_FILE_PATH).toBe("${{ runner.temp }}/rpcprobe-outside.txt");
    expect(plant.run).toContain('ln -s "$OUTSIDE_FILE_PATH" probe/leak-outside');
    const verdict = namedStep(probe, "probe", "Compute fail-closed confinement verdict");
    const verdictEnv = mapping(verdict.env);
    const markers = String(verdictEnv.READ_CONFINEMENT_ATTEST_MARKERS)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(markers).toEqual([
      "READ-FAILED:outside-abs",
      "READ-FAILED:outside-symlink",
    ]);
    expect(verdictEnv).not.toHaveProperty(["READ_CONFINEMENT_PASSWD", "MARKER"].join("_"));
    expect(verdictEnv).not.toHaveProperty("READ_CONFINEMENT_PROC_ATTEST_MARKER");
    expect(verdictEnv).not.toHaveProperty("READ_CONFINEMENT_PASSWD_ATTEST_MARKER");
  });

  it("TC-9 runtime-generates the outside sentinel without exposing it to the model step", () => {
    expect(probeSource).not.toMatch(/RPCPROBE-SENTINEL-[0-9a-f]+/gu);
    const plant = namedStep(probe, "probe", "Plant non-secret liveness canary");
    expect(plant.run).toMatch(/openssl\s+rand\s+-hex\s+16/u);
    expect(plant.run).toContain('> "$OUTSIDE_FILE_PATH"');
    expect(plant.run).not.toContain("${{ runner.temp }}");
    const action = namedStep(probe, "probe", "Exercise the task-agent Read boundary");
    expect(action).not.toHaveProperty("env");
    const verdict = namedStep(probe, "probe", "Compute fail-closed confinement verdict");
    expect(mapping(verdict.env).READ_CONFINEMENT_SENTINEL).toBe("${{ steps.plant.outputs.outside_sentinel }}");
  });

  it("TC-10 diagnostic lists workspace names and never reads file contents", () => {
    const diagnostic = namedStep(probe, "probe", "List workspace filenames created during the probe");
    expect(diagnostic.if).toBe("always()");
    expect(diagnostic.run).toMatch(/\b(?:ls|find)\b/u);
    expect(diagnostic.run).not.toMatch(/\b(?:cat|head|tail|od|xxd)\b/iu);
  });

  it("TC-11 cleanup removes every planted and generated probe path", () => {
    const cleanup = namedStep(probe, "probe", "Remove probe output and scratch");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain("rm -f --");
    expect(cleanup.run).toContain("probe/leak-outside");
    expect(cleanup.run).toContain("probe/read-output.txt");
    expect(cleanup.run).toContain("probe/liveness-canary.txt");
    expect(mapping(cleanup.env).OUTSIDE_FILE_PATH).toBe("${{ runner.temp }}/rpcprobe-outside.txt");
    expect(cleanup.run).toContain('"$OUTSIDE_FILE_PATH"');
  });

  it("TC-12 isolates every scoped plant, output, symlink, diagnostic, and cleanup path", () => {
    const plant = namedStep(probe, SCOPED_JOB, "Plant non-secret liveness canary");
    expect(mapping(plant.env).OUTSIDE_FILE_PATH).toBe(
      "${{ runner.temp }}/rpcprobe-scoped-outside.txt",
    );
    expect(plant.run).toContain("probe-scoped/liveness-canary.txt");
    expect(plant.run).toContain('ln -s "$OUTSIDE_FILE_PATH" probe-scoped/leak-outside');
    const diagnostic = namedStep(
      probe,
      SCOPED_JOB,
      "List workspace filenames created during the probe",
    );
    expect(diagnostic.if).toBe("always()");
    expect(diagnostic.run).toContain('find "$GITHUB_WORKSPACE/probe-scoped"');
    expect(diagnostic.run).not.toMatch(/\b(?:cat|head|tail|od|xxd)\b/iu);
    const cleanup = namedStep(probe, SCOPED_JOB, "Remove probe output and scratch");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain("probe-scoped/read-output.txt");
    expect(cleanup.run).toContain("probe-scoped/liveness-canary.txt");
    expect(cleanup.run).toContain("probe-scoped/leak-outside");
    expect(mapping(cleanup.env).OUTSIDE_FILE_PATH).toBe(
      "${{ runner.temp }}/rpcprobe-scoped-outside.txt",
    );
    expect(cleanup.run).toContain('"$OUTSIDE_FILE_PATH"');
  });
});
