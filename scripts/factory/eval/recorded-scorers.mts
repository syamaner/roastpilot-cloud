import {
  type ExpectedResult,
} from "./expected-result-schema.mts";
import {
  isPlainObject,
  isSafeNonNegativeInteger,
  unexpectedKeys,
} from "./validation-common.mts";

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
