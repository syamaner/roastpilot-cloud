import { readFile as readTextFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CORPUS_REPO_PREFIX,
  loadCorpusSnapshot,
} from "./corpus-loader.mts";
import type { LoadedCorpus } from "./corpus-loader-logic.mts";
import type { CorpusFileInput } from "./eval-corpus-hash.mts";
import {
  IMPLEMENT_DIMENSIONS,
  MAX_BASELINE_BYTES,
  TRIAGE_ONLY_DIMENSIONS,
  validateEvalBaseline,
  type EvalBaseline,
} from "./eval-baseline-schema.mts";
import { computeCorpusSha256 } from "./eval-corpus-hash.mts";
import {
  FACTORY_EVAL_ENABLED_VARIABLE,
  isEvalEnabled,
} from "./eval-gating.mts";
import { evaluateAgainstBaseline } from "./eval-verdict-logic.mts";
import {
  runRecordedEval,
  type RecordedEvalDependencies,
  type RecordedEvalReport,
} from "./recorded-eval-run.mts";
import { SpawnSyncGateExecutor } from "./outcome-runner.mts";
import type { GateExecutor } from "./outcome-runner-logic.mts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORPUS_ROOT = join(REPOSITORY_ROOT, "eval", "corpus");
const BASELINE_PATH = join(
  REPOSITORY_ROOT,
  "eval",
  "baseline",
  "recorded-baseline.json",
);

export interface RecordedEvalMainDependencies {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly argv: readonly string[];
  readonly stdout: (line: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly loadCorpusSnapshot: typeof loadCorpusSnapshot;
  readonly runEval: typeof runRecordedEval;
  readonly makeScratchDirectory: () => Promise<string>;
  readonly executor?: GateExecutor;
}

function parseBaseline(text: string): EvalBaseline | undefined {
  try {
    if (Buffer.byteLength(text, "utf8") > MAX_BASELINE_BYTES) return undefined;
    const result = validateEvalBaseline(JSON.parse(text) as unknown);
    return result.ok ? result.value : undefined;
  } catch {
    return undefined;
  }
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function candidateBaseline(
  corpus: LoadedCorpus,
  report: RecordedEvalReport,
  corpusSha256: string,
): EvalBaseline | undefined {
  if (corpus.cases.length === 0 || report.cases.length !== corpus.cases.length) {
    return undefined;
  }
  const loadedByCaseId = new Map(
    corpus.cases.map((loadedCase) => [loadedCase.case.caseId, loadedCase] as const),
  );
  const sortedRecords = [...report.cases].sort((left, right) =>
    left.caseId < right.caseId
      ? -1
      : left.caseId > right.caseId
        ? 1
        : /* v8 ignore next -- caseIds are unique; the equal branch is unreachable */ 0);
  if (new Set(sortedRecords.map((record) => record.caseId)).size !== sortedRecords.length) {
    return undefined;
  }

  const cases: EvalBaseline["cases"][number][] = [];
  for (const record of sortedRecords) {
    const loadedCase = loadedByCaseId.get(record.caseId);
    if (
      loadedCase === undefined ||
      record.stage !== loadedCase.case.stage ||
      record.issueType !== loadedCase.expected.issueType
    ) {
      return undefined;
    }
    const dimensionNames = Object.keys(record.dimensions).sort();
    const requiredDimensions = record.stage === "triage-and-implement"
      ? IMPLEMENT_DIMENSIONS
      : TRIAGE_ONLY_DIMENSIONS;
    if (
      !sameOrderedStrings(dimensionNames, requiredDimensions) ||
      Object.values(record.dimensions).some((dimension) => dimension.pass !== true)
    ) {
      return undefined;
    }
    cases.push({
      caseId: record.caseId,
      issueType: record.issueType,
      dimensions: dimensionNames,
    });
  }

  const caseIds = cases.map((entry) => entry.caseId);
  if (!sameOrderedStrings(caseIds, [...loadedByCaseId.keys()].sort())) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    corpus: { corpusSha256, caseIds },
    cases,
  };
}

export async function mainRecordedEval(
  deps: RecordedEvalMainDependencies,
): Promise<0 | 1 | 2> {
  if (!isEvalEnabled(deps.env[FACTORY_EVAL_ENABLED_VARIABLE])) {
    deps.stdout(`${FACTORY_EVAL_ENABLED_VARIABLE} INACTIVE`);
    return 2;
  }

  const emitCandidate = deps.argv.length === 1 && deps.argv[0] === "--emit-candidate";
  if (deps.argv.length !== 0 && !emitCandidate) {
    deps.stdout("usage: node scripts/factory/eval/run-recorded-eval.mts [--emit-candidate]");
    return 1;
  }

  let corpus: LoadedCorpus;
  let hashInput: readonly CorpusFileInput[];
  try {
    const loaded = await deps.loadCorpusSnapshot(CORPUS_ROOT, CORPUS_REPO_PREFIX);
    if (!loaded.ok) {
      deps.stdout(JSON.stringify({ pass: false, reasons: loaded.errors }));
      return 1;
    }
    corpus = loaded.value;
    hashInput = loaded.hashInput;
  } catch {
    deps.stdout(JSON.stringify({ pass: false, reasons: ["corpus load failed"] }));
    return 1;
  }

  let corpusSha256: string;
  try {
    corpusSha256 = computeCorpusSha256(hashInput);
  } catch {
    deps.stdout(JSON.stringify({ pass: false, reasons: ["corpus hashing failed"] }));
    return 1;
  }

  let baseline: EvalBaseline | undefined;
  try {
    baseline = parseBaseline(await deps.readFile(BASELINE_PATH));
  } catch {
    baseline = undefined;
  }

  const runtimeEnvironment = {
    path: deps.env.PATH ?? "/usr/bin:/bin",
    home: await deps.makeScratchDirectory(),
  };
  const runDependencies: RecordedEvalDependencies = {
    /* v8 ignore next -- unit tests inject an executor; the real fallback spawns processes */
    executor: deps.executor ?? new SpawnSyncGateExecutor(),
    sourceRepoRoot: REPOSITORY_ROOT,
    runtimeEnvironment,
  };
  const report = await deps.runEval(corpus, runDependencies);
  const verdict = evaluateAgainstBaseline(report, baseline, corpusSha256);
  deps.stdout(JSON.stringify(verdict));

  if (emitCandidate) {
    const candidate = candidateBaseline(corpus, report, corpusSha256);
    if (candidate !== undefined) {
      deps.stdout(`RECORDED_EVAL_CANDIDATE ${JSON.stringify(candidate)}`);
    }
  }
  return verdict.pass ? 0 : 1;
}

/* v8 ignore start -- unit tests import mainRecordedEval and inject a fake scratch-dir factory; real wiring runs only through direct script execution */
async function makeScratchDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "roastpilot-recorded-eval-home-"));
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exitCode = await mainRecordedEval({
    env: process.env,
    argv: process.argv.slice(2),
    stdout: (line) => console.log(line),
    readFile: (path) => readTextFile(path, "utf8"),
    loadCorpusSnapshot,
    runEval: runRecordedEval,
    makeScratchDirectory,
  });
}
/* v8 ignore stop */
