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
import {
  renderBoundedUntrustedMultilineBlock,
  renderBoundedUntrustedReason,
} from "./untrusted-text.mts";

// Per-field render budgets for the three attacker-influenced sinks in the two
// posted-body builders below. Every one defangs `@codex` triggers, surfaces
// invisibles, and discloses (never silently drops) any truncation via the
// untrusted-text leaf; the caps keep one field — or a flood of tiny error
// entries — from blowing GitHub's 65,536-character comment limit.

// `verdict.reasoning` is schema-capped at MAX_REASONING_LENGTH = 4000 code
// units; the worst-case defang expansion is ×8 (a BMP default-ignorable
// character renders as an 8-char `[U+XXXX]` marker), so 4000 × 8 = 32,000 is
// the smallest bound at which NO schema-valid reasoning ever truncates. A
// truncation here would only ever fire on an out-of-contract payload, and even
// then it discloses the omitted count with the full text in the run log.
const MAX_RENDERED_REASONING_CODE_POINTS = 32_000;

// Each `missing_info_questions[i]` is schema-capped at MAX_QUESTION_LENGTH =
// 500 code units. A generous 1000-cp bound leaves headroom for the rare
// defang-expanded question while still disclosing rather than dropping the
// (out-of-contract) longer case.
const MAX_RENDERED_QUESTION_CODE_POINTS = 1_000;

// A fallback `errors[i]` echoes attacker-influenced material (rejected key
// names, JSON.parse fragments, the fetched issue bodyText) and is NOT
// length-capped by the schema, so it gets its own generous per-item bound with
// disclosure to the run log.
const MAX_RENDERED_ERROR_CODE_POINTS = 1_000;

// The fallback `errors` ARRAY is itself unbounded in item count — thousands of
// tiny per-question validation errors can be produced from one ~20KB payload —
// so the list is two-tier capped: the first MAX_RENDERED_ERROR_ITEMS are
// rendered and the remainder collapse to one trusted omitted-count line. At 40
// items × 1000-cp bound the fallback body stays well under 65,536 characters
// (asserted in a test), and the full error list is on console.error in the run
// log before the first network write.
const MAX_RENDERED_ERROR_ITEMS = 40;

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

/**
 * Reports whether a generation can authorize implementation publication.
 *
 * Legacy numeric values and `hold:` values remain readable history but do
 * not authorize an implementation run.
 *
 * @param generation - A parsed triage generation.
 * @returns Whether it is an exact `<run_id>.<run_attempt>` execution.
 */
export function isAuthorizingTriageGeneration(generation: string): boolean {
  return TRIAGE_EXECUTION_PATTERN.test(generation);
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
 * Selects the identity for a successful-path readiness label write.
 *
 * Only ready-to-spec needs a non-GITHUB_TOKEN identity so its labeled event
 * can trigger story-planner. Every other readiness value stays on the built-in
 * token, as does ready-to-spec when the optional App mint is unavailable.
 */
export function selectLabelWriteToken(
  effectiveReadiness: ReadinessLabel,
  ghToken: string,
  appToken: string,
): string {
  return effectiveReadiness === "ready-to-spec" && appToken !== ""
    ? appToken
    : ghToken;
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
 * Extracts generations from exact bot-owned terminal triage comments.
 *
 * `none` is retained for marker-only or malformed adjacent history so callers
 * can fail closed rather than silently discarding an owned comment.
 *
 * @param comments - One or more issue comments.
 * @returns Parsed generations in input order.
 */
export function extractOwnedTriageGenerations(
  comments: readonly ExistingComment[],
): string[] {
  return comments
    .filter(isOwnedTerminalTriageComment)
    .map((comment) => extractTriageGeneration(comment.body));
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
 * @param effectiveReadiness - Readiness after deterministic intake guards.
 * @param downgradeNotice - Optional trusted deterministic guard notice.
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildVerdictCommentBody(
  verdict: TriageVerdict,
  generation: string,
  effectiveReadiness: ReadinessLabel = verdict.readiness,
  downgradeNotice: string | null = null,
): string {
  // `verdict.readiness` is a closed enum validated by the schema (trusted).
  // `verdict.reasoning` is untrusted multi-line agent prose: render it as an
  // inert fenced block so its `@codex` triggers, invisibles, and any fence/
  // marker-breakout attempt cannot reach the connector or the terminal-anchored
  // generation markers this comment carries.
  const lines: string[] = [
    `**Automated triage verdict: \`${effectiveReadiness}\`**`,
    "",
    renderBoundedUntrustedMultilineBlock(
      verdict.reasoning,
      MAX_RENDERED_REASONING_CODE_POINTS,
      "the run log",
    ),
  ];

  if (verdict.missing_info_questions.length > 0) {
    lines.push("", "**Questions for a human:**");
    for (const q of verdict.missing_info_questions) {
      // Each question is untrusted single-line text — an inline code span is
      // the right inert wrapper (no newlines to preserve here).
      lines.push(
        `- ${renderBoundedUntrustedReason(q, MAX_RENDERED_QUESTION_CODE_POINTS, "the run log")}`,
      );
    }
  }

  if (downgradeNotice !== null) {
    // This is trusted static text produced only by the deterministic intake
    // guard. It never contains issue-body text and therefore must not pass
    // through the untrusted-text renderer used for agent-authored prose.
    lines.push("", downgradeNotice);
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
  // Each error is untrusted (it echoes rejected key names, JSON.parse
  // fragments, and the fetched issue bodyText) — render every item inert and
  // bounded-but-disclosed. The item COUNT is also unbounded, so cap the list:
  // render the first MAX_RENDERED_ERROR_ITEMS and collapse the remainder to one
  // trusted omitted-count line, keeping the body under GitHub's comment limit
  // without silently dropping evidence (the full list is on console.error in
  // the run log before the first network write).
  const shownErrors = errors.slice(0, MAX_RENDERED_ERROR_ITEMS);
  const errorLines = shownErrors.map(
    (e) => `- ${renderBoundedUntrustedReason(e, MAX_RENDERED_ERROR_CODE_POINTS, "the run log")}`,
  );
  const omittedErrors = errors.length - shownErrors.length;
  if (omittedErrors > 0) {
    errorLines.push(
      `- _(${omittedErrors} further error(s) omitted — full detail in the run log.)_`,
    );
  }

  const lines: string[] = [
    "**Automated triage failed.** The `needs-triage` label is unchanged; " +
      "a human should review this issue manually.",
    "",
    "Validation errors:",
    ...errorLines,
    "",
    buildTriageGenerationMarker(generation),
    TRIAGE_COMMENT_MARKER,
  ];
  return lines.join("\n");
}
