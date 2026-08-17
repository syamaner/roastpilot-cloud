import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ImplementProducerInputs } from "../../scripts/factory/eval/recorded-implement-provider.mts";
import { runMeasuredImplementOutcome, SpawnSyncGateExecutor } from "../../scripts/factory/eval/outcome-runner.mts";
import { runOutcomePlan, type GateExecutor, type GateStep, type GateStepResult } from "../../scripts/factory/eval/outcome-runner-logic.mts";

const CORPUS_ROOT = fileURLToPath(new URL("../../eval/corpus/", import.meta.url));
const GATE_FILES = [
  "snowflake/check_mutation_score.py",
  "snowflake/mutation-baseline.json",
  "snowflake/requirements-dev.txt",
].join("\0") + "\0";

let fixtureRoot: string;
let sourceRepo: string;
let baseSha: string;
let patchText: string;

function git(args: readonly string[], cwd: string): string {
  const execution = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: {
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    } as unknown as NodeJS.ProcessEnv,
    killSignal: "SIGKILL",
    maxBuffer: 1_048_576,
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  if (execution.status !== 0) throw new Error(execution.stderr);
  return execution.stdout;
}

function producerInputs(sha: string): ImplementProducerInputs {
  return {
    issueNumber: 14,
    snapshot: {
      issueNumber: 14, title: "Fixture", body: "Fixture", labels: [], state: "OPEN",
      snapshotAt: "2026-08-16T08:57:42Z",
      sourceUrl: "https://github.com/syamaner/roastpilot-cloud/issues/14",
    },
    decisionContextText: null,
    baseSha: sha,
  };
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "outcome-real-git-fixture-"));
  sourceRepo = join(fixtureRoot, "source");
  await writeFile(join(fixtureRoot, "git-version.txt"), git(["--version"], fixtureRoot));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceRepo));
  git(["init", "--initial-branch=main"], sourceRepo);
  await writeFile(join(sourceRepo, "sample.txt"), "old\n");
  git(["add", "sample.txt"], sourceRepo);
  git(["commit", "-m", "base"], sourceRepo);
  baseSha = git(["rev-parse", "HEAD"], sourceRepo).trim();
  await writeFile(join(sourceRepo, "sample.txt"), "new\n");
  git(["add", "sample.txt"], sourceRepo);
  git(["commit", "-m", "patch"], sourceRepo);
  patchText = git(["diff", `${baseSha}..HEAD`], sourceRepo);
  expect(await readFile(join(fixtureRoot, "git-version.txt"), "utf8")).toMatch(/^git version /);
});

afterAll(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

describe("outcome runner micro real-git seam", () => {
  it("T114 clones, checks out, measures, and applies a tiny patch outside the checkout", async () => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "outcome-real-git-run-"));
    const real = new SpawnSyncGateExecutor();
    const steps: GateStep[] = [];
    let workspaceRoot = "";
    const executor: GateExecutor = {
      async run(step: GateStep): Promise<GateStepResult> {
        steps.push(step);
        if (step.args.includes("--numstat")) {
          const patchFile = step.args.at(-1) as string;
          const tree = step.args[1] as string;
          workspaceRoot = dirname(patchFile);
          expect(existsSync(patchFile)).toBe(true);
          expect(relative(tree, patchFile).startsWith("..")).toBe(true);
        }
        if (step.executable === "git") return real.run(step);
        return { spawned: true, exitCode: 0, stdout: "", stderr: "" };
      },
    };
    try {
      const outcome = await runMeasuredImplementOutcome({
        caseId: "issue-014-real-git",
        inputs: producerInputs(baseSha),
        patchText,
        sourceRepoRoot: sourceRepo,
        executor,
        temporaryParent,
        runtimeEnvironment: { path: "/usr/bin:/bin", home: temporaryParent },
      });
      expect(outcome.setup).toEqual({ status: "pass" });
      expect(outcome.diff).toEqual({
        ok: true,
        measured: { combinedTextualLines: 2, logicLines: 2, testFileLines: 0 },
      });
      expect(steps.map((step) => step.executable)).toEqual([
        "git", "git", "git", "git", "git", "npm", "npm", "npm", "npm",
      ]);
      expect(workspaceRoot).not.toBe("");
      expect(existsSync(workspaceRoot)).toBe(false);
    } finally {
      await rm(temporaryParent, { force: true, recursive: true });
    }
  });

  it("T115 fails a missing base closed and cleans its temporary workspace", async () => {
    const temporaryParent = await mkdtemp(join(tmpdir(), "outcome-missing-base-"));
    try {
      const outcome = await runMeasuredImplementOutcome({
        caseId: "issue-014-missing-base",
        inputs: producerInputs("ffffffffffffffffffffffffffffffffffffffff"),
        patchText,
        sourceRepoRoot: sourceRepo,
        temporaryParent,
        runtimeEnvironment: { path: "/usr/bin:/bin", home: temporaryParent },
      });
      expect(outcome.setup).toEqual({ status: "non-pass", reason: "missing historical base" });
      expect(outcome.mutation).toEqual({
        applicable: true,
        gate: { status: "non-pass", reason: "environment setup failed" },
      });
      expect(await readdir(temporaryParent)).toEqual([]);
    } finally {
      await rm(temporaryParent, { force: true, recursive: true });
    }
  });

  it("T118 preserves all four corpus patch attributions and authoritative line splits", async () => {
    const cases = [
      ["issue-009-registry-reconciliation", { combinedTextualLines: 6, logicLines: 6, testFileLines: 0 }, false],
      ["issue-026-health-route-dryrun", { combinedTextualLines: 15, logicLines: 5, testFileLines: 10 }, false],
      ["issue-058-grant-hardening", { combinedTextualLines: 267, logicLines: 119, testFileLines: 148 }, true],
      ["issue-151-summary-binding", { combinedTextualLines: 221, logicLines: 13, testFileLines: 208 }, false],
    ] as const;
    for (const [caseId, measured, mutationApplicable] of cases) {
      const patchPath = join(CORPUS_ROOT, "inputs", caseId, "recorded", "implement.patch");
      const recordedPatchText = await readFile(patchPath, "utf8");
      const numstat = git(["apply", "--numstat", "-z", patchPath], sourceRepo);
      const executor: GateExecutor = {
        run(step: GateStep): Promise<GateStepResult> {
          if (step.args.includes("--numstat")) return Promise.resolve({ spawned: true, exitCode: 0, stdout: numstat, stderr: "" });
          if (step.args.includes("ls-files")) return Promise.resolve({ spawned: true, exitCode: 0, stdout: GATE_FILES, stderr: "" });
          return Promise.resolve({ spawned: true, exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const outcome = await runOutcomePlan({
        caseId,
        inputs: producerInputs(baseSha),
        patchText: recordedPatchText,
        sourceRepoRoot: "/source",
        workspace: {
          root: "/work", tree: "/work/tree", patchFile: "/work/implement.patch",
          venv: "/work/venv", venvPath: "/work/venv/bin:/safe/bin",
        },
        runtimeEnvironment: { path: "/safe/bin", home: "/safe/home" },
      }, executor);
      expect(outcome.diff, caseId).toEqual({ ok: true, measured });
      expect(outcome.mutation.applicable, caseId).toBe(mutationApplicable);
      if (mutationApplicable) expect(outcome.mutation).toEqual({ applicable: true, gate: { status: "pass" } });
      else expect(outcome.mutation).toEqual({ applicable: false, reason: "no-mutation-surface" });
    }
  });
});
