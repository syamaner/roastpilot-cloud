export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
export const LINE_SPLIT_PATTERN = /\r\n|\r|\n/u;

const STRICT_ISO_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

export interface CodexBoundary {
  readonly kind: "opened" | "ready-for-review" | "manual-retrigger";
  readonly occurredAt: string;
}

export interface CodexSignalInput {
  readonly headSha: string;
  readonly prState: "draft" | "ready";
  readonly boundary: CodexBoundary;
  readonly headChangedAt: string | null;
  readonly reviews: readonly CodexReviewRecord[];
  readonly topLevelComments: readonly CodexCommentRecord[];
  readonly reactions: readonly CodexReactionRecord[];
  readonly evidenceComplete: CodexEvidenceCompleteness;
  readonly triggerComments: readonly CodexTriggerRecord[];
  readonly evaluatedAt: string;
}

export interface CodexEvidenceCompleteness {
  readonly reviews: boolean;
  readonly topLevelComments: boolean;
  readonly reactions: boolean;
}

export interface CodexReviewRecord {
  readonly authorLogin: string;
  readonly commitSha: string;
  readonly submittedAt: string;
  readonly inlineThreadCount: number;
}

export interface CodexCommentRecord {
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly channel: "issue-comment" | "review-thread-reply";
}

export interface CodexReactionRecord {
  readonly authorLogin: string;
  readonly content: "eyes" | "+1" | "other";
  readonly createdAt: string;
  readonly subjectId: string;
}

export interface CodexTriggerRecord {
  readonly createdAt: string;
  readonly onHeadSha: string;
}

/** Parse only calendar-valid ISO-8601 instants in the explicit UTC `Z` form. */
export function parseStrictIsoUtc(value: string): number | null {
  const match = STRICT_ISO_UTC_PATTERN.exec(value);
  if (match === null) return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const date = new Date(instant);
  const fields = match.slice(1, 7).map(Number);
  const observed = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  return observed.every((field, index) => field === fields[index])
    ? instant
    : null;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key));
}

export function isBoundary(value: unknown): value is CodexBoundary {
  if (!isPlainRecord(value) ||
    !hasExactKeys(value, ["kind", "occurredAt"])) return false;
  return (
    (value.kind === "opened" ||
      value.kind === "ready-for-review" ||
      value.kind === "manual-retrigger") &&
    typeof value.occurredAt === "string" &&
    parseStrictIsoUtc(value.occurredAt) !== null
  );
}

export function isReviewRecord(value: unknown): value is CodexReviewRecord {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "authorLogin", "commitSha", "submittedAt", "inlineThreadCount",
  ])) return false;
  return (
    typeof value.authorLogin === "string" &&
    typeof value.commitSha === "string" &&
    FULL_SHA_PATTERN.test(value.commitSha) &&
    typeof value.submittedAt === "string" &&
    parseStrictIsoUtc(value.submittedAt) !== null &&
    Number.isSafeInteger(value.inlineThreadCount) &&
    (value.inlineThreadCount as number) >= 0
  );
}

export function isCommentRecord(value: unknown): value is CodexCommentRecord {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "authorLogin", "body", "createdAt", "channel",
  ])) return false;
  return (
    typeof value.authorLogin === "string" &&
    typeof value.body === "string" &&
    typeof value.createdAt === "string" &&
    parseStrictIsoUtc(value.createdAt) !== null &&
    (value.channel === "issue-comment" ||
      value.channel === "review-thread-reply")
  );
}

export function isReactionRecord(value: unknown): value is CodexReactionRecord {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "authorLogin", "content", "createdAt", "subjectId",
  ])) return false;
  return (
    typeof value.authorLogin === "string" &&
    (value.content === "eyes" ||
      value.content === "+1" ||
      value.content === "other") &&
    typeof value.createdAt === "string" &&
    parseStrictIsoUtc(value.createdAt) !== null &&
    typeof value.subjectId === "string"
  );
}

export function isTriggerRecord(value: unknown): value is CodexTriggerRecord {
  if (!isPlainRecord(value) ||
    !hasExactKeys(value, ["createdAt", "onHeadSha"])) return false;
  return (
    typeof value.createdAt === "string" &&
    parseStrictIsoUtc(value.createdAt) !== null &&
    typeof value.onHeadSha === "string" &&
    FULL_SHA_PATTERN.test(value.onHeadSha)
  );
}

export function isEvidenceComplete(
  value: unknown,
): value is CodexEvidenceCompleteness {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "reviews", "topLevelComments", "reactions",
  ])) return false;
  return (
    typeof value.reviews === "boolean" &&
    typeof value.topLevelComments === "boolean" &&
    typeof value.reactions === "boolean"
  );
}

export function isSignalInput(value: unknown): value is CodexSignalInput {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "headSha", "prState", "boundary", "headChangedAt", "reviews",
    "topLevelComments", "reactions", "evidenceComplete", "triggerComments",
    "evaluatedAt",
  ])) return false;
  return (
    typeof value.headSha === "string" &&
    FULL_SHA_PATTERN.test(value.headSha) &&
    (value.prState === "draft" || value.prState === "ready") &&
    isBoundary(value.boundary) &&
    (value.headChangedAt === null ||
      (typeof value.headChangedAt === "string" &&
        parseStrictIsoUtc(value.headChangedAt) !== null)) &&
    Array.isArray(value.reviews) && value.reviews.every(isReviewRecord) &&
    Array.isArray(value.topLevelComments) &&
    value.topLevelComments.every(isCommentRecord) &&
    Array.isArray(value.reactions) && value.reactions.every(isReactionRecord) &&
    isEvidenceComplete(value.evidenceComplete) &&
    Array.isArray(value.triggerComments) &&
    value.triggerComments.every(isTriggerRecord) &&
    typeof value.evaluatedAt === "string" &&
    parseStrictIsoUtc(value.evaluatedAt) !== null
  );
}
