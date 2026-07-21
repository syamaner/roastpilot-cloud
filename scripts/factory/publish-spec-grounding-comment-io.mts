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
  buildSpecGroundingFallbackCommentBody,
  findExistingSpecGroundingSummaryCommentId,
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
 */
export async function upsertSummaryComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const existingId = await findExistingSummaryComment(token, owner, repo, prNumber);
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
 * Publishes the fallback comment (see {@link buildSpecGroundingFallbackCommentBody})
 * for a run that could not produce a real summary, and logs the reasons
 * for CI-run visibility.
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
  await upsertSummaryComment(token, owner, repo, prNumber, buildSpecGroundingFallbackCommentBody(reasons));
  console.error(
    `Spec-grounded review publish failed for PR #${prNumber}. Reasons:\n` +
      reasons.map((r) => `  - ${neutralizeReasonForLog(r)}`).join("\n"),
  );
}
