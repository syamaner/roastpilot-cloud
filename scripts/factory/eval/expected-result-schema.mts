import {
  READINESS_LABELS,
  type ReadinessLabel,
} from "../triage-verdict-schema.mts";
import {
  isPlainObject,
  isSafeNonNegativeInteger,
  unexpectedKeys,
  type ValidationResult,
} from "./validation-common.mts";

export const ISSUE_TYPES = [
  "documentation",
  "feature",
  "hardening",
  "schema",
  "security-fix",
] as const;
export const TRIAGE_OUTCOME_CLASSES = ["ready", "bounced"] as const;
export const EXECUTIONS = ["conventional", "factory"] as const;
export const SIZE_CLASSES = ["small", "largest-available"] as const;
export const OUTCOME_CLASSES = ["clean-pass", "non-pass"] as const;
export const PROVENANCES = [
  "historical-artifact",
  "reconstructed-from-outcome",
] as const;
export const COMPILE_RESULTS = ["pass"] as const;
export const TEST_RESULTS = ["pass"] as const;

export const EXPECTED_ALLOWED_KEYS = new Set<string>([
  "schemaVersion", "caseId", "issueType", "triageOutcomeClass", "execution",
  "sizeClass", "outcomeClass", "provenance", "triage", "implement",
]);
export const TRIAGE_ALLOWED_KEYS = new Set<string>(["expectedReadiness"]);
export const IMPLEMENT_ALLOWED_KEYS = new Set<string>([
  "compile", "tests", "implementLogicLines", "diffBound", "mutation", "prOutcome",
]);
export const DIFF_BOUND_ALLOWED_KEYS = new Set<string>(["expectedWithinEnvelope"]);
export const MUTATION_ALLOWED_KEYS = new Set<string>(["expectedGatePass"]);
export const PR_OUTCOME_ALLOWED_KEYS = new Set<string>([
  "merged", "firstPassCiGreen", "postOpenReviewRounds",
]);
export const ANSWER_DERIVED_FIELDS = [
  "issueType", "triageOutcomeClass", "execution", "sizeClass", "outcomeClass",
  "provenance", "triage", "implement",
] as const;
export const MAX_EXPECTED_BYTES = 16_384;

type IssueType = (typeof ISSUE_TYPES)[number];
type TriageOutcomeClass = (typeof TRIAGE_OUTCOME_CLASSES)[number];
type Execution = (typeof EXECUTIONS)[number];
type SizeClass = (typeof SIZE_CLASSES)[number];
type OutcomeClass = (typeof OUTCOME_CLASSES)[number];
type Provenance = (typeof PROVENANCES)[number];

export interface ExpectedImplement {
  readonly compile: "pass";
  readonly tests: "pass";
  readonly implementLogicLines: number;
  readonly diffBound: { readonly expectedWithinEnvelope: boolean };
  readonly mutation: null | { readonly expectedGatePass: boolean };
  readonly prOutcome: {
    readonly merged: boolean;
    readonly firstPassCiGreen: boolean;
    readonly postOpenReviewRounds: number;
  };
}

export interface ExpectedResult {
  readonly schemaVersion: 1;
  readonly caseId: string;
  readonly issueType: IssueType;
  readonly triageOutcomeClass: TriageOutcomeClass;
  readonly execution: Execution;
  readonly sizeClass: SizeClass | null;
  readonly outcomeClass: OutcomeClass | null;
  readonly provenance: Provenance;
  readonly triage: { readonly expectedReadiness: ReadinessLabel };
  readonly implement: ExpectedImplement | null;
}

export const CASE_ID_PATTERN = /^issue-(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;

function inDomain<T extends string>(value: unknown, domain: readonly T[]): value is T {
  return typeof value === "string" && (domain as readonly string[]).includes(value);
}

function closedObject(
  raw: unknown,
  path: string,
  keys: ReadonlySet<string>,
  errors: string[],
): raw is Record<string, unknown> {
  try {
    if (!isPlainObject(raw)) {
      errors.push(`${path} must be an object`);
      return false;
    }
    const unknown = unexpectedKeys(raw, keys);
    if (unknown.length > 0) errors.push(`${path} has unexpected key(s): ${unknown.join(", ")}`);
    return true;
  } catch {
    errors.push(`${path} is not inspectable`);
    return false;
  }
}

function validateImplement(raw: unknown, errors: string[]): void {
  if (!closedObject(raw, "expected.implement", IMPLEMENT_ALLOWED_KEYS, errors)) return;
  if (raw.compile !== "pass") errors.push('expected.implement.compile must be "pass"');
  if (raw.tests !== "pass") errors.push('expected.implement.tests must be "pass"');
  if (!isSafeNonNegativeInteger(raw.implementLogicLines)) {
    errors.push("expected.implement.implementLogicLines must be a safe non-negative integer");
  }
  if (closedObject(raw.diffBound, "expected.implement.diffBound", DIFF_BOUND_ALLOWED_KEYS, errors)) {
    if (typeof raw.diffBound.expectedWithinEnvelope !== "boolean") {
      errors.push("expected.implement.diffBound.expectedWithinEnvelope must be a boolean");
    }
  }
  if (raw.mutation !== null) {
    if (closedObject(raw.mutation, "expected.implement.mutation", MUTATION_ALLOWED_KEYS, errors)) {
      if (typeof raw.mutation.expectedGatePass !== "boolean") {
        errors.push("expected.implement.mutation.expectedGatePass must be a boolean");
      }
    }
  }
  if (closedObject(raw.prOutcome, "expected.implement.prOutcome", PR_OUTCOME_ALLOWED_KEYS, errors)) {
    if (typeof raw.prOutcome.merged !== "boolean") errors.push("expected.implement.prOutcome.merged must be a boolean");
    if (typeof raw.prOutcome.firstPassCiGreen !== "boolean") errors.push("expected.implement.prOutcome.firstPassCiGreen must be a boolean");
    if (!isSafeNonNegativeInteger(raw.prOutcome.postOpenReviewRounds)) {
      errors.push("expected.implement.prOutcome.postOpenReviewRounds must be a safe non-negative integer");
    }
  }
}

export function validateExpectedResult(raw: unknown): ValidationResult<ExpectedResult> {
  const errors: string[] = [];
  try {
    if (!closedObject(raw, "expected", EXPECTED_ALLOWED_KEYS, errors)) return { ok: false, errors };
    if (raw.schemaVersion !== 1) errors.push("expected.schemaVersion must be the integer 1");
    if (typeof raw.caseId !== "string" || !CASE_ID_PATTERN.test(raw.caseId)) errors.push("expected.caseId must match the corpus case-id pattern");
    if (!inDomain(raw.issueType, ISSUE_TYPES)) errors.push(`expected.issueType must be one of ${ISSUE_TYPES.join(", ")}`);
    if (!inDomain(raw.triageOutcomeClass, TRIAGE_OUTCOME_CLASSES)) errors.push(`expected.triageOutcomeClass must be one of ${TRIAGE_OUTCOME_CLASSES.join(", ")}`);
    if (!inDomain(raw.execution, EXECUTIONS)) errors.push(`expected.execution must be one of ${EXECUTIONS.join(", ")}`);
    if (raw.sizeClass !== null && !inDomain(raw.sizeClass, SIZE_CLASSES)) errors.push(`expected.sizeClass must be null or one of ${SIZE_CLASSES.join(", ")}`);
    if (raw.outcomeClass !== null && !inDomain(raw.outcomeClass, OUTCOME_CLASSES)) errors.push(`expected.outcomeClass must be null or one of ${OUTCOME_CLASSES.join(", ")}`);
    if (!inDomain(raw.provenance, PROVENANCES)) errors.push(`expected.provenance must be one of ${PROVENANCES.join(", ")}`);
    if (closedObject(raw.triage, "expected.triage", TRIAGE_ALLOWED_KEYS, errors)) {
      if (!inDomain(raw.triage.expectedReadiness, READINESS_LABELS)) errors.push(`expected.triage.expectedReadiness must be one of ${READINESS_LABELS.join(", ")}`);
    }
    if (raw.implement !== null) validateImplement(raw.implement, errors);
    const nullCount = [raw.implement, raw.sizeClass, raw.outcomeClass].filter((value) => value === null).length;
    if (nullCount !== 0 && nullCount !== 3) errors.push("expected.implement, sizeClass, and outcomeClass must be null together");
    return errors.length > 0 ? { ok: false, errors } : { ok: true, value: raw as unknown as ExpectedResult };
  } catch {
    errors.push("expected is not inspectable");
    return { ok: false, errors };
  }
}
