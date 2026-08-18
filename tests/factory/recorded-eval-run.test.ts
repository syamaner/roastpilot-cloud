import { beforeAll, describe, expect, it } from "vitest";
import { loadCorpus } from "../../scripts/factory/eval/corpus-loader.mts";
import type {
  LoadedCase,
  LoadedCorpus,
} from "../../scripts/factory/eval/corpus-loader-logic.mts";
import type { RunMeasuredImplementOutcomeInput } from "../../scripts/factory/eval/outcome-runner.mts";
import type {
  GateExecutor,
  GateStepResult,
  MeasuredImplementOutcome,
} from "../../scripts/factory/eval/outcome-runner-logic.mts";
import { runRecordedEval } from "../../scripts/factory/eval/recorded-eval-run.mts";

const CORPUS_ROOT = new URL("../../eval/corpus/", import.meta.url);
const SOURCE_ROOT = "/source/repository";
const RUNTIME_ENVIRONMENT = { path: "/safe/bin", home: "/scratch/home" };

class NeverRunExecutor implements GateExecutor {
  run(): Promise<GateStepResult> {
    throw new Error("the fake runOutcome must prevent executor use");
  }
}

const executor = new NeverRunExecutor();
let corpus: LoadedCorpus;

beforeAll(async () => {
  const loaded = await loadCorpus(CORPUS_ROOT.pathname);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
  corpus = loaded.value;
});

function singleCase(loadedCase: LoadedCase): LoadedCorpus {
  return { ...corpus, cases: [loadedCase] };
}

function implementCase(): LoadedCase {
  const loadedCase = corpus.cases.find((candidate) => candidate.expected.implement !== null);
  if (loadedCase === undefined) throw new Error("implement corpus case is missing");
  return loadedCase;
}

function triageOnlyCase(): LoadedCase {
  const loadedCase = corpus.cases.find((candidate) => candidate.expected.implement === null);
  if (loadedCase === undefined) throw new Error("triage-only corpus case is missing");
  return loadedCase;
}

function passingOutcome(loadedCase: LoadedCase): MeasuredImplementOutcome {
  const expected = loadedCase.expected.implement;
  if (expected === null) throw new Error("passing outcome needs an implement case");
  return {
    caseId: loadedCase.case.caseId,
    baseSha: loadedCase.case.baseSha,
    setup: { status: "pass" },
    diff: {
      ok: true,
      measured: {
        combinedTextualLines: expected.implementLogicLines,
        logicLines: expected.implementLogicLines,
        testFileLines: 0,
      },
    },
    compile: { status: "pass" },
    tests: { status: "pass" },
    mutation: expected.mutation === null
      ? { applicable: false, reason: "no-mutation-surface" }
      : {
          applicable: true,
          gate: expected.mutation.expectedGatePass
            ? { status: "pass" }
            : { status: "non-pass", reason: "recorded mutation failure" },
        },
  };
}

function dependencies(
  runOutcome: (request: RunMeasuredImplementOutcomeInput) => Promise<MeasuredImplementOutcome>,
) {
  return {
    executor,
    sourceRepoRoot: SOURCE_ROOT,
    runtimeEnvironment: RUNTIME_ENVIRONMENT,
    temporaryParent: "/scratch/parent",
    runOutcome,
  } as const;
}

describe("recorded evaluation orchestration", () => {
  it("T156 runs an implement case end-to-end with injected dependencies", async () => {
    const loadedCase = implementCase();
    let received: RunMeasuredImplementOutcomeInput | undefined;
    const report = await runRecordedEval(
      singleCase(loadedCase),
      dependencies(async (request) => {
        received = request;
        return passingOutcome(loadedCase);
      }),
    );

    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]).toEqual({
      caseId: loadedCase.case.caseId,
      stage: "triage-and-implement",
      issueType: loadedCase.expected.issueType,
      dimensions: {
        compile: { pass: true },
        diffBound: { pass: true },
        mutation: { pass: true },
        tests: { pass: true },
        triageLabel: { pass: true },
      },
      recordedPrOutcome: loadedCase.expected.implement?.prOutcome,
    });
    expect(received).toMatchObject({
      caseId: loadedCase.case.caseId,
      sourceRepoRoot: SOURCE_ROOT,
      executor,
      runtimeEnvironment: RUNTIME_ENVIRONMENT,
      temporaryParent: "/scratch/parent",
    });
  });

  it("T157 records exactly the triage dimension for a triage-only case", async () => {
    const loadedCase = triageOnlyCase();
    const report = await runRecordedEval(
      singleCase(loadedCase),
      dependencies(async () => {
        throw new Error("triage-only replay must not run an implement outcome");
      }),
    );
    expect(report.cases[0]).toMatchObject({
      caseId: loadedCase.case.caseId,
      dimensions: { triageLabel: { pass: true } },
      recordedPrOutcome: null,
    });
    expect(Object.keys(report.cases[0]!.dimensions)).toEqual(["triageLabel"]);
  });

  it("T158 retains a case and marks triage non-pass when the recorded verdict is invalid JSON", async () => {
    const original = implementCase();
    const loadedCase = { ...original, recordedTriageVerdictText: "{" };
    const report = await runRecordedEval(
      singleCase(loadedCase),
      dependencies(async () => passingOutcome(original)),
    );
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]!.dimensions.triageLabel).toEqual({
      pass: false,
      reason: expect.stringContaining("not valid JSON"),
    });

    const invalidPatch = {
      ...original,
      recordedImplementPatchText: "not a unified diff",
    };
    const patchReport = await runRecordedEval(
      singleCase(invalidPatch),
      dependencies(async () => {
        throw new Error("a rejected patch must not reach runOutcome");
      }),
    );
    for (const name of ["compile", "diffBound", "mutation", "tests"] as const) {
      expect(patchReport.cases[0]!.dimensions[name]).toEqual({
        pass: false,
        reason: expect.stringContaining("recorded implement provider failed"),
      });
    }
  });

  it("T159 makes all four implement dimensions non-pass on a baseSha mismatch", async () => {
    const loadedCase = implementCase();
    const report = await runRecordedEval(
      singleCase(loadedCase),
      dependencies(async () => ({
        ...passingOutcome(loadedCase),
        baseSha: "f".repeat(40),
      })),
    );
    for (const name of ["compile", "diffBound", "mutation", "tests"] as const) {
      expect(report.cases[0]!.dimensions[name]).toEqual({
        pass: false,
        reason: "outcome baseSha does not match the case baseSha",
      });
    }
    expect(report.cases[0]!.dimensions.triageLabel).toEqual({ pass: true });
  });

  it("T160 resolves with non-pass implement dimensions when runOutcome throws", async () => {
    const loadedCase = implementCase();
    const report = await runRecordedEval(
      singleCase(loadedCase),
      dependencies(async () => {
        throw new Error("synthetic runner failure");
      }),
    );
    for (const name of ["compile", "diffBound", "mutation", "tests"] as const) {
      expect(report.cases[0]!.dimensions[name]).toEqual({
        pass: false,
        reason: "recorded outcome runner failed",
      });
    }
    expect(report.cases[0]!.dimensions.triageLabel).toEqual({ pass: true });
  });

  it("T161 rejects a replay-kind and expected-result inconsistency", async () => {
    const original = implementCase();
    const loadedCase: LoadedCase = {
      ...original,
      expected: {
        ...original.expected,
        implement: null,
        sizeClass: null,
        outcomeClass: null,
      },
    };
    const report = await runRecordedEval(
      singleCase(loadedCase),
      dependencies(async () => passingOutcome(original)),
    );
    for (const name of ["compile", "diffBound", "mutation", "tests"] as const) {
      expect(report.cases[0]!.dimensions[name]).toEqual({
        pass: false,
        reason: "recorded replay kind does not agree with the expected implement result",
      });
    }
  });

  it("T184 retains an all-non-pass case when runCase throws", async () => {
    const original = implementCase();
    const throwingCase: LoadedCase = {
      ...original,
      get recordedImplementPatchText(): string | null {
        throw new Error("synthetic unguarded replay preparation failure");
      },
    };
    const evaluation = runRecordedEval(
      singleCase(throwingCase),
      dependencies(async () => passingOutcome(original)),
    );
    await expect(evaluation).resolves.toMatchObject({
      cases: [{ caseId: original.case.caseId }],
    });
    const report = await evaluation;
    expect(report.cases).toHaveLength(1);
    expect(Object.values(report.cases[0]!.dimensions)).toHaveLength(5);
    for (const dimension of Object.values(report.cases[0]!.dimensions)) {
      expect(dimension).toEqual({
        pass: false,
        reason: "recorded evaluation case failed",
      });
    }
  });

  it("T185 sorts an out-of-order multi-case corpus by caseId", async () => {
    const selected = corpus.cases
      .filter((loadedCase) => loadedCase.case.stage === "triage-only")
      .slice(0, 3)
      .sort((left, right) => left.case.caseId < right.case.caseId ? -1 : 1);
    expect(selected).toHaveLength(3);
    const outOfOrder = [selected[1]!, selected[2]!, selected[0]!];
    const report = await runRecordedEval(
      { ...corpus, cases: outOfOrder },
      dependencies(async () => {
        throw new Error("triage-only cases must not run an implement outcome");
      }),
    );
    expect(report.cases.map((entry) => entry.caseId)).toEqual(
      selected.map((loadedCase) => loadedCase.case.caseId),
    );
  });

  it("T187 retains only a non-pass triage dimension when a triage-only runCase throws", async () => {
    const original = triageOnlyCase();
    const throwingCase: LoadedCase = {
      ...original,
      get recordedTriageVerdictText(): string {
        throw new Error("synthetic unguarded triage replay preparation failure");
      },
    };
    const report = await runRecordedEval(
      singleCase(throwingCase),
      dependencies(async () => {
        throw new Error("triage-only case must not run an implement outcome");
      }),
    );
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0]).toMatchObject({
      caseId: original.case.caseId,
      dimensions: {
        triageLabel: {
          pass: false,
          reason: "recorded evaluation case failed",
        },
      },
    });
    expect(Object.keys(report.cases[0]!.dimensions)).toEqual(["triageLabel"]);
  });
});
