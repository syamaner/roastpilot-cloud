import { READINESS_LABELS } from "../triage-verdict-schema.mts";
import {
  isBoundedNonEmptyString,
  isIsoUtcInstant,
  isPlainObject,
  isSafePositiveInteger,
  isSha40Hex,
  unexpectedKeys,
  type ValidationResult,
} from "./validation-common.mts";

export const MANIFEST_TOP_ALLOWED_KEYS = new Set<string>([
  "schemaVersion",
  "description",
  "cases",
]);
export const MANIFEST_CASE_ALLOWED_KEYS = new Set<string>([
  "caseId",
  "issueNumber",
  "prNumber",
  "stage",
  "baseSha",
  "capturedAt",
  "pin",
  "issueSnapshotPath",
  "decisionContextPath",
  "recorded",
  "notes",
]);
export const PIN_ALLOWED_KEYS = new Set<string>([
  "actionRef",
  "actionCommit",
  "resolvedModel",
  "triageSkillVersion",
  "implementPromptVersion",
]);
export const RECORDED_ALLOWED_KEYS = new Set<string>([
  "triageVerdictPath",
  "implementPatchPath",
]);
export const STAGES = ["triage-and-implement", "triage-only"] as const;
export const ANSWER_VERDICT_TOKENS = new Set<string>([
  ...READINESS_LABELS,
  "clean-pass",
  "non-pass",
  "bounced",
  "merged",
]);
export const MAX_MANIFEST_BYTES = 262_144;

type Stage = (typeof STAGES)[number];

export interface Pin {
  readonly actionRef: string;
  readonly actionCommit: string;
  readonly resolvedModel: string | null;
  readonly triageSkillVersion: string | null;
  readonly implementPromptVersion: string | null;
}

export interface Recorded {
  readonly triageVerdictPath: string;
  readonly implementPatchPath: string | null;
}

export interface CorpusCase {
  readonly caseId: string;
  readonly issueNumber: number;
  readonly prNumber: number | null;
  readonly stage: Stage;
  readonly baseSha: string;
  readonly capturedAt: string;
  readonly pin: Pin;
  readonly issueSnapshotPath: string;
  readonly decisionContextPath: string | null;
  readonly recorded: Recorded;
  readonly notes: string;
}

export interface CorpusManifest {
  readonly schemaVersion: 1;
  readonly description: string;
  readonly cases: readonly CorpusCase[];
}

const CASE_ID_PATTERN = /^issue-(\d{3,})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const UNBOUNDED_STRING_MAX = Number.MAX_SAFE_INTEGER;

function slugContainsAnswerVerdict(slug: string): boolean {
  const segments = slug.toLowerCase().split("-");
  return [...ANSWER_VERDICT_TOKENS].some((token) => {
    const tokenSegments = token.split("-");
    return segments.some((_, start) =>
      tokenSegments.every(
        (tokenSegment, offset) => segments[start + offset] === tokenSegment,
      ),
    );
  });
}

function notesContainAnswerVerdict(notes: string): boolean {
  const lowercaseNotes = notes.toLowerCase();
  return [...ANSWER_VERDICT_TOKENS].some((token) =>
    new RegExp(`(?:^|[^a-z0-9])${token}(?:$|[^a-z0-9])`).test(lowercaseNotes),
  );
}

function isStage(value: unknown): value is Stage {
  return (
    typeof value === "string" &&
    (STAGES as readonly string[]).includes(value)
  );
}

function validateNullableSha(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (value !== null && !isSha40Hex(value)) {
    errors.push(`${path} must be null or a lowercase 40-hex SHA`);
  }
}

function validatePin(raw: unknown, path: string, errors: string[]): boolean {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const unknown = unexpectedKeys(raw, PIN_ALLOWED_KEYS);
  if (unknown.length > 0) {
    errors.push(`${path} has unexpected key(s): ${unknown.join(", ")}`);
  }
  if (!isBoundedNonEmptyString(raw.actionRef, UNBOUNDED_STRING_MAX)) {
    errors.push(`${path}.actionRef must be a non-empty string`);
  }
  if (!isSha40Hex(raw.actionCommit)) {
    errors.push(`${path}.actionCommit must be a lowercase 40-hex SHA`);
  }
  if (
    raw.resolvedModel !== null &&
    !isBoundedNonEmptyString(raw.resolvedModel, UNBOUNDED_STRING_MAX)
  ) {
    errors.push(`${path}.resolvedModel must be null or a non-empty string`);
  }
  validateNullableSha(raw.triageSkillVersion, `${path}.triageSkillVersion`, errors);
  validateNullableSha(
    raw.implementPromptVersion,
    `${path}.implementPromptVersion`,
    errors,
  );
  return true;
}

function validateRecorded(
  raw: unknown,
  caseId: unknown,
  path: string,
  errors: string[],
): { validObject: boolean; validImplementPathType: boolean } {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return { validObject: false, validImplementPathType: false };
  }
  const unknown = unexpectedKeys(raw, RECORDED_ALLOWED_KEYS);
  if (unknown.length > 0) {
    errors.push(`${path} has unexpected key(s): ${unknown.join(", ")}`);
  }
  const validCaseId = typeof caseId === "string";
  const expectedTriagePath = validCaseId
    ? `inputs/${caseId}/recorded/triage-verdict.json`
    : null;
  if (
    typeof raw.triageVerdictPath !== "string" ||
    (expectedTriagePath !== null && raw.triageVerdictPath !== expectedTriagePath)
  ) {
    errors.push(`${path}.triageVerdictPath must use the canonical case path`);
  }
  const validImplementPathType =
    raw.implementPatchPath === null ||
    typeof raw.implementPatchPath === "string";
  const expectedImplementPath = validCaseId
    ? `inputs/${caseId}/recorded/implement.patch`
    : null;
  if (
    !validImplementPathType ||
    (typeof raw.implementPatchPath === "string" &&
      expectedImplementPath !== null &&
      raw.implementPatchPath !== expectedImplementPath)
  ) {
    errors.push(`${path}.implementPatchPath must be null or the canonical case path`);
  }
  return { validObject: true, validImplementPathType };
}

function validateCase(raw: unknown, index: number, errors: string[]): void {
  const path = `cases[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return;
  }
  const unknown = unexpectedKeys(raw, MANIFEST_CASE_ALLOWED_KEYS);
  if (unknown.length > 0) {
    errors.push(`${path} has unexpected key(s): ${unknown.join(", ")}`);
  }

  const caseIdMatch =
    typeof raw.caseId === "string" ? CASE_ID_PATTERN.exec(raw.caseId) : null;
  if (caseIdMatch === null) {
    errors.push(
      `${path}.caseId must match issue-<at-least-3-digits>-lowercase-slug`,
    );
  }
  const validIssueNumber = isSafePositiveInteger(raw.issueNumber);
  if (!validIssueNumber) {
    errors.push(`${path}.issueNumber must be a positive integer`);
  } else if (
    caseIdMatch !== null &&
    caseIdMatch[1] !== String(raw.issueNumber).padStart(3, "0")
  ) {
    errors.push(`${path}.caseId issue segment must match issueNumber`);
  }

  const validPrNumber =
    raw.prNumber === null || isSafePositiveInteger(raw.prNumber);
  if (!validPrNumber) {
    errors.push(`${path}.prNumber must be null or a positive integer`);
  }
  const validStage = isStage(raw.stage);
  if (!validStage) {
    errors.push(`${path}.stage must be one of ${STAGES.join(", ")}`);
  }
  if (!isSha40Hex(raw.baseSha)) {
    errors.push(`${path}.baseSha must be a lowercase 40-hex SHA`);
  }
  if (!isIsoUtcInstant(raw.capturedAt)) {
    errors.push(`${path}.capturedAt must be a whole-second UTC-Z instant`);
  }

  validatePin(raw.pin, `${path}.pin`, errors);
  const validCaseIdType = typeof raw.caseId === "string";
  const expectedSnapshotPath = validCaseIdType
    ? `inputs/${raw.caseId}/issue-snapshot.json`
    : null;
  if (
    typeof raw.issueSnapshotPath !== "string" ||
    (expectedSnapshotPath !== null && raw.issueSnapshotPath !== expectedSnapshotPath)
  ) {
    errors.push(`${path}.issueSnapshotPath must use the canonical case path`);
  }
  const expectedDecisionPath = validCaseIdType
    ? `inputs/${raw.caseId}/decision-context.md`
    : null;
  if (
    raw.decisionContextPath !== null &&
    (typeof raw.decisionContextPath !== "string" ||
      (expectedDecisionPath !== null &&
        raw.decisionContextPath !== expectedDecisionPath))
  ) {
    errors.push(`${path}.decisionContextPath must be null or the canonical case path`);
  }

  const recorded = validateRecorded(raw.recorded, raw.caseId, `${path}.recorded`, errors);
  if (
    validStage &&
    validPrNumber &&
    recorded.validObject &&
    recorded.validImplementPathType
  ) {
    const implementStage = raw.stage === "triage-and-implement";
    const hasPr = raw.prNumber !== null;
    const hasPatch =
      isPlainObject(raw.recorded) && raw.recorded.implementPatchPath !== null;
    if (implementStage !== hasPr || implementStage !== hasPatch) {
      errors.push(
        `${path}.stage, prNumber, and recorded.implementPatchPath must agree`,
      );
    }
  }
  const notes = raw.notes;
  const validNotes = isBoundedNonEmptyString(notes, 1000);
  if (!validNotes) {
    errors.push(`${path}.notes must be a non-empty string of at most 1000 characters`);
  }
  if (
    caseIdMatch !== null &&
    validNotes &&
    (slugContainsAnswerVerdict(caseIdMatch[2]) ||
      notesContainAnswerVerdict(notes))
  ) {
    errors.push(`${path} leaks an answer-verdict token in caseId or notes`);
  }
}

/**
 * Validates a parsed corpus manifest without I/O. PR-2's loader must reject
 * raw text over MAX_MANIFEST_BYTES before parsing and calling this function.
 */
export function validateCorpusManifest(
  raw: unknown,
): ValidationResult<CorpusManifest> {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["manifest must be an object"] };
  }
  const unknown = unexpectedKeys(raw, MANIFEST_TOP_ALLOWED_KEYS);
  if (unknown.length > 0) {
    errors.push(`manifest has unexpected key(s): ${unknown.join(", ")}`);
  }
  if (raw.schemaVersion !== 1) {
    errors.push("manifest.schemaVersion must be the integer 1");
  }
  const description = raw.description;
  const validDescription = isBoundedNonEmptyString(
    description,
    UNBOUNDED_STRING_MAX,
  );
  if (!validDescription) {
    errors.push("manifest.description must be a non-empty string");
  } else if (notesContainAnswerVerdict(description)) {
    errors.push("manifest.description leaks an answer-verdict token");
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    errors.push("manifest.cases must be a non-empty array");
  } else {
    const seenCaseIds = new Set<string>();
    raw.cases.forEach((entry: unknown, index: number) => {
      validateCase(entry, index, errors);
      if (isPlainObject(entry) && typeof entry.caseId === "string") {
        if (seenCaseIds.has(entry.caseId)) {
          errors.push(`manifest.cases has duplicate caseId ${entry.caseId}`);
        }
        seenCaseIds.add(entry.caseId);
      }
    });
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: raw as unknown as CorpusManifest };
}
