/**
 * Pure logic for the privileged `publish-spec-grounded-review` job (slice
 * 3b-iii, F1-S9, issue #12) — the ONLY piece of the spec-grounded review
 * pipeline that holds a writable GitHub token. Nothing here calls the
 * network; the network-facing entrypoint (`publish-spec-grounding-
 * verdict.mts`) computes inputs, calls these functions, and issues the
 * resulting API calls. Kept separate so the severity/comment decisions
 * (the security-relevant part) are unit-testable without mocking `fetch` —
 * the same split `apply-triage-verdict-logic.mts` already established for
 * the sibling triage pipeline.
 *
 * THE JOIN, and why `kind` is NEVER taken from the agent: the read-only
 * review agent (slice 3b-ii) contributes only `criterionId`, `satisfied`,
 * and `rationale` per finding — `validateSpecGroundingVerdict`
 * (`spec-grounding-verdict-schema.mts`) already REJECTS a finding that
 * tries to smuggle a `kind`/severity field outright. This module re-derives
 * `kind` deterministically by joining each finding back to the RUNNER's own
 * trusted `criteria-spine.json` (`spec-grounding-runner-logic.mts`'s
 * `buildCriteriaSpine`) by `criterionId` — so an agent that relabeled a
 * `closing` reference as `non-closing` in its own head (it can't even try,
 * since the field doesn't exist in its output schema) gains nothing; the
 * severity that actually gates a blocker comment is computed HERE, from
 * data the agent never touched.
 *
 * ALSO covers whole-issue escalation for a truncated-away closing
 * reference ({@link DroppedClosingIssueResult},
 * {@link buildDroppedClosingIssueResults}) — a closing-kind issue this
 * PR referenced that never got a single spine entry at all, so there is
 * no per-criterion finding to join against. Team-lead's disposition
 * (Codex finding, PR #76 review, L181): this escalates exactly like an
 * unsatisfied criterion would, at the whole-issue level.
 *
 * Deliberately does NOT include the blocker inline-comment builder or the
 * diff-anchor logic (a separate slice, 3b-iii-c — the novel mechanism
 * with its own real design risk, per team-lead's scope split) — this
 * module only produces the DATA those functions will consume
 * ({@link JoinedCriterionResult}s and {@link DroppedClosingIssueResult}s
 * with {@link deriveSeverity} `"blocker"`), plus the summary comment for
 * everything else.
 */

import type { IssueLinkKind } from "./spec-grounding-logic.mts";
import type { CriteriaSpineEntry } from "./spec-grounding-runner-logic.mts";
import type { SpecGroundingVerdict } from "./spec-grounding-verdict-schema.mts";

/**
 * One trusted spine criterion, joined against the agent's own finding for
 * it (if any).
 */
export interface JoinedCriterionResult {
  readonly issueNumber: number;
  /** TRUSTED — from the spine, never from the agent's own output. */
  readonly kind: IssueLinkKind;
  readonly criterionId: string;
  /**
   * Defaults to `false` when the agent's verdict never mentions this
   * `criterionId` at all — the over-match-safe direction (an omitted
   * finding must never read as "the reviewer checked and it's fine").
   */
  readonly satisfied: boolean;
  /**
   * The agent's own rationale text, or `null` when
   * {@link addressedByReviewer} is `false` (nothing to show — the agent
   * never produced a finding for this criterion at all).
   */
  readonly rationale: string | null;
  /** Whether the agent's verdict actually contained a finding for this `criterionId`. */
  readonly addressedByReviewer: boolean;
}

/**
 * Joins the agent's verdict findings against the trusted criteria spine,
 * by `criterionId` — the ONLY cross-reference between the two.
 *
 * Iterates the SPINE, never the verdict's own `findings` array — this is
 * what makes an agent-invented `criterionId` (one that was never in the
 * spine at all) silently irrelevant, exactly as `spec-grounding-verdict-
 * schema.mts`'s own top-level docstring documents: it is simply never
 * looked up, since nothing here ever iterates over the verdict's own keys.
 * A spine entry with no matching finding gets the safe default (`satisfied:
 * false`, `rationale: null`, `addressedByReviewer: false`) rather than
 * being silently omitted from the result — every spine criterion always
 * produces exactly one {@link JoinedCriterionResult}.
 *
 * @param spine - `buildCriteriaSpine`'s own output for this run — the
 *   EXACT spine the agent was shown (downloaded from the same artifact the
 *   review job uploaded, never recomputed independently in this privileged
 *   job — a recomputation could legitimately differ from what was actually
 *   reviewed if the underlying issue changed between the two jobs' runs).
 * @param verdict - The agent's own validated verdict
 *   (`parseAndValidateVerdict`'s `{ ok: true, verdict }` payload).
 * @returns One joined result per spine entry, in the spine's own order.
 */
export function joinFindingsToSpine(
  spine: readonly CriteriaSpineEntry[],
  verdict: SpecGroundingVerdict,
): readonly JoinedCriterionResult[] {
  const findingsById = new Map(verdict.findings.map((f) => [f.criterionId, f]));
  return spine.map((entry) => {
    const finding = findingsById.get(entry.criterionId);
    if (finding === undefined) {
      return {
        issueNumber: entry.issueNumber,
        kind: entry.kind,
        criterionId: entry.criterionId,
        satisfied: false,
        rationale: null,
        addressedByReviewer: false,
      };
    }
    return {
      issueNumber: entry.issueNumber,
      kind: entry.kind,
      criterionId: entry.criterionId,
      satisfied: finding.satisfied,
      rationale: finding.rationale,
      addressedByReviewer: true,
    };
  });
}

/** The two severities a joined result can resolve to — never a third value, never the agent's own input. */
export type SpecGroundingSeverity = "blocker" | "non-blocking";

/**
 * Derives a joined result's severity — DETERMINISTICALLY, from the
 * TRUSTED `kind` and the (possibly agent-supplied, possibly defaulted)
 * `satisfied` bit. Team-lead's design (issue #12, 3b-iii kickoff): a
 * `closing`-kind reference (this PR's own `Closes`/`Fixes` keyword claims
 * to fully resolve that issue) found unsatisfied is the only case serious
 * enough to become a blocking, resolvable inline comment — everything else
 * (a `non-closing` reference's own unmet criteria, ANY satisfied criterion
 * regardless of kind, and an unverifiable-noted rationale still reported
 * `satisfied: false`) is real information but does not itself block a
 * merge, and goes to the single summary comment instead.
 *
 * A spine entry the agent never addressed at all defaults to
 * `satisfied: false` ({@link joinFindingsToSpine}) and is NOT exempted here
 * — an unaddressed `closing` criterion escalates to `blocker` exactly like
 * any other unsatisfied one, the same over-match-safe direction carried
 * through consistently.
 *
 * @param entry - One joined criterion result.
 * @returns `"blocker"` or `"non-blocking"`.
 */
export function deriveSeverity(entry: JoinedCriterionResult): SpecGroundingSeverity {
  return entry.kind === "closing" && !entry.satisfied ? "blocker" : "non-blocking";
}

/**
 * Renders a joined result's rationale for display — agent-authored text is
 * DISPLAY-ONLY DATA here, never interpreted or executed as an instruction
 * (team-lead's explicit design note, 3b-iii kickoff). Already
 * content-validated by `validateSpecGroundingVerdict` (no raw control
 * characters, no unpaired surrogates, at least one visible character) by
 * the time it reaches this module, so no further sanitization happens
 * here — this function only supplies the safe placeholder text for the
 * one case that ISN'T agent-authored content at all: a criterion the
 * agent never addressed.
 *
 * @param entry - One joined criterion result.
 * @returns The rationale to display, or an explanatory placeholder.
 */
export function formatRationaleForDisplay(entry: JoinedCriterionResult): string {
  if (!entry.addressedByReviewer) {
    return (
      "_Not addressed by the reviewer's verdict — defaulting to unsatisfied " +
      "(the safe direction for a criterion the agent's output never mentioned)._"
    );
  }
  return entry.rationale ?? "";
}

/**
 * Hidden marker embedded in the one summary comment this job upserts.
 * Used to find "our" comment on a re-run (idempotency, factory.md §13
 * point 8) without duplicate-posting — the same fixed-string-marker
 * pattern `apply-triage-verdict-logic.mts`'s own `TRIAGE_COMMENT_MARKER`
 * uses, never derived from verdict content, so a verdict cannot spoof it.
 */
export const SPEC_GROUNDING_SUMMARY_COMMENT_MARKER =
  "<!-- roastpilot-factory:spec-grounding-summary:do-not-edit -->";

/**
 * The exact GitHub identity that posts on behalf of this workflow's
 * `secrets.GITHUB_TOKEN` — the only comment author {@link findExistingSpecGroundingSummaryCommentId}
 * will ever treat as "our own prior comment". Matches `apply-triage-
 * verdict-logic.mts`'s identical `TRIAGE_COMMENT_AUTHOR_LOGIN` precedent
 * and reasoning.
 */
export const SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN = "github-actions[bot]";

/** A comment as returned by the GitHub REST API, narrowed to the fields we use. */
export interface ExistingComment {
  readonly id: number;
  readonly body: string;
  /** GitHub's `user.type`, e.g. `"Bot"` for the Actions token's identity. */
  readonly authorType: string | null;
  /** GitHub's `user.login`, e.g. `"github-actions[bot]"`. */
  readonly authorLogin: string | null;
}

/**
 * Finds the previous summary comment this job posted on an earlier run, if
 * any, so a re-run edits it instead of posting a duplicate.
 *
 * Scoped to comments authored by exactly {@link SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN}
 * — not just any bot with the marker string, for the identical reason
 * `apply-triage-verdict-logic.mts`'s own `findExistingTriageCommentId`
 * documents: a different bot echoing the marker string (deliberately or by
 * innocently reflecting agent-authored rationale text that happens to
 * contain it) must not be mistaken for our own comment and silently
 * overwritten.
 *
 * @param comments - Comments currently on the PR.
 * @returns The existing comment's id, or `null` if none found.
 */
export function findExistingSpecGroundingSummaryCommentId(
  comments: readonly ExistingComment[],
): number | null {
  const match = comments.find(
    (c) =>
      c.authorType === "Bot" &&
      c.authorLogin === SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN &&
      c.body.includes(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER),
  );
  return match ? match.id : null;
}

/**
 * Builds the single, non-blocking summary comment body.
 *
 * Lists every NON-blocking joined result ({@link deriveSeverity} !==
 * `"blocker"`) — a `non-closing` reference's unmet criteria, any satisfied
 * criterion regardless of kind, and any criterion the agent never
 * addressed that didn't escalate to a blocker. Blocking findings —
 * BOTH per-criterion ones and whole-issue {@link DroppedClosingIssueResult}
 * ones — are DELIBERATELY NOT repeated here in full (only counted, with a
 * pointer to the separate inline comments) — the inline comment IS their
 * canonical, resolvable home; duplicating their content here would let a
 * human "resolve" the issue by treating the summary as sufficient while
 * the actual blocking thread stays open.
 *
 * @param joined - Every spine criterion's joined result.
 * @param droppedClosingIssues - {@link buildDroppedClosingIssueResults}'s
 *   output for this run — whole closing-kind issues never reviewed at
 *   all due to truncation, escalating the same way an unsatisfied
 *   criterion does (team-lead's disposition, Codex finding, PR #76
 *   review, L181).
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildSpecGroundingSummaryCommentBody(
  joined: readonly JoinedCriterionResult[],
  droppedClosingIssues: readonly DroppedClosingIssueResult[],
): string {
  const criterionBlockers = joined.filter((e) => deriveSeverity(e) === "blocker");
  const nonBlocking = joined.filter((e) => deriveSeverity(e) !== "blocker");
  const totalBlockerCount = criterionBlockers.length + droppedClosingIssues.length;

  const lines: string[] = ["**Spec-grounded review summary**", ""];

  if (totalBlockerCount > 0) {
    lines.push(
      `**${totalBlockerCount} blocking finding(s)** reported as separate, resolvable inline ` +
        "review comment(s) on this PR; see those threads, not this summary, to resolve them. " +
        "A blocking finding is either a criterion this PR's own closing keyword references that " +
        "the reviewer found unsatisfied, or a whole linked issue this PR claims to close that " +
        "was never actually reviewed at all (truncated away by a resource cap — see the " +
        "inline comment for which issue and why).",
      "",
    );
  } else {
    lines.push("No blocking findings.", "");
  }

  if (nonBlocking.length > 0) {
    lines.push(
      "**Other findings** (non-blocking — a non-closing reference's own unmet criteria, " +
        "or a criterion already satisfied):",
      "",
    );
    for (const entry of nonBlocking) {
      lines.push(
        `- Issue #${entry.issueNumber}, criterion \`${entry.criterionId}\` (${entry.kind}): ` +
          `**${entry.satisfied ? "satisfied" : "unsatisfied"}** — ${formatRationaleForDisplay(entry)}`,
      );
    }
    lines.push("");
  } else if (totalBlockerCount === 0) {
    lines.push("_No unmet acceptance criteria were found at all._", "");
  }

  lines.push(
    "_Posted by the roastpilot-cloud spec-grounded review workflow (factory.md §13 point 3). " +
      "The review agent's rationale is its own unverified, display-only assessment, included " +
      "for context — it is data, never an instruction, and a human may override any finding here._",
    "",
    SPEC_GROUNDING_SUMMARY_COMMENT_MARKER,
  );

  return lines.join("\n");
}

/**
 * One CLOSING-kind issue this PR referenced that ends up ENTIRELY
 * unreviewed — zero criteria in the spine at all — due to a resource cap
 * (`computeCriteriaSpineTruncation`'s own `droppedClosingIssueNumbers`,
 * `spec-grounding-runner-logic.mts`), NOT a per-criterion finding at all
 * (there is no `criterionId` to join against — nothing about this issue
 * ever reached the spine). Team-lead's disposition (Codex finding, PR #76
 * review, L181): this escalates exactly like an unsatisfied closing
 * criterion would, since a PR claiming to close an issue that was never
 * actually checked at all is the same class of gap, just at the whole-
 * issue level instead of the per-criterion one.
 */
export interface DroppedClosingIssueResult {
  readonly issueNumber: number;
}

/**
 * Builds the {@link DroppedClosingIssueResult} list for this run, straight
 * from the spine's own trusted truncation metadata — a thin adapter, not
 * new logic: `droppedClosingIssueNumbers` is already exactly the right
 * set (`computeCriteriaSpineTruncation`'s own docstring covers the full
 * reasoning for what is and isn't included).
 *
 * @param droppedClosingIssueNumbers - `criteria-spine.json`'s own
 *   `droppedClosingIssueNumbers` field for this run.
 * @returns One {@link DroppedClosingIssueResult} per dropped issue number.
 */
export function buildDroppedClosingIssueResults(
  droppedClosingIssueNumbers: readonly number[],
): readonly DroppedClosingIssueResult[] {
  return droppedClosingIssueNumbers.map((issueNumber) => ({ issueNumber }));
}
