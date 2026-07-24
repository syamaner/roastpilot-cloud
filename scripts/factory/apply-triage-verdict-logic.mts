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

const ADJACENT_TRIAGE_GENERATION_PATTERN =
  /(?:^|\n)<!-- roastpilot-factory:triage-generation:[^\r\n]*\r?\n<!-- roastpilot-factory:triage-verdict:do-not-edit -->$/;
const TRIAGE_GENERATION_PATTERN =
  /(?:^|\n)<!-- roastpilot-factory:triage-generation:(hold:[1-9][0-9]*\.[1-9][0-9]*|[1-9][0-9]*(?:\.[1-9][0-9]*)?):do-not-edit -->\r?\n<!-- roastpilot-factory:triage-verdict:do-not-edit -->$/;
const TRIAGE_GENERATION_VALUE_PATTERN =
  /^(?:hold:[1-9][0-9]*\.[1-9][0-9]*|[1-9][0-9]*(?:\.[1-9][0-9]*)?)$/;
const TRIAGE_EXECUTION_PATTERN = /^[1-9][0-9]*\.[1-9][0-9]*$/;

/**
 * Reports whether trusted triage-comment syntax carries a generation line.
 *
 * The line must be immediately adjacent to the terminal fixed marker.
 * Generation-like text elsewhere is agent-authored rationale, not syntax.
 * The value is deliberately not parsed here: valid and malformed adjacent
 * generation lines both block publication during the transitional fence.
 *
 * @param body - Complete triage-comment body.
 * @returns Whether an adjacent generation namespace line is present.
 */
export function hasAdjacentTriageGenerationMarker(body: string): boolean {
  return ADJACENT_TRIAGE_GENERATION_PATTERN.test(body);
}

/**
 * Builds the trusted marker placed immediately before the fixed marker.
 *
 * @param generation - A legacy, hold, or final triage generation.
 * @returns The hidden generation marker.
 */
export function buildTriageGenerationMarker(generation: string): string {
  if (!TRIAGE_GENERATION_VALUE_PATTERN.test(generation)) {
    throw new Error(`triage generation has an invalid format`);
  }
  return `<!-- roastpilot-factory:triage-generation:${generation}:do-not-edit -->`;
}

/**
 * Extracts the generation anchored beside the final factory marker.
 *
 * @param body - The complete trusted triage comment body.
 * @returns The generation, or `none` for legacy history.
 */
export function extractTriageGeneration(body: string): string {
  return TRIAGE_GENERATION_PATTERN.exec(body)?.[1] ?? "none";
}

/**
 * Builds the non-authorizing generation installed before re-triage.
 *
 * @param execution - The trusted `<run_id>.<run_attempt>` identity.
 * @returns The corresponding hold generation.
 */
export function buildTriageHoldGeneration(execution: string): string {
  if (!TRIAGE_EXECUTION_PATTERN.test(execution)) {
    throw new Error(`triage execution must be <run_id>.<run_attempt>`);
  }
  return `hold:${execution}`;
}

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

/**
 * The exact GitHub identity that posts on behalf of this workflow's
 * `secrets.GITHUB_TOKEN` — required by owned terminal-history and current-hold
 * checks.
 */
export const TRIAGE_COMMENT_AUTHOR_LOGIN = "github-actions[bot]";

/** A comment as returned by the GitHub REST API, narrowed to the fields we use. */
export interface ExistingComment {
  readonly id: number;
  readonly body: string;
  /** GitHub's `user.type`, e.g. `"Bot"` for the Actions token's identity. */
  readonly authorType: string | null;
  /** GitHub's `user.login`, e.g. `"github-actions[bot]"`. */
  readonly authorLogin: string | null;
}

function isOwnedTerminalTriageComment(comment: ExistingComment): boolean {
  return (
    comment.authorType === "Bot" &&
    comment.authorLogin === TRIAGE_COMMENT_AUTHOR_LOGIN &&
    (comment.body === TRIAGE_COMMENT_MARKER ||
      comment.body.endsWith(`\n${TRIAGE_COMMENT_MARKER}`))
  );
}

/**
 * Reports whether any exact owned terminal triage history blocks publication.
 *
 * Callers aggregate every comment page before treating `false` as conclusive;
 * a blocker may safely short-circuit.
 *
 * @param comments - One page of issue comments.
 * @returns Whether this page contains generated triage history.
 */
export function hasBlockingTriageGeneration(
  comments: readonly ExistingComment[],
): boolean {
  return comments.some(
    (comment) =>
      isOwnedTerminalTriageComment(comment) &&
      hasAdjacentTriageGenerationMarker(comment.body),
  );
}

/**
 * Builds the comment body posted for a verdict that passed validation.
 *
 * Deliberately never closes the issue, for any readiness including
 * `wontfix` — closing is a consequential, human decision (the same
 * philosophy as "the factory never merges", factory.md §2). For `wontfix`
 * specifically, the comment says so explicitly rather than leaving the
 * absence of a close action to read as an oversight.
 *
 * @param verdict - The validated verdict.
 * @param generation - The final trusted triage execution.
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildVerdictCommentBody(
  verdict: TriageVerdict,
  generation: string,
): string {
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

  if (verdict.readiness === "wontfix") {
    lines.push(
      "",
      "_This is only a label change — the factory does not close issues. " +
        "A maintainer should confirm this assessment and close the issue " +
        "if appropriate._",
    );
  }

  lines.push(
    "",
    "_Posted by the roastpilot-cloud triage workflow (factory.md §3). " +
      "This label reflects the automated verdict above — a human may " +
      "override it._",
    "",
    buildTriageGenerationMarker(generation),
    TRIAGE_COMMENT_MARKER,
  );

  return lines.join("\n");
}

/**
 * Builds the comment body posted when the triage artifact was missing or
 * failed schema validation. The `needs-triage` label installed by seed is
 * left in place (the apply job never removes it on this path) —
 * this comment exists purely for visibility.
 *
 * @param errors - The validation errors, or a single explanatory entry if
 *   the artifact itself was missing.
 * @param generation - The non-authorizing hold generation.
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildFallbackCommentBody(
  errors: readonly string[],
  generation: string,
): string {
  const lines: string[] = [
    "**Automated triage failed.** The `needs-triage` label is unchanged; " +
      "a human should review this issue manually.",
    "",
    "Validation errors:",
    ...errors.map((e) => `- ${e}`),
    "",
    buildTriageGenerationMarker(generation),
    TRIAGE_COMMENT_MARKER,
  ];
  return lines.join("\n");
}
