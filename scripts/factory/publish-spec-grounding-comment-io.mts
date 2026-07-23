/**
 * GitHub comment I/O for the privileged spec-grounded review publisher
 * (F1-S9 slice 3b-iii-d, issue #12) — split out from
 * `publish-spec-grounding-verdict.mts` (the CLI entrypoint) to keep that
 * file under the 400-logic-line cap (AGENTS.md PR hygiene), the same
 * "the network-wiring machinery gets its own reviewable file" split this
 * story has already applied to PURE logic (`publish-spec-grounding-
 * blocker-logic.mts` split out of `publish-spec-grounding-verdict-logic
 * .mts` for the identical reason, per team-lead's own scope split at
 * 3b-iii kickoff). Unlike that split, this one is NOT pure — every
 * function here calls the network — but it is still a self-contained,
 * independently reviewable unit: "find/upsert this run's own summary
 * comment on a PR", nothing else.
 *
 * Mirrors `apply-triage-verdict.mts`'s own `findExistingTriageComment`/
 * `upsertComment` precedent exactly, against the PR's own issue-comments
 * endpoint (`/repos/{owner}/{repo}/issues/{prNumber}/comments`) — a PR's
 * "Conversation" tab comments live at the same endpoint a plain issue's
 * do, confirmed sufficient under this job's `pull-requests: write` alone
 * (no `issues: write` needed, per the #12 3b-iii-d+e PR-plan sign-off).
 */

import { githubRequest } from "./github-api.mts";
import {
  buildSpecGroundingClearedSummaryCommentBody,
  buildSpecGroundingFallbackCommentBody,
  findExistingSpecGroundingSummaryCommentId,
  type ClearedSummaryReason,
  type ExistingComment,
} from "./publish-spec-grounding-verdict-logic.mts";
import { escapeInvisibleCharactersVisibly } from "./spec-grounding-runner-logic.mts";

interface GitHubComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}

const COMMENT_PAGE_SIZE = 100;
/** Same rationale and value as `apply-triage-verdict.mts`'s own identical constant. */
const MAX_COMMENT_PAGES = 50;

/**
 * Finds this job's own prior summary comment, if any, paginating through
 * every page — mirrors `apply-triage-verdict.mts`'s own
 * `findExistingTriageComment` exactly.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @returns The existing comment's id, or `null` if none found.
 */
export async function findExistingSummaryComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await githubRequest<GitHubComment[]>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
    );
    const existing: ExistingComment[] = comments.map((c) => ({
      id: c.id,
      body: c.body,
      authorType: c.user?.type ?? null,
      authorLogin: c.user?.login ?? null,
    }));
    const found = findExistingSpecGroundingSummaryCommentId(existing);
    if (found !== null) {
      return found;
    }
    if (comments.length < COMMENT_PAGE_SIZE) {
      return null;
    }
  }
  console.warn(
    `Scanned ${MAX_COMMENT_PAGES} pages of comments on PR #${prNumber} without finding a prior ` +
      `spec-grounded review summary; posting a new one rather than risking missing a marker beyond ` +
      `this page limit.`,
  );
  return null;
}

/**
 * Upserts this run's own summary comment — PATCHes the prior run's
 * comment (found via {@link findExistingSummaryComment}) if one exists,
 * otherwise POSTs a new one.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param body - The comment body to post or PATCH in place.
 * @param options - `preWriteCheck`, if given, runs AFTER {@link
 *   findExistingSummaryComment}'s own pagination (up to
 *   `MAX_COMMENT_PAGES` sequential GETs) completes and IMMEDIATELY BEFORE
 *   the actual PATCH/POST write — narrowing a caller's own TOCTOU window
 *   to the single write call itself, the irreducible floor (F1-S9 slice
 *   90.5b, PR #97 draft round 5, Codex, cid 3626686028, P1 BLOCKER — a
 *   residual of cid 3626639088's own fix: re-verifying immediately before
 *   THIS function was called still left the whole multi-page lookup
 *   above between that re-verify and the write). Throwing from
 *   `preWriteCheck` aborts the write entirely — this function does not
 *   catch it, so it propagates to the caller, matching every other
 *   fail-closed convention in this codebase (the caller converts it into
 *   a visible fallback). Only the summary-publish caller
 *   (`publish-spec-grounding-verdict.mts`'s own `publishSummary`) passes
 *   this; `publishFallback`/`clearStaleSpecGroundingSummary` do not need
 *   it — neither publishes a "current state" verdict a body edit could
 *   invalidate.
 */
export async function upsertSummaryComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  options?: { readonly preWriteCheck?: () => Promise<void> },
): Promise<void> {
  const existingId = await findExistingSummaryComment(token, owner, repo, prNumber);
  await options?.preWriteCheck?.();
  if (existingId !== null) {
    await githubRequest(token, "PATCH", `/repos/${owner}/${repo}/issues/comments/${existingId}`, { body });
  } else {
    await githubRequest(token, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { body });
  }
}

/**
 * Round-2 fold (PR #85 review, Codex, MEDIUM — the "no bidi/invisible
 * concern for a plain-text log" scoping in this function's first version
 * was itself the miss): a workflow log line is RENDERED, in a terminal or
 * the GitHub Actions log viewer, so it carries the same visual-spoofing
 * risk as a posted comment, PLUS the log-specific workflow-command risk
 * below. An ANSI escape sequence (`\x1b`, a `\p{Cc}` control character)
 * can manipulate cursor position or color in a terminal viewer; a bidi
 * override can visually reorder or hide part of the logged text; and an
 * unbounded value (e.g. a multi-megabyte artifact field echoed into a
 * validation-error reason) can emit a multi-megabyte log line. None of
 * that is covered by newline-collapse alone.
 *
 * @see MAX_LOGGED_REASON_LENGTH
 */
const MAX_LOGGED_REASON_LENGTH = 2000;

/**
 * Neutralizes a reason (or any other untrusted-derived string) before it
 * reaches a WORKFLOW LOG line (`console.error`/`console.log`) — a
 * DIFFERENT untrusted-output channel than the posted bot comment (PR #85
 * review, Codex, MEDIUM): GitHub Actions parses `::command::` lines
 * anywhere in a step's own stdout, so a malformed verdict's own
 * unknown-key name or invalid field value — echoed VERBATIM into a
 * validation-error reason, the SAME untrusted content `publish-spec-
 * grounding-verdict-logic.mts`'s own `sanitizeReasonForDisplay` already
 * neutralizes for the posted comment — reaching a raw `console.error`
 * call could inject a workflow command on its own line: `"\n::error
 * title=spoofed::message"` (or, on older runners, `"\n::set-env::"` /
 * `"\n::add-mask::"`) spoofs an annotation at minimum. The comment's own
 * neutralization does NOT cover this: the log is a separate channel
 * entirely.
 *
 * Three layered defenses, in order:
 *  1. {@link escapeInvisibleCharactersVisibly} — the SAME comment-grade
 *     primitive `neutralizeUntrustedTextForBotComment` uses, rendering
 *     every control/format character (`\p{C}`, including ANSI escapes and
 *     bidi overrides) as a visible `[U+XXXX]` marker (round-2 fold: a log
 *     line is rendered too, so this channel needs the full comment-grade
 *     treatment, not a narrower one). Leaves the four ordinary ASCII
 *     whitespace characters — space, tab, LF, CR — untouched.
 *  2. Newline-collapse (`\r`/`\n` -> space) — the LOAD-BEARING defense
 *     against workflow-command injection specifically: a workflow command
 *     must START a line, so a value with no newline in it can never
 *     inject one regardless of what text follows. Runs AFTER step 1 since
 *     that step deliberately leaves real newlines as literal newlines.
 *  3. Strips the literal `::` marker as defense-in-depth, in case some
 *     other log consumer ever parses it without requiring a true line
 *     start.
 *
 * Finally bounds the result to {@link MAX_LOGGED_REASON_LENGTH} CODE
 * POINTS (never a UTF-16-unit `slice`, so an astral character at the
 * boundary can't be split into a lone surrogate — same technique
 * `sanitizeReasonForDisplay` already uses for the comment path).
 *
 * EXPORTED (PR #85 review follow-up, ahead of slice 3b-iii-d3's own
 * proactive fold — team-lead's disposition on the same finding
 * generalized to the entrypoint's own top-level catch-all): `publish-
 * spec-grounding-verdict.mts`'s own `main().catch(...)` handler stringifies
 * whatever error reaches it (which can transitively carry untrusted text
 * — a `GithubApiError` echoing a response body, or a wrapped validation
 * error) into the SAME log channel this function protects. Reused there
 * rather than a second, independently-maintained copy.
 *
 * @param value - The untrusted (or untrusted-derived) string.
 * @returns The value, safe to interpolate into a `console.error`/log call.
 */
export function neutralizeReasonForLog(value: string): string {
  const visible = escapeInvisibleCharactersVisibly(value);
  const collapsed = visible.replace(/[\r\n]+/g, " ").replace(/::/g, " ");
  const codePoints = Array.from(collapsed);
  if (codePoints.length > MAX_LOGGED_REASON_LENGTH) {
    return `${codePoints.slice(0, MAX_LOGGED_REASON_LENGTH).join("")}…(truncated)`;
  }
  return collapsed;
}

/**
 * Upper bound on the fallback log entry's own reasons LIST length, in
 * characters, after each reason is already capped by {@link
 * MAX_LOGGED_REASON_LENGTH} (PR #85 review round 3, Codex, MEDIUM — the
 * PER-reason cap alone still leaves the TOTAL unbounded: a malformed
 * artifact can carry up to `MAX_CRITERIA_SPINE_ENTRIES` findings, several
 * reasons each, all mapped into one `console.error` call, so thousands of
 * individually-capped reasons could still add up to a multi-megabyte log
 * entry). Layered the same two-tier way {@link
 * buildSpecGroundingFallbackCommentBody}'s own `MAX_REASONS_LIST_LENGTH`
 * layers with its per-reason cap — a separate constant here rather than
 * reusing that one, since a log entry's readability budget is a distinct
 * concern from a GitHub comment's hard size limit.
 */
const MAX_LOGGED_REASONS_LIST_LENGTH = 20_000;

/**
 * Logs the (neutralized, bounded) fallback reasons for CI-run visibility
 * — split out of {@link publishFallback} so it can run BEFORE the
 * comment write is attempted (PR #85 review round 3, Codex, MEDIUM: the
 * diagnostic must survive a write failure). Bounds the reasons in two
 * layers, mirroring {@link buildSpecGroundingFallbackCommentBody}'s own
 * pattern: each reason via {@link neutralizeReasonForLog} ({@link
 * MAX_LOGGED_REASON_LENGTH}), then the joined list as a whole via {@link
 * MAX_LOGGED_REASONS_LIST_LENGTH}, reporting any remainder as an omitted
 * count rather than silently dropping it or letting the log entry grow
 * unbounded.
 *
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param reasons - One or more human-readable explanations.
 */
function logFallbackReasons(prNumber: number, reasons: readonly string[]): void {
  const reasonLines: string[] = [];
  let reasonsListLength = 0;
  let addedCount = 0;
  for (const reason of reasons) {
    const bullet = `  - ${neutralizeReasonForLog(reason)}`;
    if (reasonsListLength + bullet.length + 1 > MAX_LOGGED_REASONS_LIST_LENGTH) {
      break; // Remaining reasons are reported as an omitted count below, not silently dropped.
    }
    reasonLines.push(bullet);
    reasonsListLength += bullet.length + 1;
    addedCount += 1;
  }
  const omittedCount = reasons.length - addedCount;
  if (omittedCount > 0) {
    reasonLines.push(`  - (${omittedCount} further reason(s) omitted to keep this log entry bounded.)`);
  }
  console.error(`Spec-grounded review publish failed for PR #${prNumber}. Reasons:\n` + reasonLines.join("\n"));
}

/**
 * Publishes the fallback comment (see {@link buildSpecGroundingFallbackCommentBody})
 * for a run that could not produce a real summary, and logs the reasons
 * for CI-run visibility.
 *
 * Logs the reasons {@link logFallbackReasons} FIRST, THEN attempts the
 * comment write (PR #85 review round 3, Codex, MEDIUM — reversed from an
 * earlier version that awaited the write first: if `upsertSummaryComment`
 * itself throws (a transient API error, or a permissions regression), the
 * original validation/artifact diagnostic must still reach the job log —
 * losing it behind a comment-I/O failure would leave a human with only
 * "the write failed", none of the reasons that made this a fallback run
 * in the first place).
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param reasons - One or more human-readable explanations.
 */
export async function publishFallback(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  reasons: readonly string[],
): Promise<void> {
  logFallbackReasons(prNumber, reasons);
  await upsertSummaryComment(token, owner, repo, prNumber, buildSpecGroundingFallbackCommentBody(reasons));
}

/**
 * Clears this workflow's own prior spec-grounded summary/fallback comment
 * on a PR that no longer has any UNMET linked-issue criteria to review
 * (PR #86 review, Codex, P2) — a NO-OP if no such comment exists, since
 * an ordinary PR that never had criteria in the first place has no
 * reason to suddenly grow a "cleared" comment it never carried.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param reason - Why this run is clearing/updating this comment (PR #87
 *   review, Codex, P1/medium fold + round 3's own TOCTOU fold) — passed
 *   straight through to {@link buildSpecGroundingClearedSummaryCommentBody}
 *   so the posted message is accurate for the case that actually applies.
 * @param deletedInlineBlockerCount - Blockers safely deleted before a later
 *   destructive-boundary recheck detected drift.
 * @param createIfMissing - Whether partial destructive progress requires a
 *   visible summary even when no prior summary comment exists.
 * @returns `true` if a summary was updated or created, `false` if there was
 *   nothing to clear and `createIfMissing` was false.
 */
export async function clearStaleSpecGroundingSummary(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  reason: ClearedSummaryReason,
  deletedInlineBlockerCount = 0,
  createIfMissing = false,
): Promise<boolean> {
  const existingId = await findExistingSummaryComment(token, owner, repo, prNumber);
  if (existingId === null) {
    if (!createIfMissing) {
      return false;
    }
    await upsertSummaryComment(
      token,
      owner,
      repo,
      prNumber,
      buildSpecGroundingClearedSummaryCommentBody(reason, deletedInlineBlockerCount),
    );
    return true;
  }
  await upsertSummaryComment(
    token,
    owner,
    repo,
    prNumber,
    buildSpecGroundingClearedSummaryCommentBody(reason, deletedInlineBlockerCount),
  );
  return true;
}
