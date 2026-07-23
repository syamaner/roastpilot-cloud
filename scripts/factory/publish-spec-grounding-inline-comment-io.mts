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
 * our own parsing accepted it.
 *
 * The probe targets the FIRST CREATE (POST) attempt, NOT literal plan
 * index 0 (PR #87 review, Codex, P2 — a real gap the original version
 * missed): {@link upsertInlineComment}'s own docstring already
 * establishes that a PATCH never re-sends `path`/`line`/`commit_id`, so
 * it can NEVER produce the anchor-invalid 422 this probe watches for —
 * meaning if plan entry 0 happens to match an EXISTING comment (a
 * re-run), it PATCHes, and the anchor is never probed at all that
 * iteration; the probe must instead fire on whichever entry is the
 * first genuine POST, wherever it falls in the plan. Since every
 * planned comment shares the identical anchor, a 422 on that FIRST POST
 * is diagnostic for the WHOLE plan — {@link postInlineCommentPlan}
 * abandons the rest entirely rather than repeating the same failure for
 * every remaining comment. Only that FIRST POST's own 422 is treated
 * this way (LOW2, #12 3b-iii-d+e PR-plan sign-off): a PATCH's own 422
 * (never anchor-related), a LATER post-anchor-already-proven-valid
 * POST's 422, or a first-POST failure for any OTHER status (403, 429, a
 * 5xx), is a genuine error and propagates uncaught — this module makes
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
import {
  bodyContainsAnyBlockerMarker,
  DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER,
  extractInlineBlockerGeneration,
  extractIssueNumberFromInlineBlockerMarker,
  type BlockerCommentPlan,
  type InlinePostingDegradeReason,
} from "./publish-spec-grounding-blocker-logic.mts";
import { parseLinkedIssueReferences } from "./spec-grounding-logic.mts";
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
const REVIEW_THREAD_PAGE_SIZE = 100;
const MAX_REVIEW_THREAD_PAGES = 50;

const REVIEW_THREAD_RESOLUTION_QUERY = `
  query ReviewThreadResolution(
    $owner: String!
    $repo: String!
    $prNumber: Int!
    $cursor: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $prNumber) {
        reviewThreads(first: ${REVIEW_THREAD_PAGE_SIZE}, after: $cursor) {
          nodes {
            isResolved
            comments(first: 1) {
              nodes {
                fullDatabaseId
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

interface ReviewThreadResolution {
  readonly fullCommentId: string;
  readonly isResolved: boolean;
}

interface ReviewThreadResolutionPage {
  readonly threads: readonly ReviewThreadResolution[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GitHub GraphQL review-thread response has invalid ${field}`);
  }
  return value as Record<string, unknown>;
}

function parseReviewThreadResolutionPage(value: unknown): ReviewThreadResolutionPage {
  const root = asRecord(value, "root");
  if (root.errors !== undefined) {
    if (!Array.isArray(root.errors)) {
      throw new Error("GitHub GraphQL review-thread response has invalid errors");
    }
    if (root.errors.length > 0) {
      throw new Error("GitHub GraphQL review-thread response contains errors");
    }
  }
  const data = asRecord(root.data, "data");
  const repository = asRecord(data.repository, "repository");
  const pullRequest = asRecord(repository.pullRequest, "pullRequest");
  const reviewThreads = asRecord(pullRequest.reviewThreads, "reviewThreads");
  if (!Array.isArray(reviewThreads.nodes)) {
    throw new Error("GitHub GraphQL review-thread response has invalid nodes");
  }
  const pageInfo = asRecord(reviewThreads.pageInfo, "pageInfo");
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new Error("GitHub GraphQL review-thread response has invalid hasNextPage");
  }
  if (pageInfo.endCursor !== null && typeof pageInfo.endCursor !== "string") {
    throw new Error("GitHub GraphQL review-thread response has invalid endCursor");
  }
  if (pageInfo.hasNextPage && (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0)) {
    throw new Error("GitHub GraphQL review-thread response is missing its next-page cursor");
  }

  const threads = reviewThreads.nodes.map((node, index): ReviewThreadResolution => {
    const thread = asRecord(node, `nodes[${index}]`);
    if (typeof thread.isResolved !== "boolean") {
      throw new Error(`GitHub GraphQL review-thread response has invalid nodes[${index}].isResolved`);
    }
    const comments = asRecord(thread.comments, `nodes[${index}].comments`);
    if (!Array.isArray(comments.nodes) || comments.nodes.length === 0) {
      throw new Error(`GitHub GraphQL review-thread response has invalid nodes[${index}].comments.nodes`);
    }
    const rootComment = asRecord(comments.nodes[0], `nodes[${index}].comments.nodes[0]`);
    if (typeof rootComment.fullDatabaseId !== "string" || !/^[1-9]\d*$/.test(rootComment.fullDatabaseId)) {
      throw new Error(`GitHub GraphQL review-thread response has invalid nodes[${index}] root comment fullDatabaseId`);
    }
    return {
      fullCommentId: rootComment.fullDatabaseId,
      isResolved: thread.isResolved,
    };
  });

  return {
    threads,
    hasNextPage: pageInfo.hasNextPage,
    endCursor: pageInfo.endCursor,
  };
}

/**
 * Finds which target root review-comment IDs belong to confirmed-unresolved
 * review threads.
 *
 * Uses GitHub's GraphQL-only `PullRequestReviewThread.isResolved` field and
 * maps it back to the REST review-comment IDs already used for marker-based
 * PATCHes via each thread's root comment `fullDatabaseId`. The query is fixed;
 * owner/repo/PR/cursor are variables. Pagination is bounded to the same 5,000
 * thread ceiling as the module's REST comment scan.
 *
 * A target absent from every fetched page is deliberately absent from the
 * result: the caller may exclude only confirmed-unresolved comments and must
 * keep any unlocated target in its conservative fallback. Malformed GraphQL
 * data or an API failure throws so the caller can retain every affected
 * blocker rather than trusting partial/invalid state.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The trusted repository owner.
 * @param repo - The trusted repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param targetCommentIds - REST IDs of successfully PATCHed root review comments.
 * @returns The subset whose review threads are confirmed unresolved.
 */
export async function findConfirmedUnresolvedReviewCommentIds(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  targetCommentIds: ReadonlySet<number>,
): Promise<ReadonlySet<number>> {
  const remaining = new Map<string, number>();
  for (const commentId of targetCommentIds) {
    if (!Number.isSafeInteger(commentId) || commentId <= 0) {
      throw new Error(`PATCHed review-comment ID ${String(commentId)} is not a positive safe integer`);
    }
    remaining.set(String(commentId), commentId);
  }
  const unresolved = new Set<number>();
  if (remaining.size === 0) {
    return unresolved;
  }

  let cursor: string | null = null;
  for (let page = 1; page <= MAX_REVIEW_THREAD_PAGES; page++) {
    const response = await githubRequest<unknown>(token, "POST", "/graphql", {
      query: REVIEW_THREAD_RESOLUTION_QUERY,
      variables: { owner, repo, prNumber, cursor },
    });
    const parsed = parseReviewThreadResolutionPage(response);
    for (const thread of parsed.threads) {
      const targetCommentId = remaining.get(thread.fullCommentId);
      if (targetCommentId === undefined) {
        continue;
      }
      remaining.delete(thread.fullCommentId);
      if (!thread.isResolved) {
        unresolved.add(targetCommentId);
      }
    }
    if (remaining.size === 0 || !parsed.hasNextPage) {
      break;
    }
    cursor = parsed.endCursor;
  }

  if (remaining.size > 0) {
    console.warn(
      `Could not locate ${remaining.size} PATCHed blocker comment(s) in review threads on PR #${prNumber}; ` +
        "they will stay in the fallback.",
    );
  }
  return unresolved;
}

/** Result of generation-safe no-criteria cleanup, including fail-closed partial progress. */
export type ClearStaleInlineBlockerCommentsResult =
  | { readonly ok: true; readonly deletedCount: number }
  | { readonly ok: false; readonly deletedCount: number };

/** Operation phase that failed during generation-safe no-criteria cleanup. */
export type InlineBlockerCleanupErrorPhase = "pre-delete-check" | "delete";

/**
 * A no-criteria cleanup failure carrying the number of earlier deletes
 * confirmed by successful responses while the destructive-boundary
 * predicate still matched.
 */
export class InlineBlockerCleanupError extends Error {
  readonly deletedCount: number;
  readonly phase: InlineBlockerCleanupErrorPhase;

  constructor(deletedCount: number, phase: InlineBlockerCleanupErrorPhase, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "InlineBlockerCleanupError";
    this.deletedCount = deletedCount;
    this.phase = phase;
  }
}
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
 * PATCH LIMITATION: a PATCH-in-place never re-opens a thread a human has
 * already RESOLVED. This primitive still updates that resolved thread's
 * body; its orchestrator, {@link postInlineCommentPlan}, compensates by
 * querying thread resolution after PATCHes and retaining any resolved or
 * resolution-unknown blocker in the visible, nonzero-exit fallback.
 * Inherent to upsert-by-marker (the summary comment's own {@link
 * import("./publish-spec-grounding-comment-io.mts").upsertSummaryComment}
 * has the identical property); callers must not treat PATCH success alone
 * as proof that the thread still gates.
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

async function collectUnresolvedPostedMarkers(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  postedMarkers: readonly string[],
  createdMarkers: readonly string[],
  patchedCommentIdsByMarker: ReadonlyMap<string, number>,
): Promise<readonly string[]> {
  const unresolvedPostedMarkerSet = new Set(createdMarkers);
  if (patchedCommentIdsByMarker.size > 0) {
    try {
      const unresolvedCommentIds = await findConfirmedUnresolvedReviewCommentIds(
        token,
        owner,
        repo,
        prNumber,
        new Set(patchedCommentIdsByMarker.values()),
      );
      for (const [marker, commentId] of patchedCommentIdsByMarker) {
        if (unresolvedCommentIds.has(commentId)) {
          unresolvedPostedMarkerSet.add(marker);
        }
      }
    } catch (resolutionError) {
      console.warn(
        `Could not confirm PATCHed blocker review-thread resolution on PR #${prNumber}; ` +
          "all PATCHed blockers will stay in the fallback. " +
          (resolutionError instanceof Error ? resolutionError.message : String(resolutionError)),
      );
    }
  }
  return postedMarkers.filter((marker) => unresolvedPostedMarkerSet.has(marker));
}

/**
 * Posts (or updates) this run's entire planned set of inline blocker
 * comments, applying the 422 probe-then-degrade this module's own
 * top-level docstring describes: the FIRST entry that is a genuine
 * CREATE (POST, never a PATCH — see this module's own top-level
 * docstring, PR #87 review, Codex, P2 fold) is the probe; if GitHub
 * rejects THAT one with a 422 (an invalid anchor), the rest are never
 * attempted at all, and this function returns `{ ok: false, reason:
 * "anchor-rejected-422" }` (PR #87 review round 4, Codex, P1 — the
 * discriminated reason, not a bare boolean, so the caller's own summary
 * wording can distinguish this from the DIFFERENT anchor-absent case
 * {@link import("./publish-spec-grounding-blocker-logic.mts").planBlockerInlineComments}'s
 * own `anchorFallbackNeeded` already signals) so the caller can degrade
 * to the anchor-fallback summary path. Any OTHER failure — a PATCH's own
 * 422 (never anchor-related), a later POST's 422 once the anchor is
 * already proven valid, or a first-POST failure for any status other
 * than 422 — propagates uncaught; this is a genuine error, not a signal
 * to degrade.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param headSha - The trusted head SHA this run's diff was fetched against.
 * @param plan - This run's planned inline comments, in the order to post them.
 * @returns `{ ok: true, postedMarkers, createdMarkers,
 *   unresolvedPostedMarkers }` once every comment
 *   posted/updated successfully (including the trivial case of an empty
 *   plan, where all three are `[]`); `{ ok: false, reason:
 *   "anchor-rejected-422", postedMarkers, createdMarkers,
 *   unresolvedPostedMarkers }` if the first genuine CREATE attempt
 *   was rejected with a 422 — `postedMarkers` is every entry's own
 *   `marker` that WAS successfully posted/patched BEFORE that rejection,
 *   in plan order (F1-S9 slice 90.6a, issue #90's own #378 — a mid-plan
 *   422 does not undo the entries that already succeeded; the caller
 *   needs to know which ones those are so it never re-describes an
 *   already-live inline thread as if none existed). `createdMarkers` is
 *   the SUBSET of `postedMarkers` that were genuine CREATEs (a fresh
 *   `POST`, no prior comment existed), as distinct from a PATCH (F1-S9
 *   slice 90.6a, issue #90's own #378 completion, PR #99 review, Codex,
 *   cid 3627282617, P2 — a PATCH can silently update an ALREADY-RESOLVED
 *   thread without reopening it, see {@link upsertInlineComment}'s own
 *   "ACCEPTED LIMITATION" docs; excluding such an entry from the
 *   anchor-fallback based on `postedMarkers` alone would make a
 *   re-detected-but-resolved blocker vanish entirely — neither gating,
 *   since the resolved thread stays resolved, NOR listed, since it was
 *   "already posted." A fresh CREATE has no such ambiguity: no comment
 *   existed before this run, so nothing could have been resolved).
 *   `unresolvedPostedMarkers` is the subset represented by either a fresh
 *   CREATE or a successfully PATCHed comment whose GraphQL review thread
 *   is confirmed unresolved. It is computed for successful and degraded
 *   plans alike: a resolved, unlocated, malformed, or lookup-failed PATCH
 *   is absent so the caller conservatively keeps its blocker in fallback
 *   (issue #90's resolution-aware fallback exclusion).
 */
export async function postInlineCommentPlan(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  plan: readonly BlockerCommentPlan[],
): Promise<
  | {
      readonly ok: true;
      readonly postedMarkers: readonly string[];
      readonly createdMarkers: readonly string[];
      readonly unresolvedPostedMarkers: readonly string[];
    }
  | {
      readonly ok: false;
      readonly reason: InlinePostingDegradeReason;
      readonly postedMarkers: readonly string[];
      readonly createdMarkers: readonly string[];
      readonly unresolvedPostedMarkers: readonly string[];
    }
> {
  if (plan.length === 0) {
    return { ok: true, postedMarkers: [], createdMarkers: [], unresolvedPostedMarkers: [] };
  }
  const existing = await findExistingInlineComments(token, owner, repo, prNumber);
  let firstCreateSucceeded = false;
  const postedMarkers: string[] = [];
  const createdMarkers: string[] = [];
  const patchedCommentIdsByMarker = new Map<string, number>();
  for (const entry of plan) {
    // Determined BEFORE the call, independent of success or failure -- a
    // PATCH (an existing match) never re-validates the anchor at all
    // (see upsertInlineComment's own docstring), so only a CREATE
    // attempt is ever diagnostic for the whole plan's shared anchor.
    const existingCommentId = findExistingInlineCommentId(existing, entry);
    const isCreateAttempt = existingCommentId === null;
    try {
      await upsertInlineComment(token, owner, repo, prNumber, headSha, existing, entry);
      postedMarkers.push(entry.marker);
      if (existingCommentId === null) {
        firstCreateSucceeded = true;
        createdMarkers.push(entry.marker);
      } else {
        patchedCommentIdsByMarker.set(entry.marker, existingCommentId);
      }
    } catch (err) {
      if (isCreateAttempt && !firstCreateSucceeded && err instanceof GithubApiError && err.status === 422) {
        const unresolvedPostedMarkers = await collectUnresolvedPostedMarkers(
          token,
          owner,
          repo,
          prNumber,
          postedMarkers,
          createdMarkers,
          patchedCommentIdsByMarker,
        );
        return {
          ok: false,
          reason: "anchor-rejected-422",
          postedMarkers,
          createdMarkers,
          unresolvedPostedMarkers,
        };
      }
      throw err;
    }
  }
  return {
    ok: true,
    postedMarkers,
    createdMarkers,
    unresolvedPostedMarkers: await collectUnresolvedPostedMarkers(
      token,
      owner,
      repo,
      prNumber,
      postedMarkers,
      createdMarkers,
      patchedCommentIdsByMarker,
    ),
  };
}

/**
 * Deletes generation-safe existing inline review comments this workflow
 * previously posted as blockers on a PR that no longer has any linked-issue
 * criteria to review at all (PR #86 review, Codex, P2): a PR's body edit
 * that removes its last closing-keyword reference makes the runner emit
 * `hasCriteria: false`, but the earlier run's own inline blocker
 * comments — each gating `required_conversation_resolution` on its own
 * thread — would otherwise stay open and gating forever, referring to
 * criteria that no longer exist. Identifies "ours" generically via
 * {@link bodyContainsAnyBlockerMarker} (any of this module's sibling
 * `publish-spec-grounding-blocker-logic.mts`'s five own marker shapes),
 * never a specific run's own plan — there IS no plan at all once
 * criteria are gone, so matching against `plan.marker` the way {@link
 * findExistingInlineCommentId} does is not available here. A comment is
 * eligible only when its exact generation marker parses and is less than
 * or equal to this run's generation. Missing, malformed, and newer
 * generations remain untouched, so an older cleanup can never delete a
 * newer publisher's valid blocker even if workflow serialization weakens.
 * After comment pagination, `preDeleteCheck` revalidates the caller's
 * no-reference predicate immediately before every eligible DELETE. Drift
 * stops the loop and reports the number already deleted while the predicate
 * still matched.
 *
 * Tolerates a 404 on an individual DELETE (a human already resolved or
 * deleted that thread themselves, between this run's own fetch and the
 * delete) as a benign no-op — the SAME best-effort-cleanup tolerance
 * `publish-implement-patch.mts`'s own `removeNoAutoChainLabelBestEffort`
 * applies to its own identical "already gone" case. Any OTHER failure
 * propagates as {@link InlineBlockerCleanupError}, preserving partial
 * progress so the caller can surface both the genuine error and any
 * blocker already removed. Automatic rate-limit retries are disabled for
 * the DELETE itself: a delayed retry would otherwise occur without another
 * `preDeleteCheck`, reopening the destructive-boundary race this function
 * closes.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param currentGeneration - This run's validated `github.run_number`.
 * @param preDeleteCheck - Fresh no-reference verification at the destructive boundary.
 * @returns Success with the delete count, or fail-closed drift with partial progress.
 */
export async function clearStaleInlineBlockerComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  currentGeneration: number,
  preDeleteCheck: () => Promise<boolean>,
): Promise<ClearStaleInlineBlockerCommentsResult> {
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration <= 0) {
    throw new Error("currentGeneration must be a positive safe integer");
  }
  const existing = await findExistingInlineComments(token, owner, repo, prNumber);
  const stale = existing.filter(
    (c) => {
      if (
        c.authorType !== "Bot" ||
        c.authorLogin !== SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN ||
        !bodyContainsAnyBlockerMarker(c.body)
      ) {
        return false;
      }
      const generation = extractInlineBlockerGeneration(c.body);
      return generation !== null && generation <= currentGeneration;
    },
  );
  let deletedCount = 0;
  for (const comment of stale) {
    let stillSafeToDelete: boolean;
    try {
      stillSafeToDelete = await preDeleteCheck();
    } catch (err) {
      throw new InlineBlockerCleanupError(deletedCount, "pre-delete-check", err);
    }
    if (!stillSafeToDelete) {
      return { ok: false, deletedCount };
    }
    try {
      await githubRequest(
        token,
        "DELETE",
        `/repos/${owner}/${repo}/pulls/comments/${comment.id}`,
        undefined,
        { maxRateLimitRetries: 0 },
      );
      deletedCount += 1;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) {
        continue; // Already gone -- nothing to do, not a failure.
      }
      throw new InlineBlockerCleanupError(deletedCount, "delete", err);
    }
  }
  return { ok: true, deletedCount };
}

/** A PR body's own derived closing-kind and any-kind linked-issue-reference sets — see {@link deriveLinkedReferenceIssueNumberSets}. */
export interface LinkedReferenceIssueNumberSets {
  readonly closing: ReadonlySet<number>;
  readonly referenced: ReadonlySet<number>;
}

/**
 * The PURE parsing half of the reference re-verify: derives the closing-kind
 * and any-kind issue-number sets from an already-in-hand PR body string.
 * Shared with {@link verifyPullRequestSnapshotUnchanged} so a caller
 * that already fetched the PR for its OWN reasons (e.g. one that also needed
 * head-SHA verification from that same fetch, see `publish-spec-grounding-
 * verdict.mts`'s own `publishSummary`) can derive the identical sets from its
 * own already-fetched body, without a second, redundant network call — the
 * shared primitive stays the SET DERIVATION, not the fetch itself, so the two
 * callers can never compute these sets differently even though they fetch
 * differently.
 *
 * @param body - The PR's body, as returned by the GitHub API (`null` if empty).
 * @param ownerRepo - `"{owner}/{repo}"`, passed straight through to
 *   {@link parseLinkedIssueReferences}.
 * @returns The derived closing-kind and any-kind issue-number sets.
 */
export function deriveLinkedReferenceIssueNumberSets(
  body: string | null,
  ownerRepo: string,
): LinkedReferenceIssueNumberSets {
  const references = parseLinkedIssueReferences(body ?? "", ownerRepo);
  return {
    closing: new Set(references.filter((reference) => reference.kind === "closing").map((reference) => reference.issueNumber)),
    referenced: new Set(references.map((reference) => reference.issueNumber)),
  };
}

/**
 * Compares a freshly-derived {@link LinkedReferenceIssueNumberSets} against
 * the snapshot a caller took earlier — the PURE comparison half of the
 * reference re-verify, shared by every caller of {@link
 * deriveLinkedReferenceIssueNumberSets} so "what counts as unchanged" can
 * never drift between them.
 *
 * @param fresh - The just-derived, current-state sets.
 * @param snapshotClosingIssueNumbers - Every issue number the caller's own
 *   snapshot considered closing-referenced.
 * @param snapshotReferencedIssueNumbers - Every issue number the caller's
 *   own snapshot considered referenced, of ANY kind.
 * @returns `true` only if BOTH sets match the snapshot exactly; `false` on
 *   ANY drift in either set (an addition, a removal, or a kind change).
 */
export function linkedReferenceSnapshotsMatch(
  fresh: LinkedReferenceIssueNumberSets,
  snapshotClosingIssueNumbers: ReadonlySet<number>,
  snapshotReferencedIssueNumbers: ReadonlySet<number>,
): boolean {
  const setsMatch = (freshSet: ReadonlySet<number>, snapshot: ReadonlySet<number>): boolean =>
    freshSet.size === snapshot.size && [...freshSet].every((issueNumber) => snapshot.has(issueNumber));
  return (
    setsMatch(fresh.closing, snapshotClosingIssueNumbers) && setsMatch(fresh.referenced, snapshotReferencedIssueNumbers)
  );
}

/** A precise fail-closed drift reason from the pre-delete PR snapshot check. */
export type PullRequestSnapshotDriftReason =
  | "head-sha-changed"
  | "base-sha-changed"
  | "linked-references-changed";

/**
 * Re-fetches all mutable PR state that can affect blocker reconciliation.
 *
 * One fresh GET verifies head SHA, base SHA, closing references, and any-kind
 * references after inline-comment pagination and immediately before the first
 * DELETE. Keeping all four checks on one response avoids composing separately
 * fetched snapshots with a new TOCTOU gap between them.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is acting on.
 * @param trustedHeadSha - The workflow event's reviewed head SHA.
 * @param reviewedBaseSha - The runner-observed base SHA from the spine.
 * @param snapshotClosingIssueNumbers - Closing-reference snapshot.
 * @param snapshotReferencedIssueNumbers - Any-kind reference snapshot.
 * @returns `{ ok: true }` only when all dimensions still match; otherwise
 *   the exact drift dimension, with no caller permission to delete.
 */
export async function verifyPullRequestSnapshotUnchanged(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  trustedHeadSha: string,
  reviewedBaseSha: string,
  snapshotClosingIssueNumbers: ReadonlySet<number>,
  snapshotReferencedIssueNumbers: ReadonlySet<number>,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: PullRequestSnapshotDriftReason }> {
  const pr = await githubRequest<{
    readonly body: string | null;
    readonly head: { readonly sha: string };
    readonly base: { readonly sha: string };
  }>(token, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (pr.head.sha !== trustedHeadSha) {
    return { ok: false, reason: "head-sha-changed" };
  }
  if (pr.base.sha !== reviewedBaseSha) {
    return { ok: false, reason: "base-sha-changed" };
  }
  const fresh = deriveLinkedReferenceIssueNumberSets(pr.body, `${owner}/${repo}`);
  if (!linkedReferenceSnapshotsMatch(fresh, snapshotClosingIssueNumbers, snapshotReferencedIssueNumbers)) {
    return { ok: false, reason: "linked-references-changed" };
  }
  return { ok: true };
}

/**
 * Deletes generation-safe bot-owned blockers whose current obligation ended.
 *
 * Individual blockers are eligible when their decoded issue is absent from
 * the current closing-reference set. The diff-truncation aggregate is eligible
 * only when its exact standalone marker is present, its current applicability
 * predicate is false, and no closing references remain. The zero-closing
 * boundary preserves issue #77's interim guarantee that existing blocker
 * threads survive linked-issue criteria edits, which do not change PR state.
 * Before either kind is deleted, this
 * function paginates existing comments and freshly re-verifies the head SHA,
 * base SHA, closing references, and any-kind references from one PR response.
 * Aggregate candidates are processed before individuals and reverified again
 * immediately before each aggregate DELETE. A final reverify after aggregate
 * processing preserves the individual loop's own freshness boundary. Any
 * drift returns a fail-closed result with the number already deleted.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param trustedHeadSha - The workflow event's reviewed head SHA.
 * @param reviewedBaseSha - The runner-observed base SHA from the spine.
 * @param currentlyClosingIssueNumbers - Closing-reference snapshot.
 * @param currentlyReferencedIssueNumbers - Any-kind reference snapshot.
 * @param diffTruncationBlocksClosingClaim - Current aggregate applicability;
 *   false permits deletion only when the closing-reference set is also empty.
 * @param currentGeneration - This run's validated `github.run_number`.
 * @returns The number deleted, or a fail-closed PR-snapshot drift result.
 */
export async function reconcileObsoleteInlineBlockerComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  trustedHeadSha: string,
  reviewedBaseSha: string,
  currentlyClosingIssueNumbers: ReadonlySet<number>,
  currentlyReferencedIssueNumbers: ReadonlySet<number>,
  diffTruncationBlocksClosingClaim: boolean,
  currentGeneration: number,
): Promise<
  | { readonly ok: true; readonly deletedCount: number }
  | { readonly ok: false; readonly reason: PullRequestSnapshotDriftReason; readonly deletedCount: number }
> {
  const existing = await findExistingInlineComments(token, owner, repo, prNumber);

  const snapshotVerification = await verifyPullRequestSnapshotUnchanged(
    token,
    owner,
    repo,
    prNumber,
    trustedHeadSha,
    reviewedBaseSha,
    currentlyClosingIssueNumbers,
    currentlyReferencedIssueNumbers,
  );
  if (!snapshotVerification.ok) {
    return { ...snapshotVerification, deletedCount: 0 };
  }

  const obsoleteIndividuals: ExistingComment[] = [];
  const obsoleteAggregates: ExistingComment[] = [];
  for (const c of existing) {
    if (c.authorType !== "Bot" || c.authorLogin !== SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN) {
      continue;
    }
    const generation = extractInlineBlockerGeneration(c.body);
    if (generation === null || generation > currentGeneration) {
      continue;
    }
    const issueNumber = extractIssueNumberFromInlineBlockerMarker(c.body);
    if (issueNumber !== null) {
      if (!currentlyClosingIssueNumbers.has(issueNumber)) {
        obsoleteIndividuals.push(c);
      }
      continue;
    }
    if (
      currentlyClosingIssueNumbers.size === 0 &&
      !diffTruncationBlocksClosingClaim &&
      bodyContainsMarkerAsStandaloneLine(c.body, DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER)
    ) {
      obsoleteAggregates.push(c);
    }
  }

  let deletedCount = 0;
  const deleteComment = async (comment: ExistingComment): Promise<void> => {
    try {
      await githubRequest(token, "DELETE", `/repos/${owner}/${repo}/pulls/comments/${comment.id}`);
      deletedCount += 1;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) {
        return; // Already gone -- nothing to do, not a failure.
      }
      throw err;
    }
  };

  // Aggregate deletion is the new privileged capability in 90.6a-3.
  // Re-check immediately before every aggregate DELETE so no earlier DELETE
  // becomes an attacker-visible signal for an edit that makes it applicable.
  for (const comment of obsoleteAggregates) {
    const aggregateVerification = await verifyPullRequestSnapshotUnchanged(
      token,
      owner,
      repo,
      prNumber,
      trustedHeadSha,
      reviewedBaseSha,
      currentlyClosingIssueNumbers,
      currentlyReferencedIssueNumbers,
    );
    if (!aggregateVerification.ok) {
      return { ...aggregateVerification, deletedCount };
    }
    await deleteComment(comment);
  }

  if (obsoleteAggregates.length > 0 && obsoleteIndividuals.length > 0) {
    const individualVerification = await verifyPullRequestSnapshotUnchanged(
      token,
      owner,
      repo,
      prNumber,
      trustedHeadSha,
      reviewedBaseSha,
      currentlyClosingIssueNumbers,
      currentlyReferencedIssueNumbers,
    );
    if (!individualVerification.ok) {
      return { ...individualVerification, deletedCount };
    }
  }
  for (const comment of obsoleteIndividuals) {
    await deleteComment(comment);
  }
  return { ok: true, deletedCount };
}
