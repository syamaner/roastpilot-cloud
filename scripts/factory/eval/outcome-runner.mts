import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ImplementProducerInputs } from "./recorded-implement-provider.mts";
import {
  environmentFailureOutcome,
  runOutcomePlan,
  type GateExecutor,
  type GateStep,
  type GateStepResult,
  type MeasuredImplementOutcome,
  type OutcomeRuntimeEnvironment,
} from "./outcome-runner-logic.mts";

const MAX_BUFFER = 16_777_216;
const { PATH: AMBIENT_PATH = "/usr/bin:/bin", HOME: AMBIENT_HOME = "/tmp" } =
  process.env;

function decode(bytes: unknown): string {
  if (!Buffer.isBuffer(bytes)) throw new Error("process output is not bytes");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export class SpawnSyncGateExecutor implements GateExecutor {
  run(step: GateStep): Promise<GateStepResult> {
    try {
      const result = spawnSync(step.executable, [...step.args], {
        cwd: step.cwd,
        encoding: "buffer",
        env: { ...step.env } as unknown as NodeJS.ProcessEnv,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: step.timeoutMs,
        windowsHide: true,
      });
      return Promise.resolve({
        spawned: result.error === undefined && result.signal === null,
        exitCode: result.status,
        stdout: decode(result.stdout),
        stderr: decode(result.stderr),
      });
    } catch {
      return Promise.resolve({
        spawned: false,
        exitCode: null,
        stdout: "",
        stderr: "process execution failed",
      });
    }
  }
}

export interface RunMeasuredImplementOutcomeInput {
  readonly caseId: string;
  readonly inputs: ImplementProducerInputs;
  readonly patchText: string;
  readonly sourceRepoRoot: string;
  readonly executor?: GateExecutor;
  readonly temporaryParent?: string;
  readonly runtimeEnvironment?: OutcomeRuntimeEnvironment;
}

export async function runMeasuredImplementOutcome(
  request: RunMeasuredImplementOutcomeInput,
): Promise<MeasuredImplementOutcome> {
  let root: string | undefined;
  let caseId = "unknown";
  let baseSha = "unknown";
  let outcome = environmentFailureOutcome(caseId, baseSha);
  try {
    caseId = request.caseId;
    baseSha = request.inputs.baseSha;
    root = await mkdtemp(
      join(request.temporaryParent ?? tmpdir(), "roastpilot-outcome-"),
    );
    const tree = join(root, "tree");
    const patchFile = join(root, "implement.patch");
    const venv = join(root, "venv");
    const runtimeEnvironment = request.runtimeEnvironment ?? {
      path: AMBIENT_PATH,
      home: AMBIENT_HOME,
    };
    await writeFile(patchFile, request.patchText, { encoding: "utf8", flag: "wx" });
    outcome = await runOutcomePlan(
      {
        caseId,
        inputs: request.inputs,
        patchText: request.patchText,
        sourceRepoRoot: request.sourceRepoRoot,
        workspace: {
          root,
          tree,
          patchFile,
          venv,
          venvPath: `${join(venv, "bin")}${delimiter}${runtimeEnvironment.path}`,
        },
        runtimeEnvironment,
      },
      request.executor ?? new SpawnSyncGateExecutor(),
    );
  } catch {
    outcome = environmentFailureOutcome(caseId, baseSha);
  } finally {
    if (root !== undefined) {
      try {
        await rm(root, { force: true, recursive: true });
      } catch {
        outcome = environmentFailureOutcome(caseId, baseSha);
      }
    }
  }
  return outcome;
}
