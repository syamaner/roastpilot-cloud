import {
  type ExpectedResult,
} from "./expected-result-schema.mts";
import {
  isPlainObject,
  isSafeNonNegativeInteger,
  unexpectedKeys,
} from "./validation-common.mts";
import { FACTORY_TEXT_LINE_LIMIT } from "../implement-patch-logic.mts";

export type ScoreResult = { readonly pass: true } | { readonly pass: false; readonly reason: string };

export function scoreTriageLabel(produced: unknown, expected: ExpectedResult): ScoreResult {
  if (typeof produced !== "string") return { pass: false, reason: "produced triage label must be a string" };
  if (produced !== expected.triage.expectedReadiness) return { pass: false, reason: "produced triage label does not byte-match expectedReadiness" };
  return { pass: true };
}

const PR_OUTCOME_KEYS = new Set<string>([
  "merged", "firstPassCiGreen", "postOpenReviewRounds",
]);

export function scorePrOutcome(produced: unknown, expected: ExpectedResult): ScoreResult {
  if (expected.implement === null) return { pass: false, reason: "triage-only case has no PR outcome" };
  try {
    if (!isPlainObject(produced)) return { pass: false, reason: "produced PR outcome must be a plain object" };
    const extra = unexpectedKeys(produced, PR_OUTCOME_KEYS);
    const missing = [...PR_OUTCOME_KEYS].filter((key) => !Object.hasOwn(produced, key));
    if (extra.length > 0) return { pass: false, reason: `unexpected PR outcome field(s): ${extra.join(", ")}` };
    if (missing.length > 0) return { pass: false, reason: `missing PR outcome field(s): ${missing.join(", ")}` };
    const target = expected.implement.prOutcome;
    if (typeof produced.merged !== "boolean" || produced.merged !== target.merged) return { pass: false, reason: "merged mismatch" };
    if (typeof produced.firstPassCiGreen !== "boolean" || produced.firstPassCiGreen !== target.firstPassCiGreen) return { pass: false, reason: "firstPassCiGreen mismatch" };
    if (!isSafeNonNegativeInteger(produced.postOpenReviewRounds) || produced.postOpenReviewRounds !== target.postOpenReviewRounds) return { pass: false, reason: "postOpenReviewRounds mismatch" };
    return { pass: true };
  } catch {
    return { pass: false, reason: "produced PR outcome is not inspectable" };
  }
}

const OUTCOME_KEYS = new Set<string>([
  "caseId", "baseSha", "setup", "diff", "compile", "tests", "mutation",
]);
const DIFF_KEYS = new Set<string>(["ok", "measured"]);
const MEASURED_DIFF_KEYS = new Set<string>([
  "combinedTextualLines", "logicLines", "testFileLines",
]);

function gateStatus(value: unknown): "pass" | "non-pass" | null {
  if (!isPlainObject(value) || typeof value.status !== "string") return null;
  if (value.status === "pass") {
    return unexpectedKeys(value, new Set(["status"])).length === 0
      ? "pass"
      : null;
  }
  if (value.status === "non-pass") {
    return typeof value.reason === "string" && value.reason.length > 0 &&
      unexpectedKeys(value, new Set(["status", "reason"])).length === 0
      ? "non-pass"
      : null;
  }
  return null;
}

type OutcomeInspection =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string | null };

function inspectOutcome(
  produced: unknown,
  expected: ExpectedResult,
): OutcomeInspection {
  if (!isPlainObject(produced)) return { ok: false, reason: null };
  if (unexpectedKeys(produced, OUTCOME_KEYS).length > 0) return { ok: false, reason: null };
  if ([...OUTCOME_KEYS].some((key) => !Object.hasOwn(produced, key))) return { ok: false, reason: null };
  if (typeof produced.caseId !== "string" || produced.caseId !== expected.caseId) {
    return { ok: false, reason: "outcome caseId does not match expected case" };
  }
  // ExpectedResult intentionally has no baseSha; 14g owns that association check.
  if (gateStatus(produced.setup) !== "pass") {
    return { ok: false, reason: "outcome setup did not pass" };
  }
  return { ok: true, value: produced };
}

export function scoreCompileOutcome(produced: unknown, expected: ExpectedResult): ScoreResult {
  if (expected.implement === null) return { pass: false, reason: "triage-only case has no implement outcome" };
  try {
    const inspected = inspectOutcome(produced, expected);
    if (!inspected.ok) return { pass: false, reason: inspected.reason ?? "produced compile outcome has an invalid shape" };
    const status = gateStatus(inspected.value.compile);
    if (status === null) return { pass: false, reason: "produced compile outcome has an invalid shape" };
    return status === "pass" ? { pass: true } : { pass: false, reason: "compile gate did not pass" };
  } catch {
    return { pass: false, reason: "produced compile outcome is not inspectable" };
  }
}

export function scoreTestOutcome(produced: unknown, expected: ExpectedResult): ScoreResult {
  if (expected.implement === null) return { pass: false, reason: "triage-only case has no implement outcome" };
  try {
    const inspected = inspectOutcome(produced, expected);
    if (!inspected.ok) return { pass: false, reason: inspected.reason ?? "produced test outcome has an invalid shape" };
    const status = gateStatus(inspected.value.tests);
    if (status === null) return { pass: false, reason: "produced test outcome has an invalid shape" };
    return status === "pass" ? { pass: true } : { pass: false, reason: "test gate did not pass" };
  } catch {
    return { pass: false, reason: "produced test outcome is not inspectable" };
  }
}

export function scoreDiffBound(produced: unknown, expected: ExpectedResult): ScoreResult {
  if (expected.implement === null) return { pass: false, reason: "triage-only case has no implement outcome" };
  try {
    const inspected = inspectOutcome(produced, expected);
    if (!inspected.ok) return { pass: false, reason: inspected.reason ?? "produced diff outcome has an invalid shape" };
    if (!isPlainObject(inspected.value.diff)) return { pass: false, reason: "produced diff outcome has an invalid shape" };
    const diff = inspected.value.diff;
    if (unexpectedKeys(diff, DIFF_KEYS).length > 0 || diff.ok !== true || !isPlainObject(diff.measured)) {
      return { pass: false, reason: "produced diff is not measurable" };
    }
    const measured = diff.measured;
    if (
      unexpectedKeys(measured, MEASURED_DIFF_KEYS).length > 0 ||
      [...MEASURED_DIFF_KEYS].some((key) => !Object.hasOwn(measured, key)) ||
      !isSafeNonNegativeInteger(measured.combinedTextualLines) ||
      !isSafeNonNegativeInteger(measured.logicLines) ||
      !isSafeNonNegativeInteger(measured.testFileLines) ||
      measured.logicLines + measured.testFileLines !== measured.combinedTextualLines
    ) {
      return { pass: false, reason: "produced diff measurement has an invalid shape" };
    }
    const comparedLines = expected.execution === "factory"
      ? measured.combinedTextualLines
      : measured.logicLines;
    const withinEnvelope = comparedLines <= FACTORY_TEXT_LINE_LIMIT;
    return withinEnvelope === expected.implement.diffBound.expectedWithinEnvelope
      ? { pass: true }
      : { pass: false, reason: "diff envelope result mismatch" };
  } catch {
    return { pass: false, reason: "produced diff outcome is not inspectable" };
  }
}

export function scoreMutationOutcome(produced: unknown, expected: ExpectedResult): ScoreResult {
  if (expected.implement === null) return { pass: false, reason: "triage-only case has no implement outcome" };
  try {
    const inspected = inspectOutcome(produced, expected);
    if (!inspected.ok) return { pass: false, reason: inspected.reason ?? "produced mutation outcome has an invalid shape" };
    if (!isPlainObject(inspected.value.mutation) || typeof inspected.value.mutation.applicable !== "boolean") {
      return { pass: false, reason: "produced mutation outcome has an invalid shape" };
    }
    const mutation = inspected.value.mutation;
    if (!mutation.applicable) {
      if (
        unexpectedKeys(mutation, new Set(["applicable", "reason"])).length > 0 ||
        (mutation.reason !== "no-mutation-surface" && mutation.reason !== "gate-files-absent-at-base")
      ) return { pass: false, reason: "produced mutation outcome has an invalid shape" };
      return expected.implement.mutation === null
        ? { pass: true }
        : { pass: false, reason: "expected an applicable mutation gate" };
    }
    if (unexpectedKeys(mutation, new Set(["applicable", "gate"])).length > 0) {
      return { pass: false, reason: "produced mutation outcome has an invalid shape" };
    }
    const status = gateStatus(mutation.gate);
    if (status === null) return { pass: false, reason: "produced mutation gate has an invalid shape" };
    if (expected.implement.mutation === null) return { pass: false, reason: "expected mutation to be inapplicable" };
    return (status === "pass") === expected.implement.mutation.expectedGatePass
      ? { pass: true }
      : { pass: false, reason: "mutation gate result mismatch" };
  } catch {
    return { pass: false, reason: "produced mutation outcome is not inspectable" };
  }
}
