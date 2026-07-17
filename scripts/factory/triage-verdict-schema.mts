/**
 * The triage verdict JSON contract (factory.md §3, §6, §13 point 8's
 * validation fold).
 *
 * The read-only `triage` job (running the `.claude/skills/triage` skill,
 * see that file's frontmatter for the matching schema description) writes a
 * verdict of this shape to a file; the privileged `apply` job in
 * `.github/workflows/triage-issues.yml` reads that file back and MUST run it
 * through {@link validateTriageVerdict} before acting on it. Nothing here
 * calls the network or touches the filesystem — it is pure so it can be
 * unit-tested directly against adversarial input (a prompt-injected or
 * malformed verdict must be rejected, never acted on).
 */

/**
 * The exact readiness label taxonomy (factory.md §4). A verdict's
 * `readiness` value must be one of these strings, byte-for-byte — no
 * case-insensitive or fuzzy matching, so a near-miss value fails closed
 * instead of silently mapping to something plausible.
 */
export const READINESS_LABELS = [
  "needs-triage",
  "ready-to-implement",
  "ready-to-spec",
  "needs-info",
  "wait-to-implement",
  "wontfix",
] as const;

export type ReadinessLabel = (typeof READINESS_LABELS)[number];

/** Upper bound on `reasoning` length, in characters. */
export const MAX_REASONING_LENGTH = 4000;

/** Upper bound on each entry of `missing_info_questions`, in characters. */
export const MAX_QUESTION_LENGTH = 500;

/** Upper bound on the number of entries in `missing_info_questions`. */
export const MAX_QUESTIONS = 10;

/**
 * Upper bound on the serialized verdict size, in UTF-8 bytes. Guards
 * against a runaway or adversarial payload before any of the field-level
 * checks below even run.
 */
export const MAX_PAYLOAD_BYTES = 20_000;

/** A verdict that has passed {@link validateTriageVerdict}. */
export interface TriageVerdict {
  readonly issue_number: number;
  readonly readiness: ReadinessLabel;
  readonly reasoning: string;
  readonly missing_info_questions: readonly string[];
}

export type TriageVerdictValidationResult =
  | { readonly ok: true; readonly verdict: TriageVerdict }
  | { readonly ok: false; readonly errors: readonly string[] };

/** The exact set of top-level keys a verdict may contain — no more, no less. */
const ALLOWED_KEYS = new Set<string>([
  "issue_number",
  "readiness",
  "reasoning",
  "missing_info_questions",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/**
 * Validates a raw (untrusted, possibly prompt-injected) triage verdict
 * against the JSON contract described above.
 *
 * The `trustedIssueNumber` must come from the GitHub Actions event context
 * (`github.event.issue.number`), never from anywhere the agent could
 * influence. A verdict whose self-reported `issue_number` disagrees is
 * rejected outright — the agent's output must not be able to redirect a
 * label/comment write to a different issue.
 *
 * @param raw - The parsed JSON value read from the triage artifact.
 * @param trustedIssueNumber - The issue number from the trusted workflow
 *   event context.
 * @returns A discriminated result: `{ ok: true, verdict }` with a verdict
 *   safe to act on, or `{ ok: false, errors }` listing every violation
 *   found (validation does not stop at the first error, so the fallback
 *   comment can report everything wrong at once).
 */
export function validateTriageVerdict(
  raw: unknown,
  trustedIssueNumber: number,
): TriageVerdictValidationResult {
  const errors: string[] = [];

  if (!Number.isInteger(trustedIssueNumber) || trustedIssueNumber <= 0) {
    // Defensive: this is a caller bug (bad workflow wiring), not an
    // attacker-controlled condition, but fail closed all the same.
    errors.push(
      `internal error: trustedIssueNumber must be a positive integer, got ${String(trustedIssueNumber)}`,
    );
    return { ok: false, errors };
  }

  let payloadBytes: number;
  try {
    payloadBytes = Buffer.byteLength(JSON.stringify(raw ?? null), "utf8");
  } catch {
    payloadBytes = Number.POSITIVE_INFINITY;
  }
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    errors.push(
      `payload too large: ${payloadBytes} bytes exceeds ${MAX_PAYLOAD_BYTES}`,
    );
    // A payload this size is not worth inspecting field-by-field further.
    return { ok: false, errors };
  }

  if (!isPlainObject(raw)) {
    errors.push(
      `verdict must be a JSON object, got ${raw === null ? "null" : Array.isArray(raw) ? "array" : typeof raw}`,
    );
    return { ok: false, errors };
  }

  const unknownKeys = Object.keys(raw).filter((k) => !ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) {
    errors.push(`unexpected key(s): ${unknownKeys.join(", ")}`);
  }

  // issue_number
  const issueNumber = raw.issue_number;
  if (!Number.isInteger(issueNumber) || (issueNumber as number) <= 0) {
    errors.push(
      `issue_number must be a positive integer, got ${JSON.stringify(issueNumber)}`,
    );
  } else if (issueNumber !== trustedIssueNumber) {
    errors.push(
      `issue_number mismatch: verdict claims ${String(issueNumber)}, ` +
        `trusted workflow context says ${trustedIssueNumber} — refusing to ` +
        `act (possible redirection attempt)`,
    );
  }

  // readiness
  const readiness = raw.readiness;
  if (
    typeof readiness !== "string" ||
    !(READINESS_LABELS as readonly string[]).includes(readiness)
  ) {
    errors.push(
      `readiness must be one of ${READINESS_LABELS.join(", ")}, got ${JSON.stringify(readiness)}`,
    );
  }

  // reasoning
  const reasoning = raw.reasoning;
  if (typeof reasoning !== "string" || reasoning.trim().length === 0) {
    errors.push("reasoning must be a non-empty string");
  } else if (reasoning.length > MAX_REASONING_LENGTH) {
    errors.push(
      `reasoning exceeds ${MAX_REASONING_LENGTH} characters (${reasoning.length})`,
    );
  }

  // missing_info_questions
  const questions = raw.missing_info_questions;
  if (!Array.isArray(questions)) {
    errors.push("missing_info_questions must be an array of strings");
  } else {
    if (questions.length > MAX_QUESTIONS) {
      errors.push(
        `missing_info_questions has ${questions.length} entries, exceeds ${MAX_QUESTIONS}`,
      );
    }
    questions.forEach((q: unknown, i: number) => {
      if (typeof q !== "string" || q.trim().length === 0) {
        errors.push(`missing_info_questions[${i}] must be a non-empty string`);
      } else if (q.length > MAX_QUESTION_LENGTH) {
        errors.push(
          `missing_info_questions[${i}] exceeds ${MAX_QUESTION_LENGTH} characters (${q.length})`,
        );
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    verdict: {
      issue_number: issueNumber as number,
      readiness: readiness as ReadinessLabel,
      reasoning: reasoning as string,
      missing_info_questions: questions as string[],
    },
  };
}
