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

import type { InlinePostingDegradeReason } from "./publish-spec-grounding-blocker-logic.mts";
import { parseLinkedIssueReferences, type IssueLinkKind } from "./spec-grounding-logic.mts";
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
/**
 * The categorical injection-neutralization core {@link
 * sanitizeAgentRationaleForDisplay}'s own docstring documents in full —
 * factored out (PR #84 review round 2, Codex, FOLD 1) so `criteria-
 * spine.json`'s validation-error reasons (`buildSpecGroundingFallbackCommentBody`'s
 * own `truncateReasonForDisplay`, below) get the IDENTICAL defense, not a
 * second, independently-maintained copy: those reasons can embed
 * AGENT/ISSUE-CONTROLLED content VERBATIM too (an unknown-key name from a
 * malformed verdict, or an invalid `kind`/`truncationKind` value quoted
 * via `JSON.stringify`), so they are exactly as untrusted as a rationale
 * once they reach a posted bot comment.
 *
 * Escapes invisible/bidi-override characters FIRST (`spec-grounding-
 * runner-logic.mts`'s own {@link escapeInvisibleCharactersVisibly}),
 * then strips the two characters that could break OUT of the code span
 * this function's own callers wrap the result in (a literal backtick, or
 * a newline that could end the containing list item/start a new
 * Markdown block) — never truncates itself; each caller applies its own
 * length budget on the CODE POINT boundary this returns intact.
 *
 * @param text - The untrusted text to neutralize.
 * @returns The neutralized text, NOT yet wrapped in a code span or
 *   truncated — the caller's own responsibility.
 */
function neutralizeUntrustedTextForBotComment(text: string): string {
  const markedInvisibles = escapeInvisibleCharactersVisibly(text);
  return markedInvisibles.replace(/[\r\n]+/g, " ").replace(/`/g, "");
}

function sanitizeAgentRationaleForDisplay(rationale: string): string {
  const collapsed = neutralizeUntrustedTextForBotComment(rationale);
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
 * The shared clause distinguishing where a reader can find more detail for
 * an ADDRESSED vs. an UNADDRESSED criterion (PR #83 review, FOLD 2):
 * `publish-spec-grounding-blocker-logic.mts`'s own criterion-blocker
 * overflow aggregate had the SAME mislabeling bug this module's own
 * omitted-findings note (below, in {@link buildSpecGroundingSummaryCommentBody})
 * already exists to avoid — pointing an UNADDRESSED entry (one with
 * `addressedByReviewer: false`, per {@link JoinedCriterionResult}'s own
 * docstring) at "the uploaded verdict artifact" is simply wrong, since
 * there is no verdict entry for it at all; only `criteria-spine.json` has
 * it. Exported and reused VERBATIM by both call sites — this module's own
 * summary comment, and the aggregate blocker comment in the sibling module
 * — so the two descriptions can never drift apart again the way they did
 * before this fold (the aggregate had its own, independently-worded and
 * incorrect, "See the uploaded verdict artifact for each one's own
 * rationale" line).
 *
 * @param subject - What the clause is describing, singular (e.g.
 *   `"finding"`, `"entry"`) — the caller supplies the noun that fits its
 *   own surrounding sentence.
 * @returns The clause text, lowercase, without a leading article or
 *   trailing punctuation, ready to drop into a surrounding sentence.
 */
export function describeAddressedVsUnaddressedArtifactPointer(subject: string): string {
  return (
    `an ${subject} the agent addressed has its own rationale in the uploaded verdict artifact; ` +
    `an ${subject} the agent never addressed at all only appears in the criteria-spine artifact, ` +
    "since there is no verdict entry for it to begin with"
  );
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
 * Every CLOSING-kind issue this PR's CURRENT body references that this
 * run's own review never knew about as closing at all (F1-S9 slice 90.5,
 * issue #12 — the re-landed, CORRECTED version of a fix reverted twice in
 * PR #87 rounds 8-9, tracked in issue #90): the body-edit sibling of
 * `publishSummary`'s trusted-head-SHA check. A body edit that ADDS a
 * brand-new `Closes #N` line, or upgrades an existing `Refs #N` to
 * `Closes #N`, changes NEITHER the PR's head SHA nor its diff, so the
 * head-SHA check alone cannot catch it — a run reviewed from before that
 * edit could otherwise publish (or keep gating on) a verdict for a closing
 * claim it never actually evaluated as closing.
 *
 * THE "KNOWN AS CLOSING" SET IS A UNION, DELIBERATELY — of TWO fields,
 * neither alone is correct (team-lead's confirmed design, this slice):
 *
 * - `reviewedClosingIssueNumbers` (F1-S9 slice 90.2) — every closing-kind
 *   reference within the runner's own fetch cap, REGARDLESS of whether it
 *   ended up with any spine entries at all. This is what closes rounds
 *   8-9's own real bug: a closing-kind issue with ZERO unmet criteria AT
 *   REVIEW TIME (already fully satisfied when the runner looked at it)
 *   gets no `CriteriaSpineEntry` and no `UnreviewedClosingIssueResult`
 *   either — `buildLinkedIssueSpecs` omits any issue with nothing unmet
 *   outright — so round 8's OWN "known" set (spine entries ∪
 *   unreviewedClosingIssues alone) could never see it, and reported it as
 *   an unreviewed-new closing reference on EVERY subsequent run, forever
 *   (PR #87 round 9's own revert rationale, cid 3621866011).
 * - `unreviewedClosingIssues` — a closing-kind reference BEYOND the
 *   runner's own fetch cap (`MAX_LINKED_ISSUES`) is, by construction, ALSO
 *   absent from `reviewedClosingIssueNumbers` (`selectIssuesToFetch`
 *   applies the identical cap to both) — correctly, since it was never
 *   actually looked at. But that same beyond-cap reference already
 *   produces its OWN live blocker via `spine.unreviewedClosingIssues`
 *   (the `"fully-dropped"`/"never even fetched" case). Using
 *   `reviewedClosingIssueNumbers` ALONE would make THIS function ALSO
 *   flag that same issue as "unreviewed new" — a double-flag that, on the
 *   blocker-bearing path, would divert an already-correctly-escalating
 *   case away from its own specific, resolvable blocker treatment into a
 *   generic top-level fallback instead. Unioning with
 *   `unreviewedClosingIssues` closes that regression: an issue already
 *   accounted for by EITHER signal is never "new".
 *
 * Called UNCONDITIONALLY by `publishSummary`, on EVERY `hasCriteria: true`
 * run — BOTH the zero-blocker and blocker-bearing paths (F1-S9 slice 90.5;
 * round 8's own version only ever guarded the zero-blocker path, since a
 * blocker-bearing run's OWN posting-path staleness filter was — at the
 * time — considered a sufficient, separate safeguard; team-lead's #90
 * kickoff spec widens this to run on both, since a NEW/upgraded closing
 * reference makes the ENTIRE run's verdict suspect for that issue, not
 * just its own already-joined criteria). Placed BEFORE the
 * `totalBlockerCount` branch in `publishSummary`, so a non-empty result
 * fails the WHOLE run closed before any posting or reconciliation is
 * attempted (F1-S9 slice 90.4's own reconcile-delete included) — a stale
 * verdict must never delete a prior run's still-valid gate.
 *
 * @param currentBody - The PR's CURRENT body text — already re-fetched and
 *   head-verified by the caller; this function does no fetching of its own.
 * @param thisRepo - This repo's own `owner/repo`, passed straight through
 *   to {@link parseLinkedIssueReferences} for its cross-repo-reference check.
 * @param reviewedClosingIssueNumbers - `criteria-spine.json`'s own
 *   `reviewedClosingIssueNumbers` field for this run (F1-S9 slice 90.2).
 * @param unreviewedClosingIssues - `criteria-spine.json`'s own
 *   `unreviewedClosingIssues` for this run.
 * @returns Every closing-kind issue number `currentBody` references that is
 *   absent from the union of `reviewedClosingIssueNumbers` and
 *   `unreviewedClosingIssues`, deduplicated and ascending by issue number,
 *   empty if none.
 */
export function findUnreviewedNewClosingReferences(
  currentBody: string,
  thisRepo: string,
  reviewedClosingIssueNumbers: readonly number[],
  unreviewedClosingIssues: readonly UnreviewedClosingIssueResult[],
): readonly number[] {
  const knownClosingIssueNumbers = new Set<number>([
    ...reviewedClosingIssueNumbers,
    ...unreviewedClosingIssues.map((issue) => issue.issueNumber),
  ]);
  const currentClosingIssueNumbers = new Set(
    parseLinkedIssueReferences(currentBody, thisRepo)
      .filter((reference) => reference.kind === "closing")
      .map((reference) => reference.issueNumber),
  );
  return [...currentClosingIssueNumbers]
    .filter((issueNumber) => !knownClosingIssueNumbers.has(issueNumber))
    .sort((a, b) => a - b);
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
 * @param degradeReason - WHY `blockersPostedInline` is `false` (PR #87
 *   review round 4, Codex, P1 — an earlier version always assumed the
 *   anchor-absent case; now distinguishes it from a real anchor GitHub
 *   itself rejected). `null` when `blockersPostedInline` is `true` (or
 *   there are no blockers at all) — the wording this governs is never
 *   reached in that case, but a `null` is still required rather than
 *   defaulted, matching `blockersPostedInline`'s own discipline.
 * @param staleBlockerIssueNumbers - The issue numbers `tryPostBlockersInline`
 *   skipped because the PR's CURRENT body no longer references them AT
 *   ALL — de-referenced entirely, as distinct from
 *   `downgradedClosingBlockerIssueNumbers` (PR #87 review round 4b, Codex,
 *   P1 — a follow-up wording fold, generalized F1-S9 slice 90.6a for the
 *   bucket-split: `totalBlockerCount` below is still the REVIEW-TIME
 *   count, including every skipped one, deliberately NOT filtered here —
 *   see issue #89 for the deeper "should the count/exit-code reflect only
 *   the still-referenced subset" design question, tracked ahead of the
 *   gate-enable decision #47. The HEADLINE's own "N of these were
 *   skipped" reconciliation below uses the UNION of this array and
 *   `downgradedClosingBlockerIssueNumbers` — see that param's own docs
 *   for why the union, not just this one bucket, is required there).
 * @param downgradedClosingBlockerIssueNumbers - The issue numbers
 *   `tryPostBlockersInline` skipped because the PR's CURRENT body still
 *   references them, but no longer with a closing keyword — DOWNGRADED,
 *   as distinct from `staleBlockerIssueNumbers` (F1-S9 slice 90.6a, the
 *   stale-vs-downgraded bucket-split). Combined with
 *   `staleBlockerIssueNumbers` via union for the headline's own "N of
 *   these were skipped" reconciliation (PR #98 review, Codex, cid
 *   3626878151, P2 — a real regression the bucket-split itself
 *   introduced: before the split, `staleBlockerIssueNumbers` was the
 *   LUMPED no-longer-closing set, and this headline reconciled against
 *   ALL of it; narrowing the array passed in to de-referenced-only
 *   without ALSO widening the headline's own reconciliation would have
 *   silently stopped subtracting downgraded blockers from the "posted
 *   inline" count — overstating gate state for a downgrade-only or mixed
 *   run, on the exact repo where an inline thread IS the merge gate).
 *   Kept SEPARATE from `staleBlockerIssueNumbers` as a parameter (rather
 *   than pre-unioned by the caller) so this function's own signature
 *   documents both buckets explicitly, matching how the two skip-notes
 *   themselves stay separate — only the headline's internal count needs
 *   the union, not the two buckets' own identities.
 * @param currentlyClosingIssueNumbers - This PR's CURRENT closing-kind
 *   references (PR #96 review round 2, Codex, cid 3626169268, BLOCKER —
 *   used ONLY to re-derive the diff-truncation blocker's own applicability
 *   against CURRENT state, NOT to filter `criterionBlockers`/
 *   `unreviewedClosingIssues` themselves, which stay REVIEW-TIME here —
 *   the deeper "should the whole count reflect only the still-referenced
 *   subset" question is issue #89's own separate rework, tracked for a
 *   later slice). Without this, a body edit that downgrades or removes
 *   EVERY closing reference this run's diff-truncation flag was
 *   protecting would leave `diffTruncationBlocksClosingClaim` PERMANENTLY
 *   `true` (computed from the review-time `joined`/`unreviewedClosingIssues`
 *   sets, which never change kind after the fact) — and since the
 *   resulting AGGREGATE blocker comment can never be auto-deleted by
 *   reconciliation (an aggregate's own decoded issue number is always
 *   `null`), this specific blocker could never be cleared by anything
 *   short of a human resolving the thread, only for the NEXT run to
 *   recompute the same permanently-true flag and re-post it forever.
 * @param postedInlineCount - Of the still-closing blockers, how many
 *   ALREADY exist as real, resolvable inline comments (F1-S9 slice 90.6a,
 *   PR #99 review, Codex, cid 3627145120, P2 — closing the contradiction
 *   #376 exposed: a mid-plan 422 leaves `blockersPostedInline` FALSE
 *   all-or-nothing, but some entries can have already posted/patched
 *   successfully BEFORE the entry that 422'd, and #376's own fix now
 *   correctly EXCLUDES those from the anchor-fallback rendering — so the
 *   old all-or-nothing headline wording, claiming every still-applicable
 *   blocker is "listed below, no inline thread," directly contradicted a
 *   fallback that (correctly) omits the ones that DO have a thread).
 *   Always `0` when `blockersPostedInline` is `true` (unused in that
 *   branch) or when nothing was ever attempted (`degradeReason ===
 *   "no-addable-anchor"`, where nothing could have posted before the
 *   degrade).
 * @param fallbackListedCount - Of the still-closing blockers, how many
 *   are actually rendered in the anchor-fallback supplement below (the
 *   SAME count the caller's own `fallbackCriterionBlockers.length +
 *   fallbackUnreviewedClosingIssues.length` yields) — passed explicitly
 *   rather than re-derived here from `totalBlockerCount` arithmetic,
 *   since `totalBlockerCount` and `skippedBlockerIssueNumbers` are
 *   counted at DIFFERENT granularities (blockers/criteria vs. unique
 *   issue numbers — one issue can have several unmet criteria that all
 *   skip together), so subtracting one from the other would not reliably
 *   yield this count.
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildSpecGroundingSummaryCommentBody(
  joined: readonly JoinedCriterionResult[],
  unreviewedClosingIssues: readonly UnreviewedClosingIssueResult[],
  truncation: SpecGroundingTruncationFlags,
  blockersPostedInline: boolean,
  degradeReason: InlinePostingDegradeReason | null,
  staleBlockerIssueNumbers: readonly number[],
  downgradedClosingBlockerIssueNumbers: readonly number[],
  currentlyClosingIssueNumbers: ReadonlySet<number>,
  postedInlineCount: number,
  fallbackListedCount: number,
): string {
  // The UNION of both buckets -- exactly what the single, pre-90.6a
  // `staleBlockerIssueNumbers` used to mean before the bucket-split (F1-S9
  // slice 90.6a, PR #98 review, Codex, cid 3626878151, P2 fold): the
  // headline's own "N of these were skipped" reconciliation must count
  // EVERY review-time blocker no longer posted inline, regardless of
  // WHICH bucket it fell into, or a downgrade-only (or mixed) run would
  // understate/overstate the skipped subset and misreport "posted inline"
  // gate state. De-duplicated via `Set` even though the two buckets are
  // disjoint by construction at their only current call site -- cheap
  // defense against a future caller passing overlapping arrays.
  const skippedBlockerIssueNumbers = [
    ...new Set([...staleBlockerIssueNumbers, ...downgradedClosingBlockerIssueNumbers]),
  ].sort((a, b) => a - b);
  const criterionBlockers = joined.filter((e) => deriveSeverity(e) === "blocker");
  const nonBlocking = joined.filter((e) => deriveSeverity(e) !== "blocker");
  // KIND-AWARE, against CURRENT state (PR #96 review round 2, Codex, cid
  // 3626169268, BLOCKER) -- deliberately narrower than filtering
  // `criterionBlockers`/`unreviewedClosingIssues` themselves (those stay
  // review-time, issue #89's own separate rework): ONLY the diff-truncation
  // blocker's own applicability is re-derived here, since it is the one
  // that can become a PERMANENT, un-clearable over-gate otherwise (see
  // this function's own `currentlyClosingIssueNumbers` param docs).
  const currentlyClosingJoined = joined.filter((e) => currentlyClosingIssueNumbers.has(e.issueNumber));
  const currentlyClosingUnreviewedClosingIssues = unreviewedClosingIssues.filter((e) =>
    currentlyClosingIssueNumbers.has(e.issueNumber),
  );
  const diffTruncationBlocksClosingClaim = isDiffTruncationUnverifiableForClosing(
    currentlyClosingJoined,
    currentlyClosingUnreviewedClosingIssues,
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
    const degradeExplanation =
      degradeReason === "anchor-rejected-422"
        ? "GitHub itself rejected the deterministic anchor this run selected (a 422 on the first " +
          "attempt)"
        : "this PR's diff had no addable line to anchor them to (an empty diff, or a diff that " +
          "only deletes content)";
    // PR #87 review round 4b, Codex, P1 -- a cheap, honest-wording fold:
    // when some (not all) blockers were skipped (de-referenced OR
    // downgraded -- F1-S9 slice 90.6a, PR #98 review, Codex, cid
    // 3626878151: reconciled against the UNION of both buckets, exactly
    // what the pre-90.6a lumped set meant, never just one bucket alone),
    // `totalBlockerCount` (deliberately still the REVIEW-TIME count, see
    // this function's own `staleBlockerIssueNumbers`/
    // `downgradedClosingBlockerIssueNumbers` param docs and issue #89)
    // must not be presented as if every one of them has its own inline
    // thread or summary listing below -- reword the headline to say the
    // count is review-time and explicitly reconcile it against the
    // posted/listed subset, pointing at the separate skip-note(s) for the
    // rest. Wording says "no longer CLOSING" (the honest common
    // denominator for BOTH buckets), not "no longer referenced" (true
    // only for the de-referenced bucket, false for the downgraded one,
    // which IS still referenced).
    const skippedReconciliation =
      skippedBlockerIssueNumbers.length > 0
        ? ` (${skippedBlockerIssueNumbers.length} of these are no longer CLOSING obligations this PR's ` +
          "current body makes — removed entirely, or downgraded to a non-closing reference — see the " +
          "note(s) below, not repeated here.)"
        : "";
    // PARTIALLY posted (F1-S9 slice 90.6a, PR #99 review, Codex, cid
    // 3627145120, P2 -- see `postedInlineCount`'s own param docs): a
    // mid-plan 422 can leave SOME still-closing blockers already posted
    // as real inline threads while the rest end up in the anchor-fallback
    // below -- the all-or-nothing `blockersPostedInline` boolean alone
    // cannot represent this split, so it gets its own wording rather than
    // folding into either the fully-posted or fully-fallback branches.
    const partiallyPostedInline = !blockersPostedInline && postedInlineCount > 0;
    lines.push(
      blockersPostedInline
        ? skippedBlockerIssueNumbers.length > 0
          ? `**${totalBlockerCount} blocking finding(s)** were identified at review time; those ` +
              "still applicable to this PR's current linked issues are reported as separate, " +
              `resolvable inline review comment(s) below — see those threads, not this summary, ` +
              `to resolve them.${skippedReconciliation} ${blockerKindsExplanation} See the inline ` +
              "comment for which case applies and why."
          : `**${totalBlockerCount} blocking finding(s)** reported as separate, resolvable inline ` +
              "review comment(s) on this PR; see those threads, not this summary, to resolve them. " +
              `${blockerKindsExplanation} See the inline comment for which case applies and why.`
        : partiallyPostedInline
          ? `**${totalBlockerCount} blocking finding(s)** were identified at review time; of those ` +
              "still applicable to this PR's current linked issues, " +
              `**${postedInlineCount}** already exist as separate, resolvable inline review ` +
              "comment(s) — see those threads, not this summary, to resolve them — and " +
              `**${fallbackListedCount}** are listed below in THIS summary instead, since ` +
              `${degradeExplanation} left them with no inline thread.${skippedReconciliation} ` +
              blockerKindsExplanation
          : skippedBlockerIssueNumbers.length > 0
            ? `**${totalBlockerCount} blocking finding(s)** were identified at review time; those ` +
                "still applicable are listed below in THIS summary, not as separate inline comments " +
                `— ${degradeExplanation}, so there is no inline thread for them.${skippedReconciliation} ` +
                blockerKindsExplanation
            : `**${totalBlockerCount} blocking finding(s)** listed below in THIS summary, not as ` +
                `separate inline comments — ${degradeExplanation}, so there is no inline thread for ` +
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
          `full list (${describeAddressedVsUnaddressedArtifactPointer("omitted finding")})._`,
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

/**
 * Upper bound on the COMBINED total of {@link buildStaleBlockerSkippedNote}'s
 * AND {@link buildDowngradedClosingBlockerSkippedNote}'s own displayed
 * issue-number lists, in characters (PR #87 review round 7, Codex,
 * BLOCKER; re-scoped from a PER-NOTE cap to a SHARED total, F1-S9 slice
 * 90.6a, PR #98 review, Codex, cid 3626932819, P2): `staleBlockerIssueNumbers`/
 * `downgradedClosingBlockerIssueNumbers` are both derived from
 * `criterionBlockers`/`unreviewedClosingIssues`, in turn influenced by the
 * PR's own (attacker-controlled) body — a body naming far more issues than
 * the runner's own fetch cap, or a body edit that removes/downgrades
 * references to many of them at once, could otherwise make either note's
 * own joined issue-number list grow unboundedly, pushing the WHOLE summary
 * comment past GitHub's 65,536-character limit and failing the only write
 * this run makes — the worst outcome, since these notes (like the fallback
 * and anchor-fallback ones) are a signal a human needs, never optional.
 * Capped the SAME way {@link MAX_REASONS_LIST_LENGTH} bounds the fallback
 * comment's own reasons list — a budget over the TOTAL joined string, any
 * remainder reported as an omitted count, never silently dropped. ONE
 * constant, ONE budget, SPLIT between the two notes by {@link
 * splitSkippedBlockerNoteBudget} rather than applied to EACH independently
 * — the bucket-split's own first version of this constant let two
 * independently-capped notes each reach the full budget, doubling the
 * combined bound the single pre-split note respected; this constant now
 * governs the SUM, never either note alone.
 */
const MAX_SKIPPED_BLOCKER_ISSUE_NUMBERS_LIST_LENGTH = 2_000;

/** {@link renderCappedIssueNumberList}'s own result — see that function's docstring. */
interface CappedIssueNumberListResult {
  readonly list: string;
  /** The ACTUAL rendered length of `list` (not the budget it was given) — what a caller threading a SHARED budget across multiple renders needs to decrement by. */
  readonly usedLength: number;
}

/**
 * Renders a deduplicated, ascending issue-number list as `#N, #M, ...`,
 * capped at the caller-supplied `maxLength` characters with any remainder
 * reported as an "(and N more)" omitted count rather than silently
 * dropped — the shared DoS-safe rendering primitive both {@link
 * buildStaleBlockerSkippedNote} and {@link
 * buildDowngradedClosingBlockerSkippedNote} build on (F1-S9 slice 90.6a),
 * so the availability guard is maintained in exactly one place.
 *
 * TAKES `maxLength` AS A PARAMETER, not the shared constant directly (PR
 * #98 review, Codex, cid 3626932819, P2 — the bucket-split's own 2nd
 * regression: with two INDEPENDENTLY-capped notes, each capable of using
 * the FULL {@link MAX_SKIPPED_BLOCKER_ISSUE_NUMBERS_LIST_LENGTH} budget,
 * their COMBINED length could reach 2x what the single pre-split note
 * ever could — enough, with other content in the assembled comment, to
 * push the WHOLE summary past GitHub's 65,536-character limit and fail
 * the only write this run makes, losing the actionable blocker details
 * to the generic failure fallback). Taking an explicit `maxLength` (and
 * returning `usedLength`) lets {@link splitSkippedBlockerNoteBudget}
 * allocate ONE shared budget across both notes' own list renders,
 * restoring the single-budget bound the pre-split note respected.
 *
 * @param issueNumbers - The (deduplicated, ascending) issue numbers to render.
 * @param maxLength - The character budget this render must not exceed.
 * @returns The capped, comma-joined issue-number list, and its own actual rendered length.
 */
function renderCappedIssueNumberList(issueNumbers: readonly number[], maxLength: number): CappedIssueNumberListResult {
  const issueTokens: string[] = [];
  let issueListLength = 0;
  let addedCount = 0;
  for (const issueNumber of issueNumbers) {
    const token = `#${issueNumber}`;
    if (issueListLength + token.length + 2 > maxLength) {
      break; // The remainder is reported as an omitted count below, not silently dropped.
    }
    issueTokens.push(token);
    issueListLength += token.length + 2; // ", " separator budget.
    addedCount += 1;
  }
  const omittedCount = issueNumbers.length - addedCount;
  const list = issueTokens.join(", ") + (omittedCount > 0 ? ` (and ${omittedCount} more)` : "");
  return { list, usedLength: list.length };
}

/**
 * Splits the SHARED {@link MAX_SKIPPED_BLOCKER_ISSUE_NUMBERS_LIST_LENGTH}
 * budget between the two skip notes' own issue-number-list renders (F1-S9
 * slice 90.6a, PR #98 review, Codex, cid 3626932819, P2 — see {@link
 * renderCappedIssueNumberList}'s own docstring for the regression this
 * closes). Allocates GREEDILY, in a fixed order: the de-referenced (stale)
 * list renders first against the FULL shared budget; whatever budget it
 * does NOT use is what the downgraded list gets — so the two lists'
 * COMBINED rendered length can never exceed the shared budget, restoring
 * exactly the bound the single pre-split note respected. No principled
 * reason favors one bucket over the other for priority (both get the
 * SAME reconciliation treatment); greedy-first-then-remainder is simply
 * the simplest deterministic split, easy to reason about and test.
 *
 * Called ONCE, by the caller building BOTH notes (`publish-spec-grounding-
 * verdict.mts`'s own `publishSummary`), so the two note-append calls each
 * pass the SAME, already-decided budgets rather than either one computing
 * its own independently — the ONLY way to guarantee the two renders never
 * exceed their shared total.
 *
 * TAKES ONLY the stale bucket, not both (a deliberate asymmetry, not an
 * oversight): under this greedy-first-then-remainder scheme, the
 * downgraded bucket's own ALLOCATED budget is simply "whatever the stale
 * bucket did not use" — a function of the stale bucket's rendered length
 * alone. The downgraded bucket's own SIZE never factors into deciding
 * that allocation (only into how much of it that allocation ends up
 * covering, which is {@link buildDowngradedClosingBlockerSkippedNote}'s
 * own concern when it actually renders against the budget it's given).
 *
 * @param staleBlockerIssueNumbers - The de-referenced-entirely bucket —
 *   the ONLY bucket this split decision needs to inspect.
 * @returns The character budget each note's own list render should use.
 */
export function splitSkippedBlockerNoteBudget(
  staleBlockerIssueNumbers: readonly number[],
): { readonly staleMaxListLength: number; readonly downgradedMaxListLength: number } {
  const staleUsedLength = renderCappedIssueNumberList(
    staleBlockerIssueNumbers,
    MAX_SKIPPED_BLOCKER_ISSUE_NUMBERS_LIST_LENGTH,
  ).usedLength;
  const downgradedMaxListLength = Math.max(0, MAX_SKIPPED_BLOCKER_ISSUE_NUMBERS_LIST_LENGTH - staleUsedLength);
  return { staleMaxListLength: MAX_SKIPPED_BLOCKER_ISSUE_NUMBERS_LIST_LENGTH, downgradedMaxListLength };
}

/**
 * Builds the note appended when one or more planned blocker findings were
 * skipped from inline posting because the PR's CURRENT body no longer
 * references their own issue AT ALL — de-referenced entirely (PR #87
 * review round 4, Codex, P1 — symmetric to the delete-path TOCTOU fold:
 * `tryPostBlockersInline` in `publish-spec-grounding-verdict.mts` re-checks
 * each planned blocker's own `issueNumber` against a fresh re-parse of the
 * PR's CURRENT body, not the runner-time one the verdict/spine were
 * computed against — a body-only edit never bumps the trusted head SHA, so
 * this run could otherwise post an inline comment reasserting an
 * obligation the PR no longer claims to have at all).
 *
 * NARROWED to the de-referenced-entirely case ONLY (F1-S9 slice 90.6a —
 * the stale-vs-downgraded bucket-split): before this slice, this note
 * covered BOTH "removed entirely" and "downgraded to a plain reference"
 * with one wording, deliberately not distinguished (PR #95 review round
 * 2). {@link buildDowngradedClosingBlockerSkippedNote} now covers the
 * downgrade case with its own accurate wording — see that function.
 *
 * DOES NOT UNCONDITIONALLY CLAIM REMOVAL (Codex finding, PR #95 review
 * round 2, P2 — a real overclaim in an earlier version): this same run's
 * own `deleteDeReferencedInlineBlockerComments`
 * (`publish-spec-grounding-inline-comment-io.mts`) deletes a PRIOR run's
 * own inline comment for one of these exact issues only when it can
 * positively confirm it is safe to (an INDIVIDUAL marker, a non-null
 * generation no newer than this run's own) — an AGGREGATE-marker comment
 * covering this issue alongside others, or one with a null/unparseable
 * generation, is deliberately left untouched by that same function. An
 * earlier version of this note claimed unconditionally that "any prior
 * inline comment ... has been REMOVED", which was false in exactly those
 * cases. The wording now says removal happened only where reconciliation
 * could actually confirm it was safe, and names the residual explicitly
 * rather than implying a clean state that may not exist. This note is the
 * ONLY place a human learns any of this, so it must never be silently
 * absent.
 *
 * @param staleBlockerIssueNumbers - The (deduplicated, ascending) issue
 *   numbers `tryPostBlockersInline` skipped, from `criterionBlockers` or
 *   `unreviewedClosingIssues` whose own issue is no longer referenced by
 *   the PR's current body AT ALL, of any kind.
 * @param maxListLength - This note's OWN share of the character budget for
 *   its issue-number list — see {@link splitSkippedBlockerNoteBudget},
 *   which the caller uses to compute this alongside {@link
 *   buildDowngradedClosingBlockerSkippedNote}'s own share, so the two
 *   notes' combined list length can never exceed the shared total
 *   (F1-S9 slice 90.6a, PR #98 review, Codex, cid 3626932819, P2).
 *   Required, not defaulted — the caller must always make this an
 *   explicit, deliberate choice rather than risk an un-audited default
 *   silently reintroducing an unbounded (or double-budgeted) list.
 * @returns The Markdown section to append, or `""` if nothing was
 *   skipped, ALWAYS within `maxListLength`
 *   regardless of how many issue numbers were skipped.
 */
export function buildStaleBlockerSkippedNote(staleBlockerIssueNumbers: readonly number[], maxListLength: number): string {
  if (staleBlockerIssueNumbers.length === 0) {
    return "";
  }
  const { list: issueList } = renderCappedIssueNumberList(staleBlockerIssueNumbers, maxListLength);
  return (
    `> ℹ️ **Blocking finding(s) for issue(s) ${issueList} were NOT posted inline.** This PR's own ` +
    "body no longer references them at all (removed since the spec-grounded review ran against " +
    "this PR's head), so those findings no longer reflect a live closing obligation this run could " +
    "verify. Any prior inline comment for them that this run's own reconciliation could positively " +
    "confirm was safe to remove has been deleted; a comment covering multiple issues together, or " +
    "one this run could not confirm predates it, may still be open and needs a human to resolve it " +
    "directly. A fresh spec-grounded review run will re-evaluate against the PR's current state."
  );
}

/**
 * Builds the note appended when one or more planned blocker findings were
 * skipped from inline posting because the PR's CURRENT body still
 * references their own issue, but no longer with a closing keyword —
 * DOWNGRADED (a `Closes #N` edited to a plain `Refs #N`), as distinct from
 * {@link buildStaleBlockerSkippedNote}'s de-referenced-entirely case
 * (F1-S9 slice 90.6a — the stale-vs-downgraded bucket-split; see that
 * function's own docstring for why the two were originally one note and
 * why they were split).
 *
 * Shares {@link buildStaleBlockerSkippedNote}'s own "does not
 * unconditionally claim removal" caveat identically: this same run's own
 * `deleteDeReferencedInlineBlockerComments` only deletes an INDIVIDUAL,
 * generation-confirmed prior inline comment for one of these issues — an
 * aggregate-marker comment covering this issue alongside others, or one
 * with an unparseable generation, is left untouched, and this note is the
 * only place a human learns that residual exists.
 *
 * @param downgradedClosingBlockerIssueNumbers - The (deduplicated,
 *   ascending) issue numbers `tryPostBlockersInline` skipped, still
 *   referenced by the PR's current body but no longer with a closing
 *   keyword.
 * @param maxListLength - This note's OWN share of the character budget for
 *   its issue-number list — see {@link buildStaleBlockerSkippedNote}'s
 *   own identical param docs and {@link splitSkippedBlockerNoteBudget}.
 * @returns The Markdown section to append, or `""` if nothing was
 *   skipped, ALWAYS within `maxListLength`
 *   regardless of how many issue numbers were skipped.
 */
export function buildDowngradedClosingBlockerSkippedNote(
  downgradedClosingBlockerIssueNumbers: readonly number[],
  maxListLength: number,
): string {
  if (downgradedClosingBlockerIssueNumbers.length === 0) {
    return "";
  }
  const { list: issueList } = renderCappedIssueNumberList(downgradedClosingBlockerIssueNumbers, maxListLength);
  return (
    `> ℹ️ **Blocking finding(s) for issue(s) ${issueList} were NOT posted inline.** This PR's own ` +
    "body still references them, but no longer with a closing keyword (downgraded from a `Closes " +
    "#N`-style reference to a plain one, like `Refs #N`, since the spec-grounded review ran against " +
    "this PR's head), so those findings no longer reflect a live closing obligation this run could " +
    "verify. Any prior inline comment for them that this run's own reconciliation could positively " +
    "confirm was safe to remove has been deleted; a comment covering multiple issues together, or " +
    "one this run could not confirm predates it, may still be open and needs a human to resolve it " +
    "directly. A fresh spec-grounded review run will re-evaluate against the PR's current state."
  );
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

/**
 * Upper bound on ONE reason string's own displayed length, in CODE POINTS
 * (PR #84 review, Codex, FOLD 2 — same code-point-boundary-safe
 * truncation discipline {@link MAX_RATIONALE_DISPLAY_LENGTH}'s own
 * docstring documents, applied here instead to a validation-error
 * reason). A malformed `criteria-spine.json`'s own invalid `kind` or
 * `truncationKind` value is echoed VERBATIM (via `JSON.stringify`) into
 * the validation error text — and the artifact itself can be up to
 * {@link import("./spec-grounding-runner-logic.mts").MAX_CRITERIA_SPINE_ARTIFACT_BYTES}
 * (4MB), so a single reason could otherwise be enormous.
 */
const MAX_REASON_DISPLAY_LENGTH = 500;

/**
 * Upper bound on the fallback comment's own reasons LIST length, in
 * characters, after each reason is already capped by {@link
 * MAX_REASON_DISPLAY_LENGTH} (PR #84 review, Codex, FOLD 2, MEDIUM —
 * layered the same way {@link MAX_FINDINGS_LIST_LENGTH} layers with
 * {@link MAX_RATIONALE_DISPLAY_LENGTH} for the summary comment: a
 * malformed spine can produce ONE error per element, and even after each
 * is individually capped, thousands of them together could still push
 * this comment past GitHub's 65,536-character limit — which would make
 * the FALLBACK comment itself fail to post, the worst outcome this
 * function exists to prevent: no gating signal would reach the human
 * reviewer for this run at all). Deliberately well under GitHub's own
 * limit, matching `MAX_FINDINGS_LIST_LENGTH`'s own precedent and value.
 */
const MAX_REASONS_LIST_LENGTH = 50_000;

/**
 * Neutralizes AND truncates one reason string for display in the
 * fallback comment (PR #84 review round 2, Codex, FOLD 1 — a REAL
 * injection, not just a size concern: `parseAndValidateVerdict`'s own
 * errors embed agent-controlled content verbatim — an unknown-key name
 * like `\n<!--`, or an invalid field value — and `parseCriteriaSpineArtifact`'s
 * own errors can similarly quote a corrupted field's value; both reach
 * this function as plain `reasons` strings with no upstream sanitization
 * at all, since neither validator's job is comment-rendering safety).
 * Runs {@link neutralizeUntrustedTextForBotComment} (the SAME
 * categorical defense {@link sanitizeAgentRationaleForDisplay} uses —
 * never a second, independently-maintained copy) FIRST, then truncates
 * to {@link MAX_REASON_DISPLAY_LENGTH} code points (never a UTF-16-unit
 * `.slice()`, which can split a surrogate pair in half), then wraps the
 * result in an inert Markdown code span — the categorical defense
 * against Markdown-structure injection, not per-metacharacter escaping.
 *
 * @param reason - The raw reason string.
 * @returns The reason, neutralized and wrapped in a code span, truncated
 *   with a trailing ellipsis (still inside the span) if it exceeds
 *   {@link MAX_REASON_DISPLAY_LENGTH}.
 */
function sanitizeReasonForDisplay(reason: string): string {
  const collapsed = neutralizeUntrustedTextForBotComment(reason);
  const codePoints = Array.from(collapsed);
  if (codePoints.length > MAX_REASON_DISPLAY_LENGTH) {
    return `\`${codePoints.slice(0, MAX_REASON_DISPLAY_LENGTH).join("")}…\``;
  }
  return `\`${collapsed}\``;
}

/**
 * Builds the comment body posted when the privileged publish entrypoint
 * (`publish-spec-grounding-verdict.mts`, slice 3b-iii-d, issue #12) could
 * not produce a real summary at all — the review pipeline's own job
 * result was not `"success"`, or a required artifact (`outcome.json`, the
 * verdict, or `criteria-spine.json`) was absent or failed validation.
 * Mirrors `apply-triage-verdict-logic.mts`'s own `buildFallbackCommentBody`
 * precedent: same "explain what's wrong, list every reason" shape, same
 * principle that a broken pipeline must be VISIBLE to a human, never
 * silently absent.
 *
 * Bounds the reasons list in TWO layers (PR #84 review, Codex, FOLD 2 —
 * see {@link MAX_REASON_DISPLAY_LENGTH} and {@link
 * MAX_REASONS_LIST_LENGTH}'s own docstrings): a malformed artifact's own
 * validation errors are UNTRUSTED-SIZED text (they can echo raw field
 * values from an artifact up to several MB), so without a cap here, the
 * one comment this function exists to GUARANTEE always posts could
 * itself exceed GitHub's comment-size limit and fail to post — the worst
 * outcome, since this is the LAST-RESORT signal a human has for a broken
 * run. Any reason beyond the length budget is reported as an omitted
 * count, never silently dropped.
 *
 * Ends with the SAME {@link SPEC_GROUNDING_SUMMARY_COMMENT_MARKER} a
 * normal run's summary uses — deliberately, not a distinct marker: a
 * later, SUCCESSFUL rerun's real summary then finds and PATCHes this
 * exact fallback comment in place (via {@link
 * findExistingSpecGroundingSummaryCommentId}) rather than leaving a
 * stale "pipeline broken" comment sitting alongside a new, valid one
 * forever.
 *
 * @param reasons - One or more human-readable explanations for why this
 *   run could not produce a real summary.
 * @returns The Markdown comment body, ending with the tracking marker,
 *   ALWAYS within GitHub's comment-size limit regardless of `reasons`'
 *   own size.
 */
export function buildSpecGroundingFallbackCommentBody(reasons: readonly string[]): string {
  const reasonLines: string[] = [];
  let reasonsListLength = 0;
  let addedCount = 0;
  for (const reason of reasons) {
    const bullet = `- ${sanitizeReasonForDisplay(reason)}`;
    if (reasonsListLength + bullet.length + 1 > MAX_REASONS_LIST_LENGTH) {
      break; // Remaining reasons are reported as an omitted count below, not silently dropped.
    }
    reasonLines.push(bullet);
    reasonsListLength += bullet.length + 1;
    addedCount += 1;
  }
  const omittedCount = reasons.length - addedCount;
  if (omittedCount > 0) {
    reasonLines.push(`- _(${omittedCount} further reason(s) omitted to stay within GitHub's comment size limit.)_`);
  }

  const lines: string[] = [
    "**Spec-grounded review could not run to completion.** Treat this PR as " +
      "NOT yet reviewed against its linked issues' acceptance criteria — a human should check it " +
      "manually before relying on a clean spec-grounded result.",
    "",
    "Reason(s):",
    ...reasonLines,
    "",
    "_Posted by the roastpilot-cloud spec-grounded review workflow (factory.md §13 point 3)._",
    "",
    SPEC_GROUNDING_SUMMARY_COMMENT_MARKER,
  ];
  return lines.join("\n");
}

/**
 * Distinguishes WHY `spec-grounding-runner.mts` emitted `hasCriteria:
 * false` (PR #87 review, Codex, P1/medium fold — the runner's own two
 * DIFFERENT false-emitting branches carry materially different trust,
 * and conflating them was an anti-gaming hole):
 *
 * - `"no-references"` — the PR carries no closing-keyword reference to
 *   any issue at all. There was never any obligation, so a prior run's
 *   summary/fallback comment AND its inline blocker threads are both
 *   genuinely stale and safe to clear/delete.
 * - `"no-unmet-criteria"` — the PR DOES reference an issue, but every
 *   acceptance criterion in it happens to be checked off (or every
 *   linked issue 404'd). This is SELF-ATTESTED, never diff-verified —
 *   whoever edited the linked issue's own checklist could have done so
 *   without the PR's diff actually satisfying anything. Deleting a
 *   `required_conversation_resolution`-gating inline blocker thread on
 *   this signal alone would be an anti-gaming hole: a closing claim
 *   still exists, so the obligation to verify it does too.
 */
export type NoCriteriaReason = "no-references" | "no-unmet-criteria";

/**
 * Every case {@link buildSpecGroundingClearedSummaryCommentBody} can
 * explain — {@link NoCriteriaReason} (what `outcome.json` itself
 * reports) plus one PUBLISHER-INTERNAL case that never comes from the
 * artifact at all: `"race-detected-before-delete"` (PR #87 review round
 * 3, Codex, P1, gate-integrity TOCTOU) — the `"no-references"` branch's
 * own pre-delete revalidation found the PR's state has changed (head
 * moved, or a new closing reference now exists) since the read-only
 * runner produced this `outcome.json`, so the caller degrades to the
 * SAME non-destructive treatment `"no-unmet-criteria"` gets, but the
 * message must say WHY accurately — never implying inline threads were
 * cleared when a race, not a genuine self-attested-criteria case, is
 * why they were not.
 */
export type ClearedSummaryReason = NoCriteriaReason | "race-detected-before-delete";

/**
 * Builds the comment body the privileged publish entrypoint upserts when
 * a PR that previously had a spec-grounded summary or fallback comment no
 * longer has any UNMET linked-issue criteria to review (`hasCriteria:
 * false` on a run whose prior comment exists) — a P2 finding (PR #86
 * review, Codex): without this, editing a PR's body to remove its last
 * closing-keyword reference (or checking off every acceptance box) left
 * the EARLIER run's comment (still claiming blockers, or a failed
 * pipeline) visible and unexplained forever, since the entrypoint's own
 * `hasCriteria: false` path was a pure silent no-op with no upsert at
 * all.
 *
 * The message differs by {@link ClearedSummaryReason} (PR #87 review,
 * Codex, P1/medium fold + round 3's own TOCTOU fold): `"no-references"`
 * states plainly that nothing applies any more (matches the caller ALSO
 * deleting inline blocker threads); `"no-unmet-criteria"` (or any reason
 * the caller could not positively confirm as `"no-references"`)
 * explicitly tells a human the criteria are self-attested, not
 * diff-verified; `"race-detected-before-delete"` explicitly tells a
 * human the PR's state changed (head moved, or a new closing reference
 * appeared) since the review ran, so this run degraded rather than
 * deleting a thread it could not re-verify. The LAST TWO cases both
 * explicitly say any remaining inline blocker thread was deliberately
 * LEFT IN PLACE for a human (or a fresh run) — never implying inline
 * threads were cleared when they were not.
 *
 * Ends with the SAME {@link SPEC_GROUNDING_SUMMARY_COMMENT_MARKER} every
 * other summary/fallback body uses, for the identical reason {@link
 * buildSpecGroundingFallbackCommentBody} documents: a LATER run that
 * finds criteria again must PATCH this exact comment in place, not post
 * a second one alongside it.
 *
 * @param reason - Why this run is clearing/updating this comment.
 * @returns The Markdown comment body, ending with the tracking marker.
 */
export function buildSpecGroundingClearedSummaryCommentBody(reason: ClearedSummaryReason): string {
  const explanation =
    reason === "no-references"
      ? "An earlier run of the spec-grounded review posted a summary or fallback comment here, but " +
        "this PR no longer references any issue this workflow can spec-ground against — the comment " +
        "below (and any inline blocker threads from that earlier run) no longer apply and have been " +
        "cleared."
      : reason === "no-unmet-criteria"
        ? "An earlier run of the spec-grounded review posted a summary or fallback comment here. This " +
          "PR's linked issue(s) now show every acceptance criterion marked complete — but that is " +
          "SELF-ATTESTED (checked off in the issue), not verified against this PR's own diff, so any " +
          "inline blocker thread from that earlier run has been deliberately LEFT IN PLACE, not " +
          "cleared: please verify the linked issue's own criteria genuinely hold and resolve any " +
          "remaining blocker thread yourself."
        : "An earlier run of the spec-grounded review posted a summary or fallback comment here. " +
          "Since then, this PR's own state changed (its head moved, or its body now shows a new " +
          "closing-issue reference) in a way this run could not safely re-verify against the earlier " +
          "review, so any inline blocker thread from that earlier run has been deliberately LEFT IN " +
          "PLACE, not cleared: a fresh spec-grounded review run will re-evaluate them against this " +
          "PR's current state.";
  return [
    `**This PR's linked-issue acceptance criteria are no longer being actively spec-ground.** ${explanation}`,
    "",
    "_Posted by the roastpilot-cloud spec-grounded review workflow (factory.md §13 point 3)._",
    "",
    SPEC_GROUNDING_SUMMARY_COMMENT_MARKER,
  ].join("\n");
}
