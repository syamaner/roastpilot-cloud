import {
  isBoundedNonEmptyString,
  isIsoUtcInstant,
  isPlainObject,
  isSafePositiveInteger,
  unexpectedKeys,
  type ValidationResult,
} from "./validation-common.mts";

export const SNAPSHOT_ALLOWED_KEYS = new Set<string>([
  "issueNumber",
  "title",
  "body",
  "labels",
  "state",
  "snapshotAt",
  "sourceUrl",
]);
export const SNAPSHOT_STATES = ["OPEN"] as const;
export const MAX_SNAPSHOT_BYTES = 262_144;

type SnapshotState = (typeof SNAPSHOT_STATES)[number];

export interface IssueSnapshot {
  readonly issueNumber: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly state: SnapshotState;
  readonly snapshotAt: string;
  readonly sourceUrl: string;
}

const UNBOUNDED_STRING_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Validates a parsed issue snapshot without I/O. PR-2's loader must reject
 * raw text over MAX_SNAPSHOT_BYTES before parsing and calling this function.
 */
export function validateIssueSnapshot(
  raw: unknown,
): ValidationResult<IssueSnapshot> {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ["snapshot must be an object"] };
  }
  const unknown = unexpectedKeys(raw, SNAPSHOT_ALLOWED_KEYS);
  if (unknown.length > 0) {
    errors.push(`snapshot has unexpected key(s): ${unknown.join(", ")}`);
  }

  const validIssueNumber = isSafePositiveInteger(raw.issueNumber);
  if (!validIssueNumber) {
    errors.push("snapshot.issueNumber must be a positive integer");
  }
  if (!isBoundedNonEmptyString(raw.title, UNBOUNDED_STRING_MAX)) {
    errors.push("snapshot.title must be a non-empty string");
  }
  if (!isBoundedNonEmptyString(raw.body, UNBOUNDED_STRING_MAX)) {
    errors.push("snapshot.body must be a non-empty string");
  }
  if (!Array.isArray(raw.labels)) {
    errors.push("snapshot.labels must be an array");
  } else {
    if (raw.labels.length > 30) {
      errors.push("snapshot.labels must contain at most 30 entries");
    }
    raw.labels.forEach((label: unknown, index: number) => {
      if (!isBoundedNonEmptyString(label, 100)) {
        errors.push(
          `snapshot.labels[${index}] must be a non-empty string of at most 100 characters`,
        );
      }
    });
  }
  if (
    typeof raw.state !== "string" ||
    !(SNAPSHOT_STATES as readonly string[]).includes(raw.state)
  ) {
    errors.push(`snapshot.state must be one of ${SNAPSHOT_STATES.join(", ")}`);
  }
  if (!isIsoUtcInstant(raw.snapshotAt)) {
    errors.push("snapshot.snapshotAt must be a whole-second UTC-Z instant");
  }
  if (
    typeof raw.sourceUrl !== "string" ||
    (validIssueNumber &&
      raw.sourceUrl !==
        `https://github.com/syamaner/roastpilot-cloud/issues/${String(raw.issueNumber)}`)
  ) {
    errors.push("snapshot.sourceUrl must be the canonical issue URL");
  }

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: raw as unknown as IssueSnapshot };
}
