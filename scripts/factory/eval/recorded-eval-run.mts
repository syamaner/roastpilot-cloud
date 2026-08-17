import type { LoadedCase, LoadedCorpus } from "./corpus-loader-logic.mts";
import type { ExpectedImplement } from "./expected-result-schema.mts";
import { ISSUE_TYPES } from "./expected-result-schema.mts";
import { prepareRecordedImplementReplay } from "./implement-replay.mts";
import {
  runMeasuredImplementOutcome,
} from "./outcome-runner.mts";
import type {
  GateExecutor,
  OutcomeRuntimeEnvironment,
} from "./outcome-runner-logic.mts";
import {
  scoreCompileOutcome,
  scoreDiffBound,
  scoreMutationOutcome,
  scoreTestOutcome,
  scoreTriageLabel,
  type ScoreResult,
} from "./recorded-scorers.mts";
import { prepareRecordedTriageReplay } from "./triage-replay.mts";

export type DimensionScore = ScoreResult;

export interface RecordedCaseRecord {
  readonly caseId: string;
  readonly stage: "triage-and-implement" | "triage-only";
  readonly issueType: (typeof ISSUE_TYPES)[number];
  readonly dimensions: Readonly<Record<string, DimensionScore>>;
  readonly recordedPrOutcome: ExpectedImplement["prOutcome"] | null;
}

export interface RecordedEvalReport {
  readonly cases: readonly RecordedCaseRecord[];
}

export interface RecordedEvalDependencies {
  readonly executor: GateExecutor;
  readonly sourceRepoRoot: string;
  readonly runtimeEnvironment: OutcomeRuntimeEnvironment;
  readonly temporaryParent?: string;
  readonly runOutcome?: typeof runMeasuredImplementOutcome;
}

type ImplementDimensionName = "compile" | "diffBound" | "mutation" | "tests";

function failed(reason: string): DimensionScore {
  return { pass: false, reason };
}

function failedImplementDimensions(
  reason: string,
): Readonly<Record<ImplementDimensionName, DimensionScore>> {
  return {
    compile: failed(reason),
    diffBound: failed(reason),
    mutation: failed(reason),
    tests: failed(reason),
  };
}

function record(
  loadedCase: LoadedCase,
  triageLabel: DimensionScore,
  implementDimensions?: Readonly<Record<ImplementDimensionName, DimensionScore>>,
): RecordedCaseRecord {
  return {
    caseId: loadedCase.case.caseId,
    stage: loadedCase.case.stage,
    issueType: loadedCase.expected.issueType,
    dimensions: implementDimensions === undefined
      ? { triageLabel }
      : { ...implementDimensions, triageLabel },
    recordedPrOutcome: loadedCase.expected.implement?.prOutcome ?? null,
  };
}

function caseFailure(loadedCase: LoadedCase, reason: string): RecordedCaseRecord {
  const triageLabel = failed(reason);
  return record(
    loadedCase,
    triageLabel,
    loadedCase.case.stage === "triage-only"
      ? undefined
      : failedImplementDimensions(reason),
  );
}

async function runCase(
  loadedCase: LoadedCase,
  deps: RecordedEvalDependencies,
): Promise<RecordedCaseRecord> {
  const triageReplay = prepareRecordedTriageReplay(loadedCase);
  const triageResult = await triageReplay.provider.produce(triageReplay.inputs);
  const triageLabel = triageResult.ok
    ? scoreTriageLabel(triageResult.readiness, loadedCase.expected)
    : failed(`recorded triage provider failed: ${triageResult.errors.join("; ")}`);

  const implementReplay = prepareRecordedImplementReplay(loadedCase);
  const expectsImplement = loadedCase.expected.implement !== null;
  const hasRecordedPatch = implementReplay.kind === "recorded-patch";
  if (expectsImplement !== hasRecordedPatch) {
    return record(
      loadedCase,
      triageLabel,
      failedImplementDimensions(
        "recorded replay kind does not agree with the expected implement result",
      ),
    );
  }

  if (implementReplay.kind === "triage-only") {
    return record(loadedCase, triageLabel);
  }

  const implementResult = await implementReplay.provider.produce(
    implementReplay.inputs,
  );
  if (!implementResult.ok) {
    const reason = `recorded implement provider failed: ${implementResult.errors.join("; ")}`;
    return record(loadedCase, triageLabel, failedImplementDimensions(reason));
  }

  /* v8 ignore next -- unit tests inject runOutcome; the real fallback spawns processes */
  const runOutcome = deps.runOutcome ?? runMeasuredImplementOutcome;
  let outcome;
  try {
    outcome = await runOutcome({
      caseId: loadedCase.case.caseId,
      inputs: implementReplay.inputs,
      patchText: implementResult.patchText,
      sourceRepoRoot: deps.sourceRepoRoot,
      executor: deps.executor,
      runtimeEnvironment: deps.runtimeEnvironment,
      temporaryParent: deps.temporaryParent,
    });
  } catch {
    return record(
      loadedCase,
      triageLabel,
      failedImplementDimensions("recorded outcome runner failed"),
    );
  }
  if (outcome.baseSha !== loadedCase.case.baseSha) {
    const reason = "outcome baseSha does not match the case baseSha";
    return record(loadedCase, triageLabel, failedImplementDimensions(reason));
  }

  return record(
    loadedCase,
    triageLabel,
    {
      compile: scoreCompileOutcome(outcome, loadedCase.expected),
      diffBound: scoreDiffBound(outcome, loadedCase.expected),
      mutation: scoreMutationOutcome(outcome, loadedCase.expected),
      tests: scoreTestOutcome(outcome, loadedCase.expected),
    },
  );
}

export async function runRecordedEval(
  corpus: LoadedCorpus,
  deps: RecordedEvalDependencies,
): Promise<RecordedEvalReport> {
  const cases: RecordedCaseRecord[] = [];
  for (const loadedCase of [...corpus.cases].sort((left, right) =>
    left.case.caseId < right.case.caseId
      ? -1
      : left.case.caseId > right.case.caseId
        ? 1
        : /* v8 ignore next -- caseIds are unique; the equal branch is unreachable */ 0)) {
    try {
      cases.push(await runCase(loadedCase, deps));
    } catch {
      cases.push(caseFailure(loadedCase, "recorded evaluation case failed"));
    }
  }
  return { cases };
}
