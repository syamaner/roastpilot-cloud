import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateExpectedResult, type ExpectedResult } from "../../scripts/factory/eval/expected-result-schema.mts";
import {
  scoreCompileOutcome,
  scoreDiffBound,
  scoreMutationOutcome,
  scorePrOutcome,
  scoreTestOutcome,
  scoreTriageLabel,
} from "../../scripts/factory/eval/recorded-scorers.mts";

function expected(implement = true): ExpectedResult {
  const raw = {
    schemaVersion: 1, caseId: "issue-009-example", issueType: "feature",
    triageOutcomeClass: "ready", execution: "factory",
    sizeClass: implement ? "small" : null, outcomeClass: implement ? "clean-pass" : null,
    provenance: "historical-artifact", triage: { expectedReadiness: "needs-info" },
    implement: implement ? {
      compile: "pass", tests: "pass", implementLogicLines: 0,
      diffBound: { expectedWithinEnvelope: true }, mutation: null,
      prOutcome: { merged: true, firstPassCiGreen: false, postOpenReviewRounds: 0 },
    } : null,
  };
  const result = validateExpectedResult(raw);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
}

function scoredExpected(options: {
  execution?: "factory" | "conventional";
  withinEnvelope?: boolean;
  mutation?: null | { expectedGatePass: boolean };
  implement?: boolean;
} = {}): ExpectedResult {
  const value = expected(options.implement ?? true);
  if (value.implement === null) return value;
  return {
    ...value,
    execution: options.execution ?? "factory",
    implement: {
      ...value.implement,
      diffBound: { expectedWithinEnvelope: options.withinEnvelope ?? true },
      mutation: options.mutation === undefined ? null : options.mutation,
    },
  };
}

function outcome(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: "issue-009-example",
    baseSha: "0123456789abcdef0123456789abcdef01234567",
    setup: { status: "pass" },
    diff: {
      ok: true,
      measured: { combinedTextualLines: 1, logicLines: 1, testFileLines: 0 },
    },
    compile: { status: "pass" },
    tests: { status: "pass" },
    mutation: { applicable: false, reason: "no-mutation-surface" },
    ...overrides,
  };
}

describe("recorded scorers", () => {
  it("T52 scores only a byte-identical triage label", () => {
    expect(scoreTriageLabel("needs-info", expected())).toEqual({ pass: true });
    for (const value of ["wontfix", "Needs-Info", " needs-info ", undefined, null, 1, {}, "plausible"]) {
      expect(scoreTriageLabel(value, expected()).pass).toBe(false);
    }
  });

  it("T53 scores the exact closed PR-outcome triple", () => {
    const exact = { merged: true, firstPassCiGreen: false, postOpenReviewRounds: 0 };
    expect(scorePrOutcome(exact, expected())).toEqual({ pass: true });
    const mutations: unknown[] = [
      { ...exact, merged: false }, { ...exact, firstPassCiGreen: true },
      { ...exact, postOpenReviewRounds: 1 }, { ...exact, merged: 1 },
      { ...exact, merged: "true" }, { ...exact, postOpenReviewRounds: 1.0000001 },
      { ...exact, postOpenReviewRounds: -1 }, { ...exact, postOpenReviewRounds: Number.NaN },
      { ...exact, postOpenReviewRounds: "1" }, { ...exact, extra: true },
      { merged: true, firstPassCiGreen: false }, [], null,
    ];
    for (const value of mutations) expect(scorePrOutcome(value, expected()).pass).toBe(false);
    expect(scorePrOutcome(exact, expected(false))).toEqual({ pass: false, reason: "triage-only case has no PR outcome" });
  });

  it("T54 keeps all four pure modules free of ambient capabilities", () => {
    for (const path of [
      "validation-common.mts", "expected-result-schema.mts",
      "recorded-scorers.mts", "corpus-loader-logic.mts",
    ]) {
      const source = readFileSync(new URL(`../../scripts/factory/eval/${path}`, import.meta.url), "utf8");
      expect(source).not.toMatch(/node:fs|child_process|https|fetch\(|Date\.now|new Date\(/);
    }
  });

  it("T61 scores expected zero against produced zero", () => {
    expect(scorePrOutcome({ merged: true, firstPassCiGreen: false, postOpenReviewRounds: 0 }, expected())).toEqual({ pass: true });
  });

  it("fails closed for uninspectable PR-outcome objects", () => {
    const throwingOwnKeys = new Proxy({}, {
      ownKeys() { throw new Error("hostile ownKeys"); },
    });
    const throwingGetter = {
      get merged() { throw new Error("hostile getter"); },
      firstPassCiGreen: false,
      postOpenReviewRounds: 0,
    };
    for (const produced of [throwingOwnKeys, throwingGetter]) {
      expect(() => scorePrOutcome(produced, expected())).not.toThrow();
      expect(scorePrOutcome(produced, expected())).toEqual({
        pass: false,
        reason: "produced PR outcome is not inspectable",
      });
    }
  });

  it("T108 scores compile pass, mismatch, shape, triage-only, and hostile arms", () => {
    expect(scoreCompileOutcome(outcome(), scoredExpected())).toEqual({ pass: true });
    expect(scoreCompileOutcome(outcome({ compile: { status: "non-pass", reason: "failed" } }), scoredExpected()).pass).toBe(false);
    for (const compile of [{ status: "pass", extra: true }, { status: "non-pass" }, null, "pass"]) {
      expect(scoreCompileOutcome(outcome({ compile }), scoredExpected()).pass).toBe(false);
    }
    for (const produced of [null, { ...outcome(), compile: { status: 1 } }, { ...outcome(), compile: { status: "unknown" } }]) {
      expect(scoreCompileOutcome(produced, scoredExpected()).pass).toBe(false);
    }
    const missing = outcome(); delete missing.compile;
    expect(scoreCompileOutcome(missing, scoredExpected()).pass).toBe(false);
    expect(scoreCompileOutcome(outcome(), scoredExpected({ implement: false }))).toEqual({ pass: false, reason: "triage-only case has no implement outcome" });
    const hostile = new Proxy(outcome(), { ownKeys() { throw new Error("hostile"); } });
    expect(() => scoreCompileOutcome(hostile, scoredExpected())).not.toThrow();
    expect(scoreCompileOutcome(hostile, scoredExpected()).pass).toBe(false);
  });

  it("T109 scores test pass, mismatch, shape, triage-only, and hostile arms", () => {
    expect(scoreTestOutcome(outcome(), scoredExpected())).toEqual({ pass: true });
    expect(scoreTestOutcome(outcome({ tests: { status: "non-pass", reason: "failed" } }), scoredExpected()).pass).toBe(false);
    expect(scoreTestOutcome(outcome({ tests: { status: "pass", extra: true } }), scoredExpected()).pass).toBe(false);
    expect(scoreTestOutcome({ ...outcome(), extra: true }, scoredExpected()).pass).toBe(false);
    expect(scoreTestOutcome(outcome(), scoredExpected({ implement: false }))).toEqual({ pass: false, reason: "triage-only case has no implement outcome" });
    const hostile = { ...outcome(), get tests() { throw new Error("hostile"); } };
    expect(() => scoreTestOutcome(hostile, scoredExpected())).not.toThrow();
    expect(scoreTestOutcome(hostile, scoredExpected()).pass).toBe(false);
  });

  it("T110 scores the exact 400/401 diff boundary for both execution bases", () => {
    function measured(combinedTextualLines: number, logicLines: number, testFileLines: number) {
      return outcome({ diff: { ok: true, measured: { combinedTextualLines, logicLines, testFileLines } } });
    }
    expect(scoreDiffBound(measured(400, 350, 50), scoredExpected({ execution: "factory", withinEnvelope: true }))).toEqual({ pass: true });
    expect(scoreDiffBound(measured(401, 350, 51), scoredExpected({ execution: "factory", withinEnvelope: false }))).toEqual({ pass: true });
    expect(scoreDiffBound(measured(900, 400, 500), scoredExpected({ execution: "conventional", withinEnvelope: true }))).toEqual({ pass: true });
    expect(scoreDiffBound(measured(901, 401, 500), scoredExpected({ execution: "conventional", withinEnvelope: false }))).toEqual({ pass: true });
    expect(scoreDiffBound(measured(401, 350, 51), scoredExpected({ execution: "factory", withinEnvelope: true })).pass).toBe(false);
    expect(scoreDiffBound(outcome({ diff: { ok: false, reason: "unmeasurable" } }), scoredExpected()).pass).toBe(false);
    expect(scoreDiffBound(measured(4, 3, 0), scoredExpected()).pass).toBe(false);
    for (const diff of [
      null,
      { ok: true, measured: null },
      { ok: true, measured: { combinedTextualLines: 1, logicLines: 1, testFileLines: 0 }, extra: true },
      { ok: true, measured: { combinedTextualLines: 1, logicLines: 1, testFileLines: 0, extra: true } },
      { ok: true, measured: { logicLines: 1, testFileLines: 0 } },
      { ok: true, measured: { combinedTextualLines: -1, logicLines: -1, testFileLines: 0 } },
      { ok: true, measured: { combinedTextualLines: 1, logicLines: "1", testFileLines: 0 } },
      { ok: true, measured: { combinedTextualLines: 1, logicLines: 1, testFileLines: "0" } },
    ]) expect(scoreDiffBound(outcome({ diff }), scoredExpected()).pass).toBe(false);
    expect(scoreDiffBound(null, scoredExpected()).pass).toBe(false);
    expect(scoreDiffBound(outcome(), scoredExpected({ implement: false }))).toEqual({ pass: false, reason: "triage-only case has no implement outcome" });
    const hostile = { ...outcome(), get diff() { throw new Error("hostile"); } };
    expect(() => scoreDiffBound(hostile, scoredExpected())).not.toThrow();
    expect(scoreDiffBound(hostile, scoredExpected()).pass).toBe(false);
  });

  it("T111 cross-checks both mutation arms, gate verdicts, shapes, and totality", () => {
    const inapplicable = outcome();
    const passing = outcome({ mutation: { applicable: true, gate: { status: "pass" } } });
    const failing = outcome({ mutation: { applicable: true, gate: { status: "non-pass", reason: "dropped" } } });
    expect(scoreMutationOutcome(inapplicable, scoredExpected())).toEqual({ pass: true });
    expect(scoreMutationOutcome(passing, scoredExpected({ mutation: { expectedGatePass: true } }))).toEqual({ pass: true });
    expect(scoreMutationOutcome(failing, scoredExpected({ mutation: { expectedGatePass: false } }))).toEqual({ pass: true });
    expect(scoreMutationOutcome(passing, scoredExpected())).toEqual({
      pass: false,
      reason: "expected mutation to be inapplicable",
    });
    expect(scoreMutationOutcome(inapplicable, scoredExpected({ mutation: { expectedGatePass: true } }))).toEqual({
      pass: false,
      reason: "expected an applicable mutation gate",
    });
    expect(scoreMutationOutcome(failing, scoredExpected({ mutation: { expectedGatePass: true } })).pass).toBe(false);
    for (const mutation of [
      { applicable: false, reason: "unknown" },
      { applicable: false, reason: "no-mutation-surface", gate: { status: "pass" } },
      { applicable: true, gate: { status: "pass", reason: "extra" } },
      { applicable: true, gate: { status: "pass" }, extra: true },
      { applicable: true }, null,
    ]) expect(scoreMutationOutcome(outcome({ mutation }), scoredExpected()).pass).toBe(false);
    expect(scoreMutationOutcome(null, scoredExpected()).pass).toBe(false);
    expect(scoreMutationOutcome(outcome({ mutation: { applicable: "true" } }), scoredExpected()).pass).toBe(false);
    expect(scoreMutationOutcome(outcome(), scoredExpected({ implement: false }))).toEqual({ pass: false, reason: "triage-only case has no implement outcome" });
    const hostile = { ...outcome(), get mutation() { throw new Error("hostile"); } };
    expect(() => scoreMutationOutcome(hostile, scoredExpected())).not.toThrow();
    expect(scoreMutationOutcome(hostile, scoredExpected()).pass).toBe(false);
  });

  it("T119 rejects a misassociated case before scoring every leaf outcome", () => {
    const wrongCase = outcome({ caseId: "issue-999-wrong-case" });
    for (const scorer of [scoreCompileOutcome, scoreTestOutcome, scoreDiffBound, scoreMutationOutcome]) {
      expect(scorer(wrongCase, scoredExpected())).toEqual({
        pass: false,
        reason: "outcome caseId does not match expected case",
      });
    }
  });

  it("T120 rejects non-pass and malformed setup before scoring every leaf outcome", () => {
    for (const setup of [
      { status: "non-pass", reason: "setup failed" },
      { status: "pass", extra: true },
      null,
    ]) {
      for (const scorer of [scoreCompileOutcome, scoreTestOutcome, scoreDiffBound, scoreMutationOutcome]) {
        expect(scorer(outcome({ setup }), scoredExpected())).toEqual({
          pass: false,
          reason: "outcome setup did not pass",
        });
      }
    }
  });

  it("T112 preserves both original scorer exports byte-for-byte while the module stays pure", () => {
    const source = readFileSync(new URL("../../scripts/factory/eval/recorded-scorers.mts", import.meta.url), "utf8");
    expect(source).toContain(`export function scoreTriageLabel(produced: unknown, expected: ExpectedResult): ScoreResult {
  if (typeof produced !== "string") return { pass: false, reason: "produced triage label must be a string" };
  if (produced !== expected.triage.expectedReadiness) return { pass: false, reason: "produced triage label does not byte-match expectedReadiness" };
  return { pass: true };
}`);
    expect(source).toContain(`export function scorePrOutcome(produced: unknown, expected: ExpectedResult): ScoreResult {
  if (expected.implement === null) return { pass: false, reason: "triage-only case has no PR outcome" };
  try {
    if (!isPlainObject(produced)) return { pass: false, reason: "produced PR outcome must be a plain object" };
    const extra = unexpectedKeys(produced, PR_OUTCOME_KEYS);
    const missing = [...PR_OUTCOME_KEYS].filter((key) => !Object.hasOwn(produced, key));
    if (extra.length > 0) return { pass: false, reason: \`unexpected PR outcome field(s): \${extra.join(", ")}\` };
    if (missing.length > 0) return { pass: false, reason: \`missing PR outcome field(s): \${missing.join(", ")}\` };
    const target = expected.implement.prOutcome;
    if (typeof produced.merged !== "boolean" || produced.merged !== target.merged) return { pass: false, reason: "merged mismatch" };
    if (typeof produced.firstPassCiGreen !== "boolean" || produced.firstPassCiGreen !== target.firstPassCiGreen) return { pass: false, reason: "firstPassCiGreen mismatch" };
    if (!isSafeNonNegativeInteger(produced.postOpenReviewRounds) || produced.postOpenReviewRounds !== target.postOpenReviewRounds) return { pass: false, reason: "postOpenReviewRounds mismatch" };
    return { pass: true };
  } catch {
    return { pass: false, reason: "produced PR outcome is not inspectable" };
  }
}`);
    expect(source).not.toMatch(/node:fs|child_process|https|fetch\(|Date\.now|new Date\(/);
  });
});
