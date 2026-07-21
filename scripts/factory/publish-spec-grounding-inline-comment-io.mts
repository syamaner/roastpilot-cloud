/**
 * Inline blocker comment I/O for the privileged spec-grounded review
 * publisher (F1-S9 slice 3b-iii-d4, issue #12) — the network-wiring
 * sibling of `publish-spec-grounding-comment-io.mts` (the SUMMARY
 * comment's own find/upsert), split into its own file for the same
 * PR-hygiene reason: an independently reviewable, self-contained unit,
 * "find/upsert this run's own planned inline blocker comments on a PR's
 * diff", nothing else.
 *
 * THE 422 PROBE-THEN-DEGRADE (team-lead's design, #12 3b-iii-d+e PR-plan
 * sign-off): every comment in one run's {@link
 * import("./publish-spec-grounding-blocker-logic.mts").BlockerCommentPlanResult}
 * shares the SAME deterministic anchor (`publish-spec-grounding-blocker-
 * logic.mts`'s own `selectDeterministicBlockerAnchor` — one anchor per
 * run, not one per comment). GitHub's own create-review-comment API can
 * still reject that anchor with a 422 (an out-of-range or otherwise
 * invalid diff position — our own textual diff parsing and GitHub's own
 * internal diff-position mapping can disagree at the edges) even though
 * our own parsing accepted it. Since every planned comment shares the
 * identical anchor, a 422 on the FIRST one is diagnostic for the WHOLE
 * plan — {@link postInlineCommentPlan} posts only that one first, and if
 * it 422s, abandons the rest entirely rather than repeating the same
 * failure for every remaining comment. Only the FIRST comment's own 422
 * is treated this way (LOW2, #12 3b-iii-d+e PR-plan sign-off): a
 * NON-first failure, or a first failure for any OTHER status (403, 429,
 * a 5xx), is a genuine error and propagates uncaught — this module makes
 * no attempt to guess whether a later, unexpected failure is anchor-
 * related.
 *
 * IDEMPOTENCY: every {@link BlockerCommentPlan} carries its own stable
 * `marker` (`publish-spec-grounding-blocker-logic.mts`'s own field,
 * added specifically so this entrypoint could find-and-update without
 * re-parsing comment bodies). {@link findExistingInlineComments} fetches
 * every existing inline review comment on the PR ONCE per run
 * (paginated); the caller matches each planned comment against that list
 * by bot identity AND {@link bodyContainsMarkerAsStandaloneLine} — the
 * SAME structural (never a loose substring) marker-match primitive the
 * summary comment's own idempotency already uses, reused rather than a
 * second, independently-maintained copy.
 */

import { GithubApiError, githubRequest } from "./github-api.mts";
import type { BlockerCommentPlan } from "./publish-spec-grounding-blocker-logic.mts";
import {
  bodyContainsMarkerAsStandaloneLine,
  SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN,
  type ExistingComment,
} from "./publish-spec-grounding-verdict-logic.mts";

interface GitHubReviewComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}

const COMMENT_PAGE_SIZE = 100;
/** Same rationale and value as `publish-spec-grounding-comment-io.mts`'s own identical constant. */
const MAX_COMMENT_PAGES = 50;

/**
 * Fetches every existing inline review comment on a PR, paginated —
 * unfiltered by marker (the caller checks each planned comment's own
 * marker against this list), but narrowed to the shared {@link
 * ExistingComment} shape `bodyContainsMarkerAsStandaloneLine` and its
 * callers already expect.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @returns Every existing inline review comment on the PR.
 */
export async function findExistingInlineComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<readonly ExistingComment[]> {
  const all: ExistingComment[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await githubRequest<GitHubReviewComment[]>(
      token,
      "GET",
      `/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
    );
    for (const c of comments) {
      all.push({
        id: c.id,
        body: c.body,
        authorType: c.user?.type ?? null,
        authorLogin: c.user?.login ?? null,
      });
    }
    if (comments.length < COMMENT_PAGE_SIZE) {
      break;
    }
    if (page === MAX_COMMENT_PAGES) {
      console.warn(
        `Scanned ${MAX_COMMENT_PAGES} pages of inline review comments on PR #${prNumber} — a marker ` +
          `beyond this page limit would not be found, risking a duplicate post rather than an update.`,
      );
    }
  }
  return all;
}

/**
 * Finds `plan`'s own prior inline comment among `existing`, if any — the
 * SAME bot-identity + structural-marker-match discipline {@link
 * import("./publish-spec-grounding-verdict-logic.mts").findExistingSpecGroundingSummaryCommentId}
 * uses for the summary comment, applied per-plan-entry here instead of
 * against one fixed marker.
 *
 * @param existing - Every existing inline review comment on the PR
 *   ({@link findExistingInlineComments}'s own output).
 * @param plan - The planned comment to find a match for.
 * @returns The existing comment's id, or `null` if none found.
 */
export function findExistingInlineCommentId(
  existing: readonly ExistingComment[],
  plan: BlockerCommentPlan,
): number | null {
  const match = existing.find(
    (c) =>
      c.authorType === "Bot" &&
      c.authorLogin === SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN &&
      bodyContainsMarkerAsStandaloneLine(c.body, plan.marker),
  );
  return match ? match.id : null;
}

/**
 * Upserts one planned inline comment: PATCHes the prior run's own
 * comment (found via {@link findExistingInlineCommentId}) if one exists,
 * otherwise POSTs a new one anchored to `plan`'s own `path`/`line`.
 *
 * A PATCH never re-sends `path`/`line`/`commit_id` — GitHub's own
 * update-review-comment endpoint only accepts `body`, and does not
 * re-validate or move the comment's anchor — so ONLY the POST branch can
 * ever produce the anchor-invalid 422 {@link postInlineCommentPlan}'s own
 * probe watches for.
 *
 * ACCEPTED LIMITATION (d4 pre-open pass, LOW-1): a PATCH-in-place also
 * never re-opens a thread a human has already RESOLVED — if the same
 * blocker survives a later push, this function still updates that
 * resolved thread's body rather than reopening it, so that push's run
 * exits 0 without gating on it, purely because a human already looked.
 * Inherent to upsert-by-marker (the summary comment's own {@link
 * import("./publish-spec-grounding-comment-io.mts").upsertSummaryComment}
 * has the identical property), and adjacent to issue #77's own
 * stale-marker-under-a-changed-criteria scope — not fixed here.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param headSha - The trusted head SHA this run's diff was fetched
 *   against — GitHub's create-review-comment API requires `commit_id`
 *   exactly matching a commit on the PR.
 * @param existing - Every existing inline review comment on the PR.
 * @param plan - The planned comment to post or update.
 */
export async function upsertInlineComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  existing: readonly ExistingComment[],
  plan: BlockerCommentPlan,
): Promise<void> {
  const existingId = findExistingInlineCommentId(existing, plan);
  if (existingId !== null) {
    await githubRequest(token, "PATCH", `/repos/${owner}/${repo}/pulls/comments/${existingId}`, {
      body: plan.body,
    });
  } else {
    await githubRequest(token, "POST", `/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
      body: plan.body,
      commit_id: headSha,
      path: plan.path,
      line: plan.line,
      side: "RIGHT",
    });
  }
}

/**
 * Posts (or updates) this run's entire planned set of inline blocker
 * comments, applying the 422 probe-then-degrade this module's own
 * top-level docstring describes: the FIRST comment in `plan` is posted
 * first, alone; if GitHub rejects it with a 422 (an invalid anchor), the
 * rest are never attempted at all, and this function returns `{ ok:
 * false }` so the caller can degrade to the anchor-fallback summary
 * path. Any OTHER failure — a non-first comment, or the first comment
 * failing with anything other than a 422 — propagates uncaught; this is
 * a genuine error, not a signal to degrade.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param headSha - The trusted head SHA this run's diff was fetched against.
 * @param plan - This run's planned inline comments, in the order to post them.
 * @returns `{ ok: true }` once every comment posted/updated successfully
 *   (including the trivial case of an empty plan); `{ ok: false }` if
 *   the FIRST comment was rejected with a 422.
 */
export async function postInlineCommentPlan(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  plan: readonly BlockerCommentPlan[],
): Promise<{ readonly ok: boolean }> {
  if (plan.length === 0) {
    return { ok: true };
  }
  const existing = await findExistingInlineComments(token, owner, repo, prNumber);
  for (const [i, entry] of plan.entries()) {
    try {
      await upsertInlineComment(token, owner, repo, prNumber, headSha, existing, entry);
    } catch (err) {
      if (i === 0 && err instanceof GithubApiError && err.status === 422) {
        return { ok: false };
      }
      throw err;
    }
  }
  return { ok: true };
}
