import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateExpectedResult, type ExpectedResult } from "../../scripts/factory/eval/expected-result-schema.mts";
import { scorePrOutcome, scoreTriageLabel } from "../../scripts/factory/eval/recorded-scorers.mts";

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
});
