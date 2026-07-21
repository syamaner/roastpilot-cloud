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
 * ALSO covers whole-issue escalation for an incompletely-reviewed closing
 * reference ({@link UnreviewedClosingIssueResult}, `spec-grounding-
 * runner-logic.mts`'s own `computeCriteriaSpineTruncation`) — a
 * closing-kind issue this PR referenced whose review is incomplete
 * (either it never got a single spine entry at all, or it got some but
 * not all of its own criteria), so there is no full per-criterion finding
 * set to join against. Team-lead's disposition (Codex finding, PR #76
 * review, L181, widened PR #82 round 2 review FOLD 1): this escalates
 * exactly like an unsatisfied criterion would, at the whole-issue level.
 *
 * Deliberately does NOT include the blocker inline-comment builder or the
 * diff-anchor logic (a separate slice, 3b-iii-c — the novel mechanism
 * with its own real design risk, per team-lead's scope split) — this
 * module only produces the DATA those functions will consume
 * ({@link JoinedCriterionResult}s and {@link UnreviewedClosingIssueResult}s
 * with {@link deriveSeverity} `"blocker"`), plus the summary comment for
 * everything else.
 */

import type { IssueLinkKind } from "./spec-grounding-logic.mts";
import { escapeInvisibleCharactersVisibly } from "./spec-grounding-runner-logic.mts";
import type { CriteriaSpineEntry, UnreviewedClosingIssueResult } from "./spec-grounding-runner-logic.mts";
import type { SpecGroundingVerdict } from "./spec-grounding-verdict-schema.mts";

export type { UnreviewedClosingIssueResult } from "./spec-grounding-runner-logic.mts";

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
 * Upper bound on a single rationale's rendered length, in CODE POINTS
 * (not UTF-16 code units — see {@link sanitizeAgentRationaleForDisplay}'s
 * own docstring, PR #82 round 2 review, FOLD 4), before it's truncated
 * with a pointer to the full verdict artifact (PR #82 review round 1,
 * FOLD 3 — LOW: `validateSpecGroundingVerdict`'s own `MAX_RATIONALE_LENGTH`
 * is 2000 characters PER finding; the full verdict is uploaded as an
 * artifact regardless, so this display cap loses nothing a human can't
 * still find there — it only bounds how much of a giant rationale
 * inflates THIS comment, which also has its own hard cap, see
 * `buildSpecGroundingSummaryCommentBody`'s own `MAX_FINDINGS_LIST_LENGTH`).
 */
const MAX_RATIONALE_DISPLAY_LENGTH = 300;

/**
 * Neutralizes agent-authored rationale text before it reaches a posted
 * bot comment (PR #82 review, FOLD 2 — LOW): `validateSpecGroundingVerdict`
 * validates rationale CONTENT (no raw control characters, no unpaired
 * surrogates, at least one visible character) but NOT Markdown
 * STRUCTURE — an agent-influenced rationale (ultimately derived from a
 * public issue's own text, itself editable by anyone) rendered as raw
 * Markdown under `github-actions[bot]`'s identity could inject a
 * `\n<!--` (an unclosed HTML comment hiding everything the bot posts
 * after it), a spoofed heading, a live autolinked URL, or an `@mention`.
 *
 * Mirrors `implement-patch-logic.mts`'s own categorical fix for this
 * exact injection class (`sanitizeStepSummaryText`, see that function's
 * docstring for the full 3-round history of why per-metacharacter
 * escaping loses to GFM autolinking and a code span is the only
 * categorical defense): wraps the value in a GitHub-Flavored-Markdown
 * inline code span, which renders its contents as literal text —
 * no emphasis, no links, no autolinks, no HTML — by construction. The
 * only two characters that could break OUT of the span (a literal
 * backtick, or a newline that could end the containing list item/start
 * a new Markdown block) are stripped first, same as that function.
 *
 * A code span does NOT, however, stop Unicode BIDI visual reordering
 * (PR #82 round 2 review, FOLD 3 — BLOCKER: a Trojan-Source-style bidi
 * override, e.g. U+202E, survives inside a code span and can reorder how
 * the rendered verdict text VISUALLY reads, under the bot's own
 * identity, even though the span stops it being interpreted as Markdown
 * structure) — closed by running the rationale through `spec-grounding-
 * runner-logic.mts`'s own {@link escapeInvisibleCharactersVisibly} FIRST,
 * the SAME categorical primitive the diff/criteria guards already use
 * (bidi controls are Unicode category `Cf`, already covered by that
 * function's own `UNTRUSTED_DATA_BREAKOUT_PATTERN`), rather than a
 * second, independently-maintained bidi enumeration that could drift
 * from it.
 *
 * @param rationale - The agent's own rationale text.
 * @returns The rationale wrapped in an inert code span, truncated with a
 *   pointer to the uploaded verdict artifact if it exceeds
 *   {@link MAX_RATIONALE_DISPLAY_LENGTH}. Truncation happens on a CODE
 *   POINT boundary (PR #82 round 2 review, FOLD 4 — LOW: a plain
 *   `.slice()` can split a surrogate pair in half, e.g. 299 ASCII
 *   characters then half of an emoji, leaving a lone unpaired surrogate
 *   that a downstream validator rejects or GitHub mangles).
 */
function sanitizeAgentRationaleForDisplay(rationale: string): string {
  const markedInvisibles = escapeInvisibleCharactersVisibly(rationale);
  const collapsed = markedInvisibles.replace(/[\r\n]+/g, " ").replace(/`/g, "");
  const codePoints = Array.from(collapsed);
  if (codePoints.length > MAX_RATIONALE_DISPLAY_LENGTH) {
    return (
      `\`${codePoints.slice(0, MAX_RATIONALE_DISPLAY_LENGTH).join("")}…\` ` +
      "_(truncated — full text in the uploaded verdict artifact)_"
    );
  }
  return `\`${collapsed}\``;
}

/**
 * Renders a joined result's rationale for display — agent-authored text is
 * DISPLAY-ONLY DATA here, never interpreted or executed as an instruction
 * (team-lead's explicit design note, 3b-iii kickoff), and is passed
 * through {@link sanitizeAgentRationaleForDisplay} before reaching a
 * posted bot comment (PR #82 review, FOLD 2/3). This function only
 * supplies the safe placeholder text — untouched by the sanitizer above,
 * since it is OUR OWN trusted text, not agent-authored — for the one case
 * that ISN'T agent-authored content at all: a criterion the agent never
 * addressed.
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
  return sanitizeAgentRationaleForDisplay(entry.rationale ?? "");
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
 * Whether `body` carries `marker` as a STRUCTURAL match — an exact,
 * standalone LINE of its own (after trimming ordinary surrounding
 * whitespace) — never a loose substring `.includes()` check (PR #82
 * round 4 review, Codex, FOLD 1 — BLOCKER: cross-feature idempotency
 * hijack). Every marker this module and `publish-spec-grounding-blocker-
 * logic.mts` build is ALWAYS appended as its own whole line (preceded by
 * a blank line, nothing else sharing it) — that is the invariant this
 * function checks for, not just "the string appears somewhere".
 *
 * Why this matters, concretely: `github-actions[bot]` posts MORE than
 * one kind of comment on this repo — `implement-patch-logic.mts`'s own
 * `buildGamingFlagAnnotation` (the anti-gaming classifier's flagged-line
 * annotation) renders attacker-influenced content (e.g. a flagged
 * suppression comment's own line text) through `sanitizeStepSummaryText`,
 * which PRESERVES the literal text inside its code span — including, if
 * an attacker crafts it deliberately, our own PUBLIC (non-secret,
 * predictable) marker string embedded mid-line inside otherwise-unrelated
 * content. A `.includes()` check alone would then match THAT comment —
 * same bot identity, marker substring present — and this job would PATCH
 * over it, erasing the anti-gaming warning it exists to preserve
 * (worst case exactly when its own label failed to apply, per that
 * function's own `labelApplied:false` branch). The holistic pass that
 * verified the bot-IDENTITY half of this defense (a different bot can't
 * forge `github-actions[bot]`) missed this: a DIFFERENT LEGITIMATE
 * feature's OWN comment, posted under the SAME real bot identity, can
 * still carry the marker as an incidental substring. Requiring the
 * marker to be an entire line by itself closes this — a marker embedded
 * mid-line (`- somepath.ts: <marker> more content`) never satisfies this
 * check, only a line that is EXACTLY the marker does.
 *
 * @param body - A comment's own body text.
 * @param marker - The exact marker string to look for as a standalone line.
 * @returns `true` only if some line of `body`, trimmed, equals `marker` exactly.
 */
export function bodyContainsMarkerAsStandaloneLine(body: string, marker: string): boolean {
  return body.split(/\r?\n/).some((line) => line.trim() === marker);
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
 * overwritten. ALSO matches structurally, via {@link
 * bodyContainsMarkerAsStandaloneLine} rather than a loose substring check
 * (PR #82 round 4 review, Codex, FOLD 1, BLOCKER — see that function's own
 * docstring for the cross-feature hijack this closes: bot identity alone
 * is not enough, since a DIFFERENT legitimate feature's own comment, under
 * the SAME real bot identity, can carry the marker as an incidental
 * substring).
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
      bodyContainsMarkerAsStandaloneLine(c.body, SPEC_GROUNDING_SUMMARY_COMMENT_MARKER),
  );
  return match ? match.id : null;
}

/**
 * Whether this run's own trusted `criteria-spine.json` reported either
 * kind of truncation — `truncated`/`diffTruncated`,
 * `spec-grounding-runner-logic.mts`'s {@link computeCriteriaSpineTruncation}
 * and `wrapUntrustedDiffBlock`'s own return value respectively (F1-S9
 * slice 1, issue #12). Passed straight through from the spine artifact —
 * this module never recomputes either flag itself, since both are already
 * trusted, runner-computed booleans by the time they reach here.
 */
export interface SpecGroundingTruncationFlags {
  /**
   * `criteria-spine.json`'s own `truncated` field — broader than
   * {@link UnreviewedClosingIssueResult} alone: also true when a
   * NON-closing reference's own criteria were byte-capped, when a linked
   * issue was never fetched at all due to the per-PR issue cap, or when
   * the spine ended up shorter than the total unmet-criteria count for
   * any other reason. An unreviewed CLOSING reference (fully or
   * partially) already escalates to a blocker on its own via {@link
   * UnreviewedClosingIssueResult}; this flag is the broader "the criteria
   * set itself may be incomplete" signal, covering cases that don't
   * individually escalate.
   */
  readonly truncated: boolean;
  /**
   * `criteria-spine.json`'s own `diffTruncated` field — the diff the
   * agent judged was itself byte-capped or exceeded GitHub's compare-API
   * file-count limit (Codex finding, PR #76 review, L733). A `satisfied:
   * true` verdict is only as trustworthy as the diff the agent actually
   * saw; this flag says that diff may have been incomplete.
   */
  readonly diffTruncated: boolean;
}

/**
 * Whether a truncated diff makes this run's closing claim(s) unverifiable
 * and must escalate to a BLOCKER, not just a caveat (PR #82 round 3
 * review, holistic pass, FOLD 3 — the holistic pass's own MEDIUM finding,
 * escalated by team-lead's adjudication): if `diffTruncated` is `true`,
 * the review agent judged every criterion against an INCOMPLETE diff, so
 * a `satisfied: true` verdict on a `closing`-kind criterion is itself
 * unverifiable — the agent may simply never have seen the part of the
 * diff that would have shown the criterion unmet. This is a WHOLE-RUN
 * signal, not tied to any one criterion, so it is computed once here and
 * consumed by both {@link buildSpecGroundingSummaryCommentBody} (counts
 * it in `totalBlockerCount`) and the privileged publisher's inline-
 * comment planner (`publish-spec-grounding-blocker-logic.mts`'s
 * `planBlockerInlineComments`, which the entrypoint must pass this same
 * computed value to — kept as ONE shared decision, not duplicated logic
 * in two modules that could drift apart).
 *
 * Deliberately checks `joined` for ANY `closing`-kind entry REGARDLESS OF
 * `satisfied` (not just `deriveSeverity(entry) === "blocker"`) — a
 * `satisfied: true` closing criterion is EXACTLY the case this escalation
 * exists to catch, since that is precisely the judgment a truncated diff
 * cannot be trusted to have gotten right. Also checks
 * `unreviewedClosingIssues` (already exclusively closing-kind by
 * construction) so a fully/partially-dropped closing issue still counts
 * as "this run has a closing reference," even though it produced no
 * `joined` entry at all.
 *
 * @param joined - Every spine criterion's joined result.
 * @param unreviewedClosingIssues - This run's unreviewed closing issues.
 * @param diffTruncated - `criteria-spine.json`'s own `diffTruncated` field.
 * @returns `true` only when the diff was truncated AND this run has at
 *   least one closing-kind reference of any kind (a spine criterion or an
 *   unreviewed issue) for that truncation to make unverifiable.
 */
export function isDiffTruncationUnverifiableForClosing(
  joined: readonly JoinedCriterionResult[],
  unreviewedClosingIssues: readonly UnreviewedClosingIssueResult[],
  diffTruncated: boolean,
): boolean {
  if (!diffTruncated) {
    return false;
  }
  return joined.some((entry) => entry.kind === "closing") || unreviewedClosingIssues.length > 0;
}

/**
 * Upper bound on the rendered non-blocking findings LIST's own total
 * length, in characters (PR #82 review, FOLD 3 — LOW: a fully schema-valid
 * verdict — up to `MAX_FINDINGS` (1000) findings, each up to
 * `MAX_RATIONALE_LENGTH` (2000) characters — could otherwise inflate this
 * list past GitHub's 65,536-character comment-body limit, turning a
 * genuinely valid verdict into a failed post; the concrete case that
 * surfaced this: ~34 non-blocking findings at the rationale cap alone
 * approach ~70,000 characters). Deliberately well under GitHub's own
 * limit — the caveat, blocker-count paragraph, heading, and trailer
 * sections are all roughly constant-size regardless of finding count, so
 * this only needs to bound the part that actually scales. Layered with
 * {@link MAX_RATIONALE_DISPLAY_LENGTH} (bounds each entry) rather than
 * relying on either alone: a valid verdict with many long rationales is
 * stopped by this budget even if no single entry trips its own cap.
 */
const MAX_FINDINGS_LIST_LENGTH = 55_000;

/**
 * Builds the single, non-blocking summary comment body.
 *
 * Lists every NON-blocking joined result ({@link deriveSeverity} !==
 * `"blocker"`) — a `non-closing` reference's unmet criteria, any satisfied
 * criterion regardless of kind, and any criterion the agent never
 * addressed that didn't escalate to a blocker — UP TO {@link
 * MAX_FINDINGS_LIST_LENGTH}; any remainder is reported as an omitted
 * count, with a pointer to the uploaded verdict artifact, never silently
 * dropped. Blocking findings — BOTH per-criterion ones and whole-issue
 * {@link UnreviewedClosingIssueResult} ones — are DELIBERATELY NOT
 * repeated here in full (only counted, with a pointer to the separate inline
 * comments) — the inline comment IS their canonical, resolvable home;
 * duplicating their content here would let a human "resolve" the issue by
 * treating the summary as sufficient while the actual blocking thread
 * stays open.
 *
 * A truncation caveat (F1-S9 slice 1, issue #12), when either
 * {@link SpecGroundingTruncationFlags} field is true, is rendered FIRST —
 * before the blocker/non-blocking sections — deliberately: a human
 * reading only the top of this comment before deciding to merge must see
 * "this review may be incomplete" before "no blocking findings", never
 * after. This is distinct from, and does not replace, the per-issue
 * {@link UnreviewedClosingIssueResult} blocker escalation above: an
 * unreviewed (fully or partially) CLOSING reference is serious enough to
 * block on its own; this caveat covers the broader, non-blocking-by-
 * default cases (a byte-capped NON-closing reference) that still deserve
 * a human's attention before merging.
 *
 * `diffTruncated` on its own is now ALSO a blocker, not merely a caveat,
 * whenever this run has any closing-kind reference at all (PR #82 round
 * 3 review, holistic pass, FOLD 3 — see {@link
 * isDiffTruncationUnverifiableForClosing}'s own docstring for the full
 * reasoning: a truncated diff makes a `satisfied: true` verdict on a
 * closing criterion itself unverifiable, not just the criteria SET
 * incomplete).
 *
 * The "where to find the blockers" wording is CONDITIONAL on
 * `blockersPostedInline` (PR #83 review, MEDIUM — a genuine bug spanning
 * both this module and `publish-spec-grounding-blocker-logic.mts`'s
 * anchor-fallback path, folded here since the fix is coherent only
 * across both): an EARLIER version unconditionally told the reader
 * blockers were "reported as separate, resolvable inline review
 * comment(s)... see those threads, not this summary" — true when
 * `planBlockerInlineComments` found a real anchor, but FALSE in its own
 * `anchorFallbackNeeded` case, where there is no inline thread at all
 * and the full blocker detail is instead appended to THIS summary via
 * `buildAnchorFallbackSummarySupplement`. Directing a human to
 * nonexistent inline threads while the real blocker detail sits in the
 * very summary they're told to skip is exactly the failure mode this
 * flag closes.
 *
 * @param joined - Every spine criterion's joined result.
 * @param unreviewedClosingIssues - `criteria-spine.json`'s own
 *   `unreviewedClosingIssues` field for this run — whole closing-kind
 *   issues not FULLY reviewed due to truncation (fully-dropped or
 *   partially-truncated), escalating the same way an unsatisfied
 *   criterion does (team-lead's disposition, Codex finding, PR #76
 *   review, L181, widened PR #82 round 2 review FOLD 1).
 * @param truncation - This run's own `truncated`/`diffTruncated` flags
 *   from `criteria-spine.json`, straight through, unmodified.
 * @param blockersPostedInline - Whether this run's blockers (if any)
 *   were actually posted as separate inline comments — the entrypoint
 *   passes `!planBlockerInlineComments(...).anchorFallbackNeeded`
 *   (`publish-spec-grounding-blocker-logic.mts`). Irrelevant when there
 *   are no blockers at all (the branch this governs is never reached),
 *   but always required rather than defaulted — this is exactly the
 *   kind of safety-relevant wording a silent default could get wrong
 *   unnoticed.
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildSpecGroundingSummaryCommentBody(
  joined: readonly JoinedCriterionResult[],
  unreviewedClosingIssues: readonly UnreviewedClosingIssueResult[],
  truncation: SpecGroundingTruncationFlags,
  blockersPostedInline: boolean,
): string {
  const criterionBlockers = joined.filter((e) => deriveSeverity(e) === "blocker");
  const nonBlocking = joined.filter((e) => deriveSeverity(e) !== "blocker");
  const diffTruncationBlocksClosingClaim = isDiffTruncationUnverifiableForClosing(
    joined,
    unreviewedClosingIssues,
    truncation.diffTruncated,
  );
  const totalBlockerCount =
    criterionBlockers.length + unreviewedClosingIssues.length + (diffTruncationBlocksClosingClaim ? 1 : 0);

  const lines: string[] = ["**Spec-grounded review summary**", ""];

  if (truncation.truncated || truncation.diffTruncated) {
    const causes: string[] = [];
    if (truncation.truncated) {
      causes.push("the linked issues' own acceptance criteria");
    }
    if (truncation.diffTruncated) {
      causes.push("this PR's own diff");
    }
    lines.push(
      `> ⚠️ **This review may be incomplete.** ${causes.join(" and ")} exceeded a resource cap ` +
        "during this run, so the reviewer may not have seen every criterion or every change. " +
        "Treat a clean result here with appropriate caution and consider a manual pass on the " +
        "parts a byte/file-count cap could have cut off.",
      "",
    );
  }

  if (totalBlockerCount > 0) {
    const blockerKindsExplanation =
      "A blocking finding is a criterion this PR's own closing keyword references that the " +
      "reviewer found unsatisfied, a whole linked issue this PR claims to close that was never " +
      "fully reviewed at all (truncated away, entirely or partially, by a resource cap), or — " +
      "when this run has any closing reference at all — this PR's own diff having been itself " +
      "truncated, which makes every criterion judged against it (including a 'satisfied' one) " +
      "unverifiable.";
    lines.push(
      blockersPostedInline
        ? `**${totalBlockerCount} blocking finding(s)** reported as separate, resolvable inline ` +
            "review comment(s) on this PR; see those threads, not this summary, to resolve them. " +
            `${blockerKindsExplanation} See the inline comment for which case applies and why.`
        : `**${totalBlockerCount} blocking finding(s)** listed below in THIS summary, not as ` +
            "separate inline comments — this PR's diff had no addable line to anchor them to (an " +
            "empty diff, or a diff that only deletes content), so there is no inline thread for " +
            `them. ${blockerKindsExplanation}`,
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
    let findingsListLength = 0;
    let addedCount = 0;
    for (const entry of nonBlocking) {
      const bullet =
        `- Issue #${entry.issueNumber}, criterion \`${entry.criterionId}\` (${entry.kind}): ` +
        `**${entry.satisfied ? "satisfied" : "unsatisfied"}** — ${formatRationaleForDisplay(entry)}`;
      if (findingsListLength + bullet.length + 1 > MAX_FINDINGS_LIST_LENGTH) {
        break; // Remaining entries are reported as an omitted count below, not silently dropped.
      }
      lines.push(bullet);
      findingsListLength += bullet.length + 1;
      addedCount += 1;
    }
    const omittedCount = nonBlocking.length - addedCount;
    if (omittedCount > 0) {
      lines.push(
        "",
        `_${omittedCount} further finding(s) omitted from this summary to stay within GitHub's ` +
          "comment size limit — see the uploaded criteria-spine and verdict artifacts for the " +
          "full list (an omitted finding the agent addressed has its own rationale in the " +
          "verdict artifact; an omitted finding the agent never addressed at all only appears " +
          "in the criteria-spine artifact, since there is no verdict entry for it to begin with)._",
      );
    }
    lines.push("");
  } else if (totalBlockerCount === 0) {
    lines.push(
      truncation.truncated || truncation.diffTruncated
        ? "_No unmet acceptance criteria were found among what WAS reviewed. This run was " +
            "truncated (see the caveat above), so unreviewed criteria may still exist — this is " +
            "NOT a confirmed all-clear._"
        : "_No unmet acceptance criteria were found at all._",
      "",
    );
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

// UnreviewedClosingIssueResult (a CLOSING-kind issue this PR referenced
// whose review is incomplete, fully or partially — see this module's
// re-export above) is now computed directly by `spec-grounding-runner-
// logic.mts`'s own `computeCriteriaSpineTruncation` and read straight
// from `criteria-spine.json`'s `unreviewedClosingIssues` field — no
// adapter needed here anymore (PR #82 round 2 review, FOLD 1: an earlier
// version of this module defined its OWN `DroppedClosingIssueResult`
// type, fully-dropped only, and a `buildDroppedClosingIssueResults`
// thin adapter from a bare `readonly number[]`; both are gone now that
// the runner produces the richer, already-typed result directly).
