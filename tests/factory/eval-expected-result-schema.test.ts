import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { READINESS_LABELS } from "../../scripts/factory/triage-verdict-schema.mts";
import {
  EXECUTIONS,
  ISSUE_TYPES,
  MAX_EXPECTED_BYTES,
  OUTCOME_CLASSES,
  PROVENANCES,
  SIZE_CLASSES,
  TRIAGE_OUTCOME_CLASSES,
  validateExpectedResult,
} from "../../scripts/factory/eval/expected-result-schema.mts";
import {
  isSafeNonNegativeInteger,
  isUtf8PayloadWithinLimit,
} from "../../scripts/factory/eval/validation-common.mts";

const EXPECTATIONS = new URL("../../eval/corpus/expectations/", import.meta.url);

function validExpected(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    caseId: "issue-009-example",
    issueType: "feature",
    triageOutcomeClass: "ready",
    execution: "factory",
    sizeClass: "small",
    outcomeClass: "clean-pass",
    provenance: "historical-artifact",
    triage: { expectedReadiness: "needs-info" },
    implement: {
      compile: "pass",
      tests: "pass",
      implementLogicLines: 1,
      diffBound: { expectedWithinEnvelope: true },
      mutation: null,
      prOutcome: { merged: true, firstPassCiGreen: true, postOpenReviewRounds: 1 },
    },
  };
}

function clone(): Record<string, unknown> {
  return structuredClone(validExpected());
}

function implementation(raw: Record<string, unknown>): Record<string, unknown> {
  return raw.implement as Record<string, unknown>;
}

describe("validateExpectedResult", () => {
  const paths = [
    "issue-009-registry-reconciliation", "issue-023-dryrun-second",
    "issue-026-health-route-dryrun", "issue-058-grant-hardening",
    "issue-059-public-grant-audit", "issue-120-executable-closure",
    "issue-151-summary-binding", "issue-194-comment-injection",
    "issue-205-retarget-hardening", "issue-274-inert-noop",
    "issue-281-dryrun-utility", "issue-284-vitest-timeout",
  ];
  it.each(paths)("T29 validates committed expectation %s", (caseId) => {
    const raw = JSON.parse(readFileSync(new URL(`${caseId}/expected.json`, EXPECTATIONS), "utf8")) as unknown;
    expect(validateExpectedResult(raw).ok).toBe(true);
  });

  it("T30 rejects unknown keys at every nesting", () => {
    for (const mutate of [
      (raw: Record<string, unknown>) => { raw.extra = true; },
      (raw: Record<string, unknown>) => { (raw.triage as Record<string, unknown>).extra = true; },
      (raw: Record<string, unknown>) => { implementation(raw).extra = true; },
      (raw: Record<string, unknown>) => { (implementation(raw).diffBound as Record<string, unknown>).extra = true; },
      (raw: Record<string, unknown>) => { implementation(raw).mutation = { expectedGatePass: true, extra: true }; },
      (raw: Record<string, unknown>) => { (implementation(raw).prOutcome as Record<string, unknown>).extra = true; },
    ]) {
      const raw = clone(); mutate(raw); expect(validateExpectedResult(raw).ok).toBe(false);
    }
  });

  it("rejects schemaVersion other than integer 1 and a malformed caseId", () => {
    expect(validateExpectedResult({ ...validExpected(), schemaVersion: 2 }).ok).toBe(false);
    expect(validateExpectedResult({ ...validExpected(), caseId: "Issue-009-example" }).ok).toBe(false);
  });

  it("rejects a non-object expected-result root", () => {
    expect(validateExpectedResult(null).ok).toBe(false);
  });

  it("rejects a non-object value at every nested object position", () => {
    const mutations: readonly ((raw: Record<string, unknown>) => void)[] = [
      (raw) => { raw.triage = "needs-info"; },
      (raw) => { raw.implement = "pass"; },
      (raw) => { implementation(raw).diffBound = true; },
      (raw) => { implementation(raw).mutation = false; },
      (raw) => { implementation(raw).prOutcome = []; },
    ];
    for (const mutate of mutations) {
      const raw = clone(); mutate(raw);
      expect(validateExpectedResult(raw).ok).toBe(false);
    }
  });

  it("T31 rejects out-of-domain and case-variant enums", () => {
    const rows: readonly [string, readonly string[]][] = [
      ["issueType", ISSUE_TYPES], ["triageOutcomeClass", TRIAGE_OUTCOME_CLASSES],
      ["execution", EXECUTIONS], ["sizeClass", SIZE_CLASSES],
      ["outcomeClass", OUTCOME_CLASSES], ["provenance", PROVENANCES],
    ];
    for (const [field, domain] of rows) for (const value of ["unknown", domain[0].toUpperCase()]) {
      expect(validateExpectedResult({ ...validExpected(), [field]: value }).ok).toBe(false);
    }
  });

  it("T32 enforces byte-exact readiness and accepts the full canonical domain", () => {
    for (const value of READINESS_LABELS) {
      const raw = clone(); raw.triage = { expectedReadiness: value };
      expect(validateExpectedResult(raw).ok).toBe(true);
    }
    for (const value of ["Needs-Info", " needs-info "]) {
      const raw = clone(); raw.triage = { expectedReadiness: value };
      expect(validateExpectedResult(raw).ok).toBe(false);
    }
  });

  it("T33 rejects every null-triad disagreement", () => {
    for (const field of ["implement", "sizeClass", "outcomeClass"] as const) {
      const raw = clone(); raw[field] = null; expect(validateExpectedResult(raw).ok).toBe(false);
    }
    expect(validateExpectedResult({ ...validExpected(), implement: null, sizeClass: null, outcomeClass: null }).ok).toBe(true);
  });

  it("T34 rejects compile fail", () => {
    const raw = clone(); implementation(raw).compile = "fail";
    expect(validateExpectedResult(raw).ok).toBe(false);
  });

  it("rejects tests other than pass", () => {
    const raw = clone(); implementation(raw).tests = "fail";
    expect(validateExpectedResult(raw).ok).toBe(false);
  });

  it.each([-1, 3.5, "119"])("T35 rejects implementLogicLines %s", (value) => {
    const raw = clone(); implementation(raw).implementLogicLines = value;
    expect(validateExpectedResult(raw).ok).toBe(false);
  });

  it("T36 rejects string postOpenReviewRounds", () => {
    const raw = clone(); (implementation(raw).prOutcome as Record<string, unknown>).postOpenReviewRounds = "1";
    expect(validateExpectedResult(raw).ok).toBe(false);
  });

  it("T37 validates the closed mutation grammar", () => {
    for (const mutation of [{}, { expectedGatePass: "true" }]) {
      const raw = clone(); implementation(raw).mutation = mutation;
      expect(validateExpectedResult(raw).ok).toBe(false);
    }
    for (const mutation of [null, { expectedGatePass: false }]) {
      const raw = clone(); implementation(raw).mutation = mutation;
      expect(validateExpectedResult(raw).ok).toBe(true);
    }
  });

  it("rejects non-boolean nested implementation results", () => {
    const diffBound = clone();
    (implementation(diffBound).diffBound as Record<string, unknown>).expectedWithinEnvelope = "true";
    expect(validateExpectedResult(diffBound).ok).toBe(false);

    for (const field of ["merged", "firstPassCiGreen"] as const) {
      const raw = clone();
      (implementation(raw).prOutcome as Record<string, unknown>)[field] = 1;
      expect(validateExpectedResult(raw).ok).toBe(false);
    }
  });

  it("T38 exports and applies the expected payload byte bound", () => {
    expect(MAX_EXPECTED_BYTES).toBe(16_384);
    expect(isUtf8PayloadWithinLimit("x".repeat(MAX_EXPECTED_BYTES), MAX_EXPECTED_BYTES)).toBe(true);
    expect(isUtf8PayloadWithinLimit("x".repeat(MAX_EXPECTED_BYTES + 1), MAX_EXPECTED_BYTES)).toBe(false);
  });

  it("T61 accepts zero and rejects unsafe non-negative integer lookalikes", () => {
    expect(isSafeNonNegativeInteger(0)).toBe(true);
    for (const value of [-1, 1.5, "0", 2 ** 53]) expect(isSafeNonNegativeInteger(value)).toBe(false);
    for (const field of ["implementLogicLines", "postOpenReviewRounds"] as const) {
      const raw = clone();
      if (field === "implementLogicLines") implementation(raw)[field] = 0;
      else (implementation(raw).prOutcome as Record<string, unknown>)[field] = 0;
      expect(validateExpectedResult(raw).ok).toBe(true);
    }
  });
});
