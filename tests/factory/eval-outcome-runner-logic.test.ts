import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ImplementProducerInputs } from "../../scripts/factory/eval/recorded-implement-provider.mts";
import {
  runOutcomePlan,
  type GateExecutor,
  type GateStep,
  type GateStepResult,
  type OutcomePlanInput,
} from "../../scripts/factory/eval/outcome-runner-logic.mts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const GATE_FILES = [
  "snowflake/check_mutation_score.py",
  "snowflake/mutation-baseline.json",
  "snowflake/requirements-dev.txt",
].join("\0") + "\0";

function inputs(): ImplementProducerInputs {
  return {
    issueNumber: 14,
    snapshot: {
      issueNumber: 14,
      title: "Neutral issue",
      body: "Neutral body",
      labels: [],
      state: "OPEN",
      snapshotAt: "2026-08-16T08:57:42Z",
      sourceUrl: "https://github.com/syamaner/roastpilot-cloud/issues/14",
    },
    decisionContextText: null,
    baseSha: SHA,
  };
}

function diffPatch(from: string, to = from): string {
  return [
    `diff --git a/${from} b/${to}`,
    `--- a/${from}`,
    `+++ b/${to}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
}

function renamePatch(from: string, to: string): string {
  const [header, ...rest] = diffPatch(from, to).split("\n");
  return [
    header,
    "similarity index 80%",
    `rename from ${from}`,
    `rename to ${to}`,
    ...rest,
  ].join("\n");
}

function plan(patchText = diffPatch("src/a.ts")): OutcomePlanInput {
  return {
    caseId: "issue-014-outcome-runner",
    inputs: inputs(),
    patchText,
    sourceRepoRoot: "/source",
    workspace: {
      root: "/work",
      tree: "/work/tree",
      patchFile: "/work/implement.patch",
      venv: "/work/venv",
      venvPath: "/work/venv/bin:/safe/bin",
    },
    runtimeEnvironment: { path: "/safe/bin", home: "/safe/home" },
  };
}

function result(
  stdout = "",
  overrides: Partial<GateStepResult> = {},
): GateStepResult {
  return { spawned: true, exitCode: 0, stdout, stderr: "", ...overrides };
}

class FakeExecutor implements GateExecutor {
  readonly steps: GateStep[] = [];
  constructor(
    private readonly responder: (step: GateStep, index: number) => GateStepResult,
  ) {}
  run(step: GateStep): Promise<GateStepResult> {
    this.steps.push(step);
    return Promise.resolve(this.responder(step, this.steps.length - 1));
  }
}

function happyExecutor(
  numstat: string,
  options: { gateFiles?: string; failMutationCheck?: boolean } = {},
): FakeExecutor {
  return new FakeExecutor((step) => {
    if (step.args.includes("--numstat")) return result(numstat);
    if (step.args.includes("ls-files")) return result(options.gateFiles ?? GATE_FILES);
    if (step.args.includes("check_mutation_score.py") && options.failMutationCheck) {
      return result("", { exitCode: 1, stderr: "mutation score dropped" });
    }
    return result();
  });
}

function command(step: GateStep): string {
  return `${step.executable} ${step.args.join(" ")}`;
}

describe("recorded outcome runner logic", () => {
  it("T91 runs the complete non-mutation happy path", async () => {
    const executor = happyExecutor("2\t1\tsrc/a.ts\0");
    const outcome = await runOutcomePlan(plan(), executor);
    expect(outcome).toEqual({
      caseId: "issue-014-outcome-runner",
      baseSha: SHA,
      setup: { status: "pass" },
      diff: {
        ok: true,
        measured: { combinedTextualLines: 3, logicLines: 3, testFileLines: 0 },
      },
      compile: { status: "pass" },
      tests: { status: "pass" },
      mutation: { applicable: false, reason: "no-mutation-surface" },
    });
    expect(executor.steps.map(command)).toEqual([
      `git -C /source rev-parse --verify --end-of-options ${SHA}^{commit}`,
      "git clone --local --no-hardlinks /source /work/tree",
      `git -C /work/tree checkout --detach ${SHA}`,
      "git -C /work/tree apply --numstat -z /work/implement.patch",
      "git -C /work/tree apply /work/implement.patch",
      "npm ci --ignore-scripts",
      "npm exec -- tsc --noEmit",
      "npm exec -- next build",
      "npm exec -- vitest run",
    ]);
  });

  it("T92 runs only the existing Python mutation gate and records its verdict", async () => {
    for (const failMutationCheck of [false, true]) {
      const executor = happyExecutor("1\t1\tsnowflake/tool.py\0", { failMutationCheck });
      const outcome = await runOutcomePlan(plan(diffPatch("snowflake/tool.py")), executor);
      expect(outcome.mutation).toEqual({
        applicable: true,
        gate: failMutationCheck
          ? { status: "non-pass", reason: "mutation-5 failed: mutation score dropped" }
          : { status: "pass" },
      });
      expect(executor.steps.filter((step) => step.executable === "python3").map(command)).toEqual([
        "python3 -m venv /work/venv",
        "python3 -m pip install -r requirements-dev.txt",
        "python3 -P -m mutmut run",
        "python3 -P -m mutmut export-cicd-stats",
        "python3 -P check_mutation_score.py",
      ]);
    }
  });

  it("T93 delegates hostile path grammar to numstat parsing and shared test classification", async () => {
    const numstat = [
      "3\t1\ttests/a.test.ts",
      "2\t2\tdocs/state/registry.md",
      "5\t6\t", "src/old.ts", "src/new.ts",
      "2\t1\ttests/name\twith-tab.ts",
      "",
    ].join("\0");
    const outcome = await runOutcomePlan(plan(), happyExecutor(numstat));
    expect(outcome.diff).toEqual({
      ok: true,
      measured: { combinedTextualLines: 22, logicLines: 15, testFileLines: 7 },
    });
  });

  it("T94 constructs exact closed child environments without a poisoned parent key", async () => {
    const executor = happyExecutor("1\t0\tsnowflake/tool.py\0");
    await runOutcomePlan(plan(diffPatch("snowflake/tool.py")), executor);
    const gitSteps = executor.steps.filter((step) => step.executable === "git");
    const npmSteps = executor.steps.filter((step) => step.executable === "npm");
    const pythonSteps = executor.steps.filter((step) => step.executable === "python3");
    const gitEnv = {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_VALUE_0: "false", GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0", LC_ALL: "C",
    };
    const commandEnv = { PATH: "/safe/bin", HOME: "/safe/home", CI: "1", LC_ALL: "C" };
    expect(gitSteps.every((step) => JSON.stringify(step.env) === JSON.stringify(gitEnv))).toBe(true);
    expect(npmSteps.every((step) => JSON.stringify(step.env) === JSON.stringify(commandEnv))).toBe(true);
    expect(pythonSteps[0]?.env).toEqual(commandEnv);
    expect(pythonSteps.slice(1).every((step) => step.env.PATH === "/work/venv/bin:/safe/bin")).toBe(true);
    expect(executor.steps.every((step) => !("PARENT_SECRET" in step.env))).toBe(true);
  });

  it("T95 serialises identical transcripts byte-for-byte deterministically", async () => {
    const first = await runOutcomePlan(plan(), happyExecutor("1\t2\tsrc/a.ts\0"));
    const second = await runOutcomePlan(plan(), happyExecutor("1\t2\tsrc/a.ts\0"));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("T96 stops immediately when the historical base is absent", async () => {
    const executor = new FakeExecutor(() => result("", { exitCode: 1 }));
    const outcome = await runOutcomePlan(plan(), executor);
    expect(outcome.setup).toEqual({ status: "non-pass", reason: "missing historical base" });
    expect(outcome.diff).toEqual({ ok: false, reason: "missing historical base" });
    expect(executor.steps).toHaveLength(1);
  });

  it("T97 makes checkout failure setup-poison every later result", async () => {
    const executor = new FakeExecutor((_step, index) =>
      index === 2 ? result("", { exitCode: 1, stderr: "checkout rejected" }) : result(),
    );
    const outcome = await runOutcomePlan(plan(), executor);
    expect(outcome.setup).toEqual({ status: "non-pass", reason: "checkout failed: checkout rejected" });
    expect(outcome.compile.status).toBe("non-pass");
    expect(outcome.tests.status).toBe("non-pass");
    expect(outcome.mutation).toEqual({ applicable: true, gate: { status: "non-pass", reason: "environment setup failed" } });
    expect(executor.steps).toHaveLength(3);

    const cloneFailure = await runOutcomePlan(plan(), new FakeExecutor((_step, index) =>
      index === 1 ? result("", { exitCode: 1, stderr: "clone rejected" }) : result(),
    ));
    expect(cloneFailure.setup).toEqual({ status: "non-pass", reason: "clone failed: clone rejected" });
  });

  it("T98 stops at apply failure while retaining the pre-apply measurement", async () => {
    const executor = new FakeExecutor((step, index) => {
      if (step.args.includes("--numstat")) return result("2\t1\tsrc/a.ts\0");
      return index === 4 ? result("", { exitCode: 1, stderr: "does not apply" }) : result();
    });
    const outcome = await runOutcomePlan(plan(), executor);
    expect(outcome.setup).toEqual({ status: "non-pass", reason: "apply failed: does not apply" });
    expect(outcome.diff).toEqual({ ok: true, measured: { combinedTextualLines: 3, logicLines: 3, testFileLines: 0 } });
    expect(executor.steps).toHaveLength(5);

    const installFailure = await runOutcomePlan(plan(), new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("2\t1\tsrc/a.ts\0");
      if (step.args.includes("ci")) return result("", { exitCode: 1, stderr: "install rejected" });
      return result();
    }));
    expect(installFailure.setup).toEqual({ status: "non-pass", reason: "npm-ci failed: install rejected" });
  });

  it("T99 requires a zero exit code even when the gate spawned", async () => {
    const executor = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsrc/a.ts\0");
      if (step.args.includes("tsc")) return result("", { exitCode: 7, stderr: "tsc failed" });
      return result();
    });
    const outcome = await runOutcomePlan(plan(), executor);
    expect(outcome.compile).toEqual({ status: "non-pass", reason: "typecheck failed: tsc failed" });
    expect(executor.steps.some((step) => step.args.includes("build"))).toBe(false);

    for (const [failure, numstat] of [
      ["next", "1\t0\tsrc/a.ts\0"],
      ["next", "1\t0\tsnowflake/tool.py\0"],
      ["vitest", "1\t0\tsrc/a.ts\0"],
      ["vitest", "1\t0\tsnowflake/tool.py\0"],
      ["tsc", "1\t0\tsnowflake/tool.py\0"],
    ] as const) {
      const failed = new FakeExecutor((step) => {
        if (step.args.includes("--numstat")) return result(numstat);
        if (step.args.includes("ls-files")) return result(GATE_FILES);
        if (step.args.includes(failure)) return result("gate stdout", { exitCode: 2 });
        return result();
      });
      const failedPlan = numstat.includes("snowflake/")
        ? plan(diffPatch("snowflake/tool.py"))
        : plan();
      const failedOutcome = await runOutcomePlan(failedPlan, failed);
      expect(failure === "vitest" ? failedOutcome.tests.status : failedOutcome.compile.status).toBe("non-pass");
    }
  });

  it("T100 requires a successfully spawned process even when exitCode is zero", async () => {
    const executor = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsrc/a.ts\0");
      if (step.args.includes("tsc")) return result("", { spawned: false, exitCode: 0, stderr: "SIGKILL" });
      return result();
    });
    const outcome = await runOutcomePlan(plan(), executor);
    expect(outcome.compile).toEqual({ status: "non-pass", reason: "typecheck failed: SIGKILL" });
  });

  it("T101 rejects malformed, unterminated, and binary numstat without throwing", async () => {
    for (const stdout of [
      "garbage\0",
      "1\t2\tx",
      "-\t-\timage.png\0",
      `${String(Number.MAX_SAFE_INTEGER)}\t0\ta.ts\0${String(Number.MAX_SAFE_INTEGER)}\t0\tb.ts\0`,
    ]) {
      const executor = happyExecutor(stdout);
      await expect(runOutcomePlan(plan(), executor)).resolves.toMatchObject({
        setup: { status: "non-pass" },
        diff: { ok: false, reason: "diff unmeasurable" },
        mutation: { applicable: true, gate: { status: "non-pass" } },
      });
      expect(executor.steps).toHaveLength(4);
    }
    const failedMeasure = new FakeExecutor((step) =>
      step.args.includes("--numstat")
        ? result("", { exitCode: 1, stderr: "cannot inspect" })
        : result(),
    );
    expect((await runOutcomePlan(plan(), failedMeasure)).diff).toEqual({
      ok: false,
      reason: "measure-diff failed: cannot inspect",
    });
  });

  it("T102 proves both inapplicable mutation arms execute no mutation command", async () => {
    const ordinary = happyExecutor("1\t0\tsrc/a.ts\0");
    expect((await runOutcomePlan(plan(), ordinary)).mutation).toEqual({ applicable: false, reason: "no-mutation-surface" });
    expect(ordinary.steps.some((step) => step.executable === "python3")).toBe(false);

    const absent = happyExecutor("1\t0\tsnowflake/tool.py\0", {
      gateFiles: "snowflake/check_mutation_score.py\0",
    });
    expect((await runOutcomePlan(plan(diffPatch("snowflake/tool.py")), absent)).mutation).toEqual({ applicable: false, reason: "gate-files-absent-at-base" });
    expect(absent.steps.some((step) => step.executable === "python3")).toBe(false);

    for (const gateFiles of ["unterminated", `${GATE_FILES}unexpected\0`]) {
      const hostile = happyExecutor("1\t0\tsnowflake/tool.py\0", { gateFiles });
      const hostileOutcome = await runOutcomePlan(plan(diffPatch("snowflake/tool.py")), hostile);
      expect(hostileOutcome.setup.status).toBe("non-pass");
      expect(hostileOutcome.mutation).toMatchObject({ applicable: true, gate: { status: "non-pass" } });
      expect(hostile.steps.some((step) => step.executable !== "git")).toBe(false);
    }
    const listingFailure = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsnowflake/tool.py\0");
      if (step.args.includes("ls-files")) return result("", { exitCode: 1 });
      return result();
    });
    expect((await runOutcomePlan(plan(diffPatch("snowflake/tool.py")), listingFailure)).setup.status).toBe("non-pass");
  });

  it("T103 never represents an unmeasured setup-poisoned mutation as inapplicable", async () => {
    const outcome = await runOutcomePlan(
      plan(),
      new FakeExecutor(() => result("", { spawned: false, exitCode: null })),
    );
    expect(outcome.mutation).toEqual({
      applicable: true,
      gate: { status: "non-pass", reason: "environment setup failed" },
    });
    expect(outcome.mutation.applicable).not.toBe(false);
  });

  it("T104 marks rather than silently drops a bounded diagnostic excerpt", async () => {
    const diagnostic = "x".repeat(1_048_576);
    const executor = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsrc/a.ts\0");
      if (step.args.includes("tsc")) return result("", { exitCode: 1, stderr: diagnostic });
      return result();
    });
    const outcome = await runOutcomePlan(plan(), executor);
    expect(outcome.compile.status).toBe("non-pass");
    if (outcome.compile.status === "non-pass") {
      expect(outcome.compile.reason.length).toBeLessThan(5_000);
      expect(outcome.compile.reason).toMatch(/\[truncated 1044480 bytes\]$/);
    }
    const multibyte = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsrc/a.ts\0");
      if (step.args.includes("tsc")) return result("", { exitCode: 1, stderr: `a${"😀".repeat(2_000)}` });
      return result();
    });
    const multibyteOutcome = await runOutcomePlan(plan(), multibyte);
    expect(multibyteOutcome.compile).toMatchObject({ status: "non-pass" });
  });

  it("T169 retains stderr and stdout from a failing gate", async () => {
    const executor = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsrc/a.ts\0");
      if (step.args.includes("tsc")) {
        return result("compiler stdout", {
          exitCode: 1,
          stderr: "compiler stderr",
        });
      }
      return result();
    });
    const outcome = await runOutcomePlan(plan(), executor);
    expect(outcome.compile).toEqual({
      status: "non-pass",
      reason: "typecheck failed: compiler stderr\n--- stdout ---\ncompiler stdout",
    });
  });

  it("T179 orders and bounds combined diagnostics while preserving stdout-only text", async () => {
    const bothStreams = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsrc/a.ts\0");
      if (step.args.includes("tsc")) {
        return result("stdout detail", { exitCode: 1, stderr: "stderr detail" });
      }
      return result();
    });
    const combined = await runOutcomePlan(plan(), bothStreams);
    expect(combined.compile).toEqual({
      status: "non-pass",
      reason: "typecheck failed: stderr detail\n--- stdout ---\nstdout detail",
    });

    const oversized = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsrc/a.ts\0");
      if (step.args.includes("tsc")) {
        return result("o".repeat(3_000), {
          exitCode: 1,
          stderr: "e".repeat(3_000),
        });
      }
      return result();
    });
    const truncated = await runOutcomePlan(plan(), oversized);
    expect(truncated.compile).toMatchObject({ status: "non-pass" });
    if (truncated.compile.status === "non-pass") {
      expect(truncated.compile.reason).toContain("[truncated");
      expect(Buffer.byteLength(truncated.compile.reason, "utf8")).toBeLessThan(4_200);
    }

    const stdoutOnly = new FakeExecutor((step) => {
      if (step.args.includes("--numstat")) return result("1\t0\tsrc/a.ts\0");
      if (step.args.includes("tsc")) return result("stdout only", { exitCode: 1 });
      return result();
    });
    expect((await runOutcomePlan(plan(), stdoutOnly)).compile).toEqual({
      status: "non-pass",
      reason: "typecheck failed: stdout only",
    });
  });

  it("T105 maps hostile executor values and throwing getters to total non-pass outcomes", async () => {
    const hostileValues = [
      null,
      { spawned: "true", exitCode: 0, stdout: "", stderr: "" },
      { spawned: true, exitCode: "0", stdout: "", stderr: "" },
      { spawned: true, exitCode: 0, stdout: null, stderr: "" },
      { spawned: true, exitCode: 0, stdout: "", stderr: null },
      { spawned: true, exitCode: 0, stdout: "x".repeat(16_777_217), stderr: "" },
      { spawned: true, exitCode: 0, stdout: "", stderr: "x".repeat(16_777_217) },
      {
        get spawned() { throw new Error("hostile getter"); },
        exitCode: 0, stdout: "", stderr: "",
      },
    ];
    for (const hostile of hostileValues) {
      const executor: GateExecutor = {
        run: () => Promise.resolve(hostile as unknown as GateStepResult),
      };
      await expect(runOutcomePlan(plan(), executor)).resolves.toMatchObject({
        setup: { status: "non-pass" },
        compile: { status: "non-pass" },
        tests: { status: "non-pass" },
        mutation: { applicable: true, gate: { status: "non-pass" } },
      });
    }
    const throwingPlan = { get caseId() { throw new Error("hostile plan"); } } as unknown as OutcomePlanInput;
    await expect(runOutcomePlan(throwingPlan, happyExecutor("1\t0\tsrc/a.ts\0"))).resolves.toEqual({
      caseId: "unknown",
      baseSha: "unknown",
      setup: { status: "non-pass", reason: "environment setup failed" },
      diff: { ok: false, reason: "environment setup failed" },
      compile: { status: "non-pass", reason: "environment setup failed" },
      tests: { status: "non-pass", reason: "environment setup failed" },
      mutation: { applicable: true, gate: { status: "non-pass", reason: "environment setup failed" } },
    });
  });

  it("T116 combines bare rename metadata with destination numstat attribution", async () => {
    const renameOut = await runOutcomePlan(
      plan(renamePatch("snowflake/check_mutation_score.py", "check_mutation_score.py")),
      happyExecutor("1\t1\tcheck_mutation_score.py\0"),
    );
    expect(renameOut.mutation).toEqual({ applicable: true, gate: { status: "pass" } });

    const renameIn = await runOutcomePlan(
      plan(renamePatch("tool.py", "snowflake/tool.py")),
      happyExecutor("1\t1\tsnowflake/tool.py\0"),
    );
    expect(renameIn.mutation).toEqual({ applicable: true, gate: { status: "pass" } });

    const plainEdit = await runOutcomePlan(
      plan(diffPatch("snowflake/tool.py")),
      happyExecutor("1\t1\tsnowflake/tool.py\0"),
    );
    expect(plainEdit.mutation).toEqual({ applicable: true, gate: { status: "pass" } });

    for (const contentLine of [
      "+rename from snowflake/fake.py",
      " rename from snowflake/fake.py",
    ]) {
      const contentOnly = diffPatch("src/a.ts").replace("+new", contentLine);
      const ordinary = await runOutcomePlan(
        plan(contentOnly),
        happyExecutor("1\t1\tsrc/a.ts\0"),
      );
      expect(ordinary.mutation).toEqual({ applicable: false, reason: "no-mutation-surface" });
    }
  });

  it("T117 classifies numstat paths as already-clean repository-relative paths", async () => {
    const outcome = await runOutcomePlan(
      plan(diffPatch("a/foo.ts")),
      happyExecutor(["1\t0\ta/foo.ts", "2\t0\ta/tests/foo.ts", ""].join("\0")),
    );
    expect(outcome.diff).toEqual({
      ok: true,
      measured: { combinedTextualLines: 3, logicLines: 3, testFileLines: 0 },
    });
  });

  it("T121 detects snowflake edits from prefix-independent numstat paths", async () => {
    const patches = [
      [
        "diff --git snowflake/tool.py snowflake/tool.py",
        "--- snowflake/tool.py",
        "+++ snowflake/tool.py",
        "@@ -1 +1 @@", "-old", "+new", "",
      ].join("\n"),
      [
        "diff --git x/snowflake/tool.py y/snowflake/tool.py",
        "--- x/snowflake/tool.py",
        "+++ y/snowflake/tool.py",
        "@@ -1 +1 @@", "-old", "+new", "",
      ].join("\n"),
    ];
    for (const patchText of patches) {
      const outcome = await runOutcomePlan(
        plan(patchText),
        happyExecutor("1\t1\tsnowflake/tool.py\0"),
      );
      expect(outcome.mutation).toEqual({ applicable: true, gate: { status: "pass" } });
    }
  });

  it("T122 detects a C-quoted snowflake rename source", async () => {
    const quotedRenameOut = [
      'diff --git "a/snowflake/\\303\\251.sql" b/renamed.sql',
      "similarity index 100%",
      'rename from "snowflake/\\303\\251.sql"',
      "rename to renamed.sql",
      "",
    ].join("\n");
    const outcome = await runOutcomePlan(
      plan(quotedRenameOut),
      happyExecutor("0\t0\trenamed.sql\0"),
    );
    expect(outcome.mutation).toEqual({ applicable: true, gate: { status: "pass" } });
  });

  it("T106 keeps runner sources answer-isolated and the logic source capability-pure", () => {
    const logic = readFileSync(new URL("../../scripts/factory/eval/outcome-runner-logic.mts", import.meta.url), "utf8");
    const shell = readFileSync(new URL("../../scripts/factory/eval/outcome-runner.mts", import.meta.url), "utf8");
    for (const source of [logic, shell]) expect(source).not.toMatch(/expected-result-schema|expectations\//);
    expect(logic).not.toMatch(/node:fs|child_process|execFile|execSync|spawnSync|spawn\(|https|fetch\(|Date\.now|new Date\(/);
    expect(logic).not.toMatch(/corpus-loader-logic/);
  });

  it("T107 emits the exact closed top-level outcome grammar", async () => {
    const outcome = await runOutcomePlan(plan(), happyExecutor("1\t0\tsrc/a.ts\0"));
    expect(Object.keys(outcome)).toEqual([
      "caseId", "baseSha", "setup", "diff", "compile", "tests", "mutation",
    ]);
  });
});
