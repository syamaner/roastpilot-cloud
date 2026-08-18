import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCorpus } from "../../scripts/factory/eval/corpus-loader.mts";
import type { LoadedCorpus } from "../../scripts/factory/eval/corpus-loader-logic.mts";
import {
  IMPLEMENT_DIMENSIONS,
  TRIAGE_ONLY_DIMENSIONS,
  type EvalBaseline,
} from "../../scripts/factory/eval/eval-baseline-schema.mts";
import {
  computeCorpusSha256,
  type CorpusFileInput,
} from "../../scripts/factory/eval/eval-corpus-hash.mts";
import type {
  GateExecutor,
  GateStepResult,
} from "../../scripts/factory/eval/outcome-runner-logic.mts";
import type {
  RecordedCaseRecord,
  RecordedEvalReport,
} from "../../scripts/factory/eval/recorded-eval-run.mts";
import {
  mainRecordedEval,
  type RecordedEvalMainDependencies,
} from "../../scripts/factory/eval/run-recorded-eval.mts";

const CORPUS_ROOT = new URL("../../eval/corpus/", import.meta.url);
const GITHUB_ROOT = new URL("../../.github/", import.meta.url);
const HASH_FILES: readonly CorpusFileInput[] = [
  {
    relativePath: "eval/corpus/manifest.json",
    bytes: new TextEncoder().encode("synthetic manifest bytes"),
  },
];
const CORPUS_SHA256 = computeCorpusSha256(HASH_FILES);

class FakeExecutor implements GateExecutor {
  run(): Promise<GateStepResult> {
    throw new Error("entrypoint unit tests never execute a real gate");
  }
}

interface CallCounts {
  loadCorpusSnapshot: number;
  readFile: number;
  makeScratchDirectory: number;
  runEval: number;
}

let corpus: LoadedCorpus;

beforeAll(async () => {
  const loaded = await loadCorpus(CORPUS_ROOT.pathname);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(loaded.errors.join("\n"));
  corpus = loaded.value;
});

function passingRecord(loadedCase: LoadedCorpus["cases"][number]): RecordedCaseRecord {
  const triageLabel = { pass: true as const };
  return {
    caseId: loadedCase.case.caseId,
    stage: loadedCase.case.stage,
    issueType: loadedCase.expected.issueType,
    dimensions: loadedCase.case.stage === "triage-only"
      ? { triageLabel }
      : {
          compile: { pass: true },
          diffBound: { pass: true },
          mutation: { pass: true },
          tests: { pass: true },
          triageLabel,
        },
    recordedPrOutcome: loadedCase.expected.implement?.prOutcome ?? null,
  };
}

function passingReport(): RecordedEvalReport {
  return {
    cases: corpus.cases
      .map(passingRecord)
      .sort((left, right) => left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0),
  };
}

function matchingBaseline(): EvalBaseline {
  const cases = corpus.cases
    .map((loadedCase) => ({
      caseId: loadedCase.case.caseId,
      issueType: loadedCase.expected.issueType,
      dimensions: loadedCase.case.stage === "triage-only"
        ? [...TRIAGE_ONLY_DIMENSIONS]
        : [...IMPLEMENT_DIMENSIONS],
    }))
    .sort((left, right) => left.caseId < right.caseId ? -1 : left.caseId > right.caseId ? 1 : 0);
  return {
    schemaVersion: 1,
    corpus: {
      corpusSha256: CORPUS_SHA256,
      caseIds: cases.map((entry) => entry.caseId),
    },
    cases,
  };
}

function dependencies(
  overrides: Partial<RecordedEvalMainDependencies> = {},
): { deps: RecordedEvalMainDependencies; counts: CallCounts; output: string[] } {
  const counts: CallCounts = {
    loadCorpusSnapshot: 0,
    readFile: 0,
    makeScratchDirectory: 0,
    runEval: 0,
  };
  const output: string[] = [];
  const deps: RecordedEvalMainDependencies = {
    env: { FACTORY_EVAL_ENABLED: "true", PATH: "/safe/bin", HOME: "/operator/home" },
    argv: [],
    stdout: (line) => output.push(line),
    readFile: async () => {
      counts.readFile += 1;
      return JSON.stringify(matchingBaseline());
    },
    loadCorpusSnapshot: async () => {
      counts.loadCorpusSnapshot += 1;
      return { ok: true, value: corpus, hashInput: [...HASH_FILES] };
    },
    runEval: async () => {
      counts.runEval += 1;
      return passingReport();
    },
    makeScratchDirectory: async () => {
      counts.makeScratchDirectory += 1;
      return "/scratch/eval-home";
    },
    executor: new FakeExecutor(),
    ...overrides,
  };
  return { deps, counts, output };
}

function expectNoOperationalCalls(counts: CallCounts): void {
  expect(counts).toEqual({
    loadCorpusSnapshot: 0,
    readFile: 0,
    makeScratchDirectory: 0,
    runEval: 0,
  });
}

describe("recorded evaluation entrypoint", () => {
  it("T162 gates before every read, scratch allocation, executor use, or run", async () => {
    for (const value of [undefined, "TRUE", "1"]) {
      const { deps, counts, output } = dependencies({
        env: { FACTORY_EVAL_ENABLED: value },
      });
      await expect(mainRecordedEval(deps)).resolves.toBe(2);
      expect(output).toEqual(["FACTORY_EVAL_ENABLED INACTIVE"]);
      expectNoOperationalCalls(counts);
    }
  });

  it("T198 loads one snapshot, attests its digest, and wires a scratch HOME into the recorded run", async () => {
    let runDependencies:
      | Parameters<RecordedEvalMainDependencies["runEval"]>[1]
      | undefined;
    let evaluatedCorpus: LoadedCorpus | undefined;
    let loadedPath: string | undefined;
    let loadedPrefix: string | undefined;
    let baselinePath: string | undefined;
    const fixture = dependencies({
      loadCorpusSnapshot: async (path, prefix) => {
        fixture.counts.loadCorpusSnapshot += 1;
        loadedPath = path;
        loadedPrefix = prefix;
        return { ok: true, value: corpus, hashInput: [...HASH_FILES] };
      },
      readFile: async (path) => {
        fixture.counts.readFile += 1;
        baselinePath = path;
        return JSON.stringify(matchingBaseline());
      },
      runEval: async (loadedCorpus, deps) => {
        fixture.counts.runEval += 1;
        evaluatedCorpus = loadedCorpus;
        runDependencies = deps;
        return passingReport();
      },
    });
    await expect(mainRecordedEval(fixture.deps)).resolves.toBe(0);
    expect(JSON.parse(fixture.output[0]!) as unknown).toEqual({ pass: true });
    expect(runDependencies?.runtimeEnvironment).toEqual({
      path: "/safe/bin",
      home: "/scratch/eval-home",
    });
    expect(runDependencies?.runtimeEnvironment.home).not.toBe("/operator/home");
    expect(runDependencies?.executor).toBe(fixture.deps.executor);
    expect(runDependencies?.sourceRepoRoot).toBe(
      fileURLToPath(new URL("../../", import.meta.url)),
    );
    const expectedCorpusRoot = join(
      fileURLToPath(new URL("../../", import.meta.url)),
      "eval",
      "corpus",
    );
    expect(loadedPath).toBe(expectedCorpusRoot);
    expect(loadedPrefix).toBe("eval/corpus/");
    expect(fixture.counts.loadCorpusSnapshot).toBe(1);
    expect(evaluatedCorpus).toBe(corpus);
    expect(baselinePath).toBe(
      join(
        fileURLToPath(new URL("../../", import.meta.url)),
        "eval",
        "baseline",
        "recorded-baseline.json",
      ),
    );

    let fallbackPath: string | undefined;
    const fallback = dependencies({
      env: { FACTORY_EVAL_ENABLED: "true" },
      runEval: async (_corpus, deps) => {
        fallbackPath = deps.runtimeEnvironment.path;
        return passingReport();
      },
    });
    await expect(mainRecordedEval(fallback.deps)).resolves.toBe(0);
    expect(fallbackPath).toBe("/usr/bin:/bin");
  });

  it("T164 treats any baseline read or validation failure as non-pass while emitting an all-pass candidate", async () => {
    const invalidBaselineReads = [
      async () => { throw new Error("missing baseline"); },
      async () => "{",
      async () => "x".repeat(65_537),
    ];
    for (const readFile of invalidBaselineReads) {
      const fixture = dependencies({ argv: ["--emit-candidate"], readFile });
      await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
      expect(JSON.parse(fixture.output[0]!) as { reasons: string[] }).toMatchObject({
        pass: false,
        reasons: expect.arrayContaining([
          expect.stringContaining("absent baseline"),
        ]),
      });
      expect(fixture.output[1]).toMatch(/^RECORDED_EVAL_CANDIDATE /);
      const candidate = JSON.parse(
        fixture.output[1]!.replace(/^RECORDED_EVAL_CANDIDATE /, ""),
      ) as EvalBaseline;
      expect(candidate.corpus.corpusSha256).toBe(CORPUS_SHA256);
      expect(candidate.corpus.caseIds).toEqual(matchingBaseline().corpus.caseIds);
    }

  });

  it("T196 fails closed when snapshot loading rejects or throws", async () => {
    const failures: Array<{
      loadCorpusSnapshot: RecordedEvalMainDependencies["loadCorpusSnapshot"];
      output: string;
    }> = [
      {
        loadCorpusSnapshot: async () => ({
          ok: false,
          errors: ["synthetic corpus error"],
        }),
        output: JSON.stringify({ pass: false, reasons: ["synthetic corpus error"] }),
      },
      {
        loadCorpusSnapshot: async () => {
          throw new Error("synthetic corpus exception");
        },
        output: JSON.stringify({ pass: false, reasons: ["corpus load failed"] }),
      },
    ];
    for (const failure of failures) {
      const fixture = dependencies({
        loadCorpusSnapshot: failure.loadCorpusSnapshot,
      });
      await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
      expect(fixture.output).toEqual([failure.output]);
      expect(fixture.counts.readFile).toBe(0);
      expect(fixture.counts.makeScratchDirectory).toBe(0);
      expect(fixture.counts.runEval).toBe(0);
    }
  });

  it("T197 fails closed when hashing the loaded snapshot throws", async () => {
    const fixture = dependencies({
      loadCorpusSnapshot: async () => ({
        ok: true,
        value: corpus,
        hashInput: [],
      }),
    });
    await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
    expect(fixture.output).toEqual([
      JSON.stringify({ pass: false, reasons: ["corpus hashing failed"] }),
    ]);
    expect(fixture.counts.readFile).toBe(0);
    expect(fixture.counts.makeScratchDirectory).toBe(0);
    expect(fixture.counts.runEval).toBe(0);
  });

  it("T165 never emits a candidate when any scored dimension is non-pass", async () => {
    const nonPassReport = passingReport();
    const first = nonPassReport.cases[0]!;
    const fixture = dependencies({
      argv: ["--emit-candidate"],
      runEval: async () => ({
        cases: [
          {
            ...first,
            dimensions: {
              ...first.dimensions,
              triageLabel: { pass: false, reason: "synthetic mismatch" },
            },
          },
          ...nonPassReport.cases.slice(1),
        ],
      }),
    });
    await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
    expect(fixture.output).toHaveLength(1);
    expect(fixture.output[0]).toContain("synthetic mismatch");
  });

  it("T166 rejects unknown argv before any operational dependency runs", async () => {
    const { deps, counts, output } = dependencies({ argv: ["--unknown"] });
    await expect(mainRecordedEval(deps)).resolves.toBe(1);
    expect(output).toEqual([
      "usage: node scripts/factory/eval/run-recorded-eval.mts [--emit-candidate]",
    ]);
    expectNoOperationalCalls(counts);
  });

  it("T167 keeps the entrypoint and corpus hash modules free of file-write capability", () => {
    for (const relativePath of [
      "../../scripts/factory/eval/run-recorded-eval.mts",
      "../../scripts/factory/eval/eval-corpus-hash.mts",
    ]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).not.toMatch(/\b(?:writeFile|appendFile|createWriteStream)\b/);
    }
    const entrypoint = readFileSync(
      new URL("../../scripts/factory/eval/run-recorded-eval.mts", import.meta.url),
      "utf8",
    );
    expect(entrypoint).not.toMatch(/readonly\s+(?:write|append)/);
  });

  it("T195 keeps the entrypoint on the snapshot's single corpus walk", () => {
    const source = readFileSync(
      new URL("../../scripts/factory/eval/run-recorded-eval.mts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("enumerateCorpusFiles");
    expect(source).not.toMatch(/\bloadCorpus\s*\(/);
    expect(source.match(/deps\.loadCorpusSnapshot\s*\(/g)).toHaveLength(1);
    expect(source).toContain("computeCorpusSha256(hashInput)");
    expect(source).not.toMatch(/(?:readTextFile|deps\.readFile)\s*\(\s*CORPUS_ROOT/);
  });

  it("T168 keeps the dark evaluation surface out of every GitHub workflow file", () => {
    const entries = readdirSync(GITHUB_ROOT, { recursive: true, withFileTypes: true });
    const sources = entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"));
    expect(sources.join("\n")).not.toMatch(
      /FACTORY_EVAL_ENABLED|run-recorded-eval|recorded-eval-run|eval-corpus-hash/,
    );
  });

  it("T180 suppresses a candidate when report and corpus case counts differ", async () => {
    const report = passingReport();
    const fixture = dependencies({
      argv: ["--emit-candidate"],
      runEval: async () => ({ cases: report.cases.slice(1) }),
    });
    await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
    expect(fixture.output).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^RECORDED_EVAL_CANDIDATE /)]),
    );
  });

  it("T181 suppresses a candidate when the report repeats a caseId", async () => {
    const report = passingReport();
    const fixture = dependencies({
      argv: ["--emit-candidate"],
      runEval: async () => ({
        cases: [report.cases[0]!, ...report.cases.slice(0, -1)],
      }),
    });
    await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
    expect(fixture.output).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^RECORDED_EVAL_CANDIDATE /)]),
    );
  });

  it("T182 suppresses a candidate when a record mismatches its loaded case", async () => {
    const report = passingReport();
    const first = report.cases[0]!;
    const second = report.cases[1]!;
    const third = report.cases[2]!;
    const fixture = dependencies({
      argv: ["--emit-candidate"],
      runEval: async () => ({
        cases: [
          second,
          third,
          {
            ...first,
            stage: first.stage === "triage-only"
              ? "triage-and-implement" as const
              : "triage-only" as const,
          },
          ...report.cases.slice(3),
        ],
      }),
    });
    await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
    expect(fixture.output).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^RECORDED_EVAL_CANDIDATE /)]),
    );
  });

  it("T183 suppresses a candidate when the corpus caseId set changes", async () => {
    const first = corpus.cases[0]!;
    const second = corpus.cases[1]!;
    let lengthReads = 0;
    const changingCases = new Proxy([first, second], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return lengthReads <= 2 ? 1 : Reflect.get(target, property, receiver);
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const changingCorpus: LoadedCorpus = { ...corpus, cases: changingCases };
    const fixture = dependencies({
      argv: ["--emit-candidate"],
      loadCorpusSnapshot: async () => ({
        ok: true,
        value: changingCorpus,
        hashInput: [...HASH_FILES],
      }),
      runEval: async () => ({ cases: [passingRecord(first)] }),
    });
    await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
    expect(fixture.output).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^RECORDED_EVAL_CANDIDATE /)]),
    );
  });

  it("T186 treats a schema-invalid baseline as absent", async () => {
    const fixture = dependencies({ readFile: async () => "{}" });
    await expect(mainRecordedEval(fixture.deps)).resolves.toBe(1);
    expect(JSON.parse(fixture.output[0]!) as { pass: boolean; reasons: string[] }).toMatchObject({
      pass: false,
      reasons: expect.arrayContaining([expect.stringContaining("absent baseline")]),
    });
  });
});
