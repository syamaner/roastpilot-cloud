import { isTestFilePath } from "../implement-patch-logic.mts";
import { parseNumstatZ } from "../patch-analysis-format.mts";
import type { ImplementProducerInputs } from "./recorded-implement-provider.mts";

export interface GateStep {
  readonly executable: "git" | "npm" | "python3";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface GateStepResult {
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GateExecutor {
  run(step: GateStep): Promise<GateStepResult>;
}

export type MeasuredGateStatus =
  | { readonly status: "pass" }
  | { readonly status: "non-pass"; readonly reason: string };

export interface MeasuredDiff {
  readonly combinedTextualLines: number;
  readonly logicLines: number;
  readonly testFileLines: number;
}

export type MeasuredMutation =
  | {
      readonly applicable: false;
      readonly reason:
        | "no-mutation-surface"
        | "gate-files-absent-at-base";
    }
  | { readonly applicable: true; readonly gate: MeasuredGateStatus };

export interface MeasuredImplementOutcome {
  readonly caseId: string;
  readonly baseSha: string;
  readonly setup: MeasuredGateStatus;
  readonly diff:
    | { readonly ok: true; readonly measured: MeasuredDiff }
    | { readonly ok: false; readonly reason: string };
  readonly compile: MeasuredGateStatus;
  readonly tests: MeasuredGateStatus;
  readonly mutation: MeasuredMutation;
}

export interface OutcomeWorkspace {
  readonly root: string;
  readonly tree: string;
  readonly patchFile: string;
  readonly venv: string;
  readonly venvPath: string;
}

export interface OutcomeRuntimeEnvironment {
  readonly path: string;
  readonly home: string;
}

export interface OutcomePlanInput {
  readonly caseId: string;
  readonly inputs: ImplementProducerInputs;
  readonly patchText: string;
  readonly sourceRepoRoot: string;
  readonly workspace: OutcomeWorkspace;
  readonly runtimeEnvironment: OutcomeRuntimeEnvironment;
}

export const GIT_TIMEOUT_MS = 120_000;
export const INSTALL_TIMEOUT_MS = 600_000;
export const TYPECHECK_TIMEOUT_MS = 600_000;
export const BUILD_TIMEOUT_MS = 900_000;
export const TEST_TIMEOUT_MS = 900_000;
export const MUTATION_TIMEOUT_MS = 900_000;

const MAX_EXECUTOR_OUTPUT_BYTES = 16_777_216;
const MAX_REASON_EXCERPT_BYTES = 4_096;
const MUTATION_GATE_FILES = [
  "snowflake/check_mutation_score.py",
  "snowflake/mutation-baseline.json",
  "snowflake/requirements-dev.txt",
] as const;
const PASS: MeasuredGateStatus = { status: "pass" };
type NonPassGate = Extract<MeasuredGateStatus, { readonly status: "non-pass" }>;

function nonPass(reason: string): NonPassGate {
  return { status: "non-pass", reason };
}

function truncate(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_REASON_EXCERPT_BYTES) return text;
  let kept = bytes.subarray(0, MAX_REASON_EXCERPT_BYTES);
  while (kept.length > 0) {
    try {
      const prefix = new TextDecoder("utf-8", { fatal: true }).decode(kept);
      return `${prefix}\n[truncated ${String(bytes.length - kept.length)} bytes]`;
    } catch {
      kept = kept.subarray(0, kept.length - 1);
    }
  }
  /* v8 ignore next -- a UTF-8 code point is at most four bytes, so trimming a non-empty 4096-byte prefix can never exhaust it */
  return `[truncated ${String(bytes.length)} bytes]`;
}

type CheckedStep =
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      readonly gate: NonPassGate;
    };

async function runChecked(
  executor: GateExecutor,
  step: GateStep,
  name: string,
): Promise<CheckedStep> {
  try {
    const result = await executor.run(step);
    if (
      typeof result.spawned !== "boolean" ||
      (result.exitCode !== null && !Number.isInteger(result.exitCode)) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout, "utf8") > MAX_EXECUTOR_OUTPUT_BYTES ||
      Buffer.byteLength(result.stderr, "utf8") > MAX_EXECUTOR_OUTPUT_BYTES
    ) {
      return { ok: false, gate: nonPass(`${name} returned invalid output`) };
    }
    if (!result.spawned || result.exitCode !== 0) {
      const detail = result.stderr || result.stdout || "no diagnostic output";
      return { ok: false, gate: nonPass(`${name} failed: ${truncate(detail)}`) };
    }
    return { ok: true, stdout: result.stdout };
  } catch {
    return { ok: false, gate: nonPass(`${name} executor failed`) };
  }
}

function setupFailure(
  caseId: string,
  baseSha: string,
  setup: MeasuredGateStatus,
  diff:
    | { readonly ok: true; readonly measured: MeasuredDiff }
    | { readonly ok: false; readonly reason: string },
): MeasuredImplementOutcome {
  return {
    caseId,
    baseSha,
    setup,
    diff,
    compile: nonPass("environment setup failed"),
    tests: nonPass("environment setup failed"),
    mutation: {
      applicable: true,
      gate: nonPass("environment setup failed"),
    },
  };
}

export function environmentFailureOutcome(
  caseId: string,
  baseSha: string,
): MeasuredImplementOutcome {
  return setupFailure(
    caseId,
    baseSha,
    nonPass("environment setup failed"),
    { ok: false, reason: "environment setup failed" },
  );
}

function step(
  executable: GateStep["executable"],
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): GateStep {
  return { executable, args, cwd, env, timeoutMs };
}

function patchRenameTouchesSnowflake(patchText: string): boolean {
  return patchText.split("\n").some((line) => {
    const structuralLine = line.trimEnd();
    return /^(?:rename from|rename to) "?snowflake\//.test(structuralLine);
  });
}

function measuredDiff(stdout: string, patchText: string): {
  readonly measured: MeasuredDiff;
  readonly touchesSnowflake: boolean;
} {
  const rows = parseNumstatZ(stdout);
  let combinedTextualLines = 0;
  let logicLines = 0;
  let testFileLines = 0;
  let touchesSnowflake = patchRenameTouchesSnowflake(patchText);
  for (const row of rows) {
    if (row.additions === null || row.deletions === null) {
      throw new Error("binary numstat row");
    }
    const changed = row.additions + row.deletions;
    combinedTextualLines += changed;
    if (isTestFilePath(row.path)) testFileLines += changed;
    else logicLines += changed;
    touchesSnowflake ||= row.path.startsWith("snowflake/");
  }
  if (
    !Number.isSafeInteger(combinedTextualLines) ||
    !Number.isSafeInteger(logicLines) ||
    !Number.isSafeInteger(testFileLines)
  ) {
    throw new Error("numstat total exceeds safe integer range");
  }
  return {
    measured: { combinedTextualLines, logicLines, testFileLines },
    touchesSnowflake,
  };
}

function mutationFilesPresent(stdout: string): boolean {
  const fields = stdout.split("\0");
  if (fields.pop() !== "") throw new Error("ls-files output is not terminated");
  if (fields.some((path) => !MUTATION_GATE_FILES.includes(path as never))) {
    throw new Error("ls-files returned an unexpected path");
  }
  return MUTATION_GATE_FILES.every((path) => fields.includes(path));
}

function downstreamFailure(
  caseId: string,
  baseSha: string,
  diff: MeasuredDiff,
  compile: MeasuredGateStatus,
  tests: MeasuredGateStatus,
  mutation: MeasuredMutation,
): MeasuredImplementOutcome {
  return {
    caseId,
    baseSha,
    setup: PASS,
    diff: { ok: true, measured: diff },
    compile,
    tests,
    mutation,
  };
}

export async function runOutcomePlan(
  plan: OutcomePlanInput,
  executor: GateExecutor,
): Promise<MeasuredImplementOutcome> {
  let caseId = "unknown";
  let baseSha = "unknown";
  try {
    caseId = plan.caseId;
    baseSha = plan.inputs.baseSha;
    const { patchText, sourceRepoRoot, workspace, runtimeEnvironment } = plan;
    const gitEnv = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_VALUE_0: "false",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    };
    const commandEnv = {
      PATH: runtimeEnvironment.path,
      HOME: runtimeEnvironment.home,
      CI: "1",
      LC_ALL: "C",
    };
    const venvEnv = { ...commandEnv, PATH: workspace.venvPath };

    const verify = await runChecked(
      executor,
      step("git", ["-C", sourceRepoRoot, "rev-parse", "--verify", "--end-of-options", `${baseSha}^{commit}`], sourceRepoRoot, gitEnv, GIT_TIMEOUT_MS),
      "verify-base",
    );
    if (!verify.ok) {
      return setupFailure(caseId, baseSha, nonPass("missing historical base"), {
        ok: false,
        reason: "missing historical base",
      });
    }
    const clone = await runChecked(
      executor,
      step("git", ["clone", "--local", "--no-hardlinks", sourceRepoRoot, workspace.tree], workspace.root, gitEnv, GIT_TIMEOUT_MS),
      "clone",
    );
    if (!clone.ok) return setupFailure(caseId, baseSha, clone.gate, { ok: false, reason: "environment setup failed" });
    const checkout = await runChecked(
      executor,
      step("git", ["-C", workspace.tree, "checkout", "--detach", baseSha], workspace.root, gitEnv, GIT_TIMEOUT_MS),
      "checkout",
    );
    if (!checkout.ok) return setupFailure(caseId, baseSha, checkout.gate, { ok: false, reason: "environment setup failed" });
    const measure = await runChecked(
      executor,
      step("git", ["-C", workspace.tree, "apply", "--numstat", "-z", workspace.patchFile], workspace.root, gitEnv, GIT_TIMEOUT_MS),
      "measure-diff",
    );
    if (!measure.ok) return setupFailure(caseId, baseSha, nonPass("diff unmeasurable"), { ok: false, reason: measure.gate.reason });

    let diff: MeasuredDiff;
    let touchesSnowflake: boolean;
    try {
      ({ measured: diff, touchesSnowflake } = measuredDiff(measure.stdout, patchText));
    } catch {
      return setupFailure(caseId, baseSha, nonPass("diff unmeasurable"), { ok: false, reason: "diff unmeasurable" });
    }

    let mutation: MeasuredMutation = {
      applicable: false,
      reason: "no-mutation-surface",
    };
    if (touchesSnowflake) {
      const listed = await runChecked(
        executor,
        step("git", ["-C", workspace.tree, "ls-files", "-z", "--", ...MUTATION_GATE_FILES], workspace.root, gitEnv, GIT_TIMEOUT_MS),
        "mutation-applicability",
      );
      if (!listed.ok) {
        return setupFailure(caseId, baseSha, nonPass("environment setup failed"), { ok: true, measured: diff });
      }
      try {
        mutation = mutationFilesPresent(listed.stdout)
          ? { applicable: true, gate: nonPass("mutation gate not run") }
          : { applicable: false, reason: "gate-files-absent-at-base" };
      } catch {
        return setupFailure(caseId, baseSha, nonPass("environment setup failed"), { ok: true, measured: diff });
      }
    }

    const apply = await runChecked(
      executor,
      step("git", ["-C", workspace.tree, "apply", workspace.patchFile], workspace.root, gitEnv, GIT_TIMEOUT_MS),
      "apply",
    );
    if (!apply.ok) return setupFailure(caseId, baseSha, apply.gate, { ok: true, measured: diff });
    const install = await runChecked(
      executor,
      step("npm", ["ci", "--ignore-scripts"], workspace.tree, commandEnv, INSTALL_TIMEOUT_MS),
      "npm-ci",
    );
    if (!install.ok) return setupFailure(caseId, baseSha, install.gate, { ok: true, measured: diff });

    const typecheck = await runChecked(executor, step("npm", ["exec", "--", "tsc", "--noEmit"], workspace.tree, commandEnv, TYPECHECK_TIMEOUT_MS), "typecheck");
    if (!typecheck.ok) {
      const blockedMutation = mutation.applicable
        ? { applicable: true as const, gate: nonPass("compile failed") }
        : mutation;
      return downstreamFailure(caseId, baseSha, diff, typecheck.gate, nonPass("compile failed"), blockedMutation);
    }
    const build = await runChecked(executor, step("npm", ["exec", "--", "next", "build"], workspace.tree, commandEnv, BUILD_TIMEOUT_MS), "build");
    if (!build.ok) {
      const blockedMutation = mutation.applicable
        ? { applicable: true as const, gate: nonPass("compile failed") }
        : mutation;
      return downstreamFailure(caseId, baseSha, diff, build.gate, nonPass("compile failed"), blockedMutation);
    }
    const tests = await runChecked(executor, step("npm", ["exec", "--", "vitest", "run"], workspace.tree, commandEnv, TEST_TIMEOUT_MS), "tests");
    if (!tests.ok) {
      const blockedMutation = mutation.applicable
        ? { applicable: true as const, gate: nonPass("tests failed") }
        : mutation;
      return downstreamFailure(caseId, baseSha, diff, PASS, tests.gate, blockedMutation);
    }

    if (mutation.applicable) {
      const snowflake = `${workspace.tree}/snowflake`;
      const mutationSteps = [
        step("python3", ["-m", "venv", workspace.venv], workspace.root, commandEnv, MUTATION_TIMEOUT_MS),
        step("python3", ["-m", "pip", "install", "-r", "requirements-dev.txt"], snowflake, venvEnv, MUTATION_TIMEOUT_MS),
        step("python3", ["-P", "-m", "mutmut", "run"], snowflake, venvEnv, MUTATION_TIMEOUT_MS),
        step("python3", ["-P", "-m", "mutmut", "export-cicd-stats"], snowflake, venvEnv, MUTATION_TIMEOUT_MS),
        step("python3", ["-P", "check_mutation_score.py"], snowflake, venvEnv, MUTATION_TIMEOUT_MS),
      ];
      for (const [index, mutationStep] of mutationSteps.entries()) {
        const result = await runChecked(executor, mutationStep, `mutation-${String(index + 1)}`);
        if (!result.ok) {
          return downstreamFailure(caseId, baseSha, diff, PASS, PASS, { applicable: true, gate: result.gate });
        }
      }
      mutation = { applicable: true, gate: PASS };
    }
    return downstreamFailure(caseId, baseSha, diff, PASS, PASS, mutation);
  } catch {
    return environmentFailureOutcome(caseId, baseSha);
  }
}
