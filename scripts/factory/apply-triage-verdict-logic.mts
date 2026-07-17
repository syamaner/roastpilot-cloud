/**
 * Pure logic for the privileged `apply` job in
 * `.github/workflows/triage-issues.yml`. Nothing here calls the network —
 * the network-facing entrypoint (`apply-triage-verdict.mts`) computes
 * inputs, calls these functions, and issues the resulting API calls. Kept
 * separate so the label/comment decisions (the security-relevant part) are
 * unit-testable without mocking `fetch`.
 */

import {
  READINESS_LABELS,
  type ReadinessLabel,
  type TriageVerdict,
} from "./triage-verdict-schema.mts";

/**
 * Hidden marker embedded in every triage comment this job posts. Used to
 * find "our" comment on a re-run (idempotency, factory.md §13 point 8)
 * without duplicate-posting. This is a fixed string we control — it is
 * never derived from verdict content, so a verdict cannot spoof it.
 */
export const TRIAGE_COMMENT_MARKER =
  "<!-- roastpilot-factory:triage-verdict:do-not-edit -->";

const READINESS_LABEL_SET = new Set<string>(READINESS_LABELS);

/**
 * Computes the full label set to PUT on the issue so that exactly one
 * readiness label is present afterward, while preserving every non-readiness
 * label already on the issue (e.g. `epic:F1`).
 *
 * Uses PUT-replace-all semantics deliberately: GitHub's label PUT endpoint
 * replaces the entire set, so the caller must pass back everything it wants
 * kept, not just the readiness label.
 *
 * @param currentLabels - Label names currently on the issue.
 * @param newReadiness - The readiness label the verdict assigned.
 * @returns The full label set to PUT, with duplicates removed.
 */
export function computeNewLabelSet(
  currentLabels: readonly string[],
  newReadiness: ReadinessLabel,
): string[] {
  const kept = currentLabels.filter((l) => !READINESS_LABEL_SET.has(l));
  return Array.from(new Set([...kept, newReadiness]));
}

/** A comment as returned by the GitHub REST API, narrowed to the fields we use. */
export interface ExistingComment {
  readonly id: number;
  readonly body: string;
  /** GitHub's `user.type`, e.g. `"Bot"` for the Actions token's identity. */
  readonly authorType: string | null;
}

/**
 * Finds the previous triage comment this job posted on an earlier run, if
 * any, so a re-run edits it instead of posting a duplicate.
 *
 * Scoped to bot-authored comments containing the marker — not just any
 * comment containing the marker substring. A verdict's `reasoning` text is
 * untrusted and could itself contain the marker string (accidentally or as
 * a deliberate decoy); scoping to `authorType === "Bot"` stops that from
 * being mistaken for our own tracking comment.
 *
 * @param comments - Comments currently on the issue.
 * @returns The existing comment's id, or `null` if none found.
 */
export function findExistingTriageCommentId(
  comments: readonly ExistingComment[],
): number | null {
  const match = comments.find(
    (c) => c.authorType === "Bot" && c.body.includes(TRIAGE_COMMENT_MARKER),
  );
  return match ? match.id : null;
}

/**
 * Builds the comment body posted for a verdict that passed validation.
 *
 * @param verdict - The validated verdict.
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildVerdictCommentBody(verdict: TriageVerdict): string {
  const lines: string[] = [
    `**Automated triage verdict: \`${verdict.readiness}\`**`,
    "",
    "> " + verdict.reasoning.split("\n").join("\n> "),
  ];

  if (verdict.missing_info_questions.length > 0) {
    lines.push("", "**Questions for a human:**");
    for (const q of verdict.missing_info_questions) {
      lines.push(`- ${q}`);
    }
  }

  lines.push(
    "",
    "_Posted by the roastpilot-cloud triage workflow (factory.md §3). " +
      "This label reflects the automated verdict above — a human may " +
      "override it._",
    "",
    TRIAGE_COMMENT_MARKER,
  );

  return lines.join("\n");
}

/**
 * Builds the comment body posted when the triage artifact was missing or
 * failed schema validation. The `needs-triage` label seeded at issue-open
 * time is left in place (the apply job never removes it on this path) —
 * this comment exists purely for visibility.
 *
 * @param errors - The validation errors, or a single explanatory entry if
 *   the artifact itself was missing.
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildFallbackCommentBody(errors: readonly string[]): string {
  const lines: string[] = [
    "**Automated triage failed.** The `needs-triage` label is unchanged; " +
      "a human should review this issue manually.",
    "",
    "Validation errors:",
    ...errors.map((e) => `- ${e}`),
    "",
    TRIAGE_COMMENT_MARKER,
  ];
  return lines.join("\n");
}
