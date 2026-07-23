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
 * @returns `{ ok: true, postedMarkers, createdMarkers }` once every comment
 *   posted/updated successfully (including the trivial case of an empty
 *   plan, where both are `[]`); `{ ok: false, reason: "anchor-rejected-422",
 *   postedMarkers, createdMarkers }` if the first genuine CREATE attempt
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
 */
export async function postInlineCommentPlan(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  plan: readonly BlockerCommentPlan[],
): Promise<
  | { readonly ok: true; readonly postedMarkers: readonly string[]; readonly createdMarkers: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: InlinePostingDegradeReason;
      readonly postedMarkers: readonly string[];
      readonly createdMarkers: readonly string[];
    }
> {
  if (plan.length === 0) {
    return { ok: true, postedMarkers: [], createdMarkers: [] };
  }
  const existing = await findExistingInlineComments(token, owner, repo, prNumber);
  let firstCreateSucceeded = false;
  const postedMarkers: string[] = [];
  const createdMarkers: string[] = [];
  for (const entry of plan) {
    // Determined BEFORE the call, independent of success or failure -- a
    // PATCH (an existing match) never re-validates the anchor at all
    // (see upsertInlineComment's own docstring), so only a CREATE
    // attempt is ever diagnostic for the whole plan's shared anchor.
    const isCreateAttempt = findExistingInlineCommentId(existing, entry) === null;
    try {
      await upsertInlineComment(token, owner, repo, prNumber, headSha, existing, entry);
      postedMarkers.push(entry.marker);
      if (isCreateAttempt) {
        firstCreateSucceeded = true;
        createdMarkers.push(entry.marker);
      }
    } catch (err) {
      if (isCreateAttempt && !firstCreateSucceeded && err instanceof GithubApiError && err.status === 422) {
        return { ok: false, reason: "anchor-rejected-422", postedMarkers, createdMarkers };
      }
      throw err;
    }
  }
  return { ok: true, postedMarkers, createdMarkers };
}

/**
 * Deletes every existing inline review comment this workflow previously
 * posted as a blocker on a PR that no longer has any linked-issue
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
 * findExistingInlineCommentId} does is not available here.
 *
 * Tolerates a 404 on an individual DELETE (a human already resolved or
 * deleted that thread themselves, between this run's own fetch and the
 * delete) as a benign no-op — the SAME best-effort-cleanup tolerance
 * `publish-implement-patch.mts`'s own `removeNoAutoChainLabelBestEffort`
 * applies to its own identical "already gone" case. Any OTHER failure
 * propagates uncaught, so the caller can surface it as a genuine error
 * rather than silently leaving a stale thread in place.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @returns The number of stale inline comments actually deleted.
 */
export async function clearStaleInlineBlockerComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  const existing = await findExistingInlineComments(token, owner, repo, prNumber);
  const stale = existing.filter(
    (c) =>
      c.authorType === "Bot" && c.authorLogin === SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN && bodyContainsAnyBlockerMarker(c.body),
  );
  let deletedCount = 0;
  for (const comment of stale) {
    try {
      await githubRequest(token, "DELETE", `/repos/${owner}/${repo}/pulls/comments/${comment.id}`);
      deletedCount += 1;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) {
        continue; // Already gone -- nothing to do, not a failure.
      }
      throw err;
    }
  }
  return deletedCount;
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
 * Any drift returns a fail-closed result without deleting anything.
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
  | { readonly ok: false; readonly reason: PullRequestSnapshotDriftReason }
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
    return snapshotVerification;
  }

  const obsolete = existing.filter((c) => {
    if (c.authorType !== "Bot" || c.authorLogin !== SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN) {
      return false;
    }
    const generation = extractInlineBlockerGeneration(c.body);
    if (generation === null || generation > currentGeneration) {
      return false;
    }
    const issueNumber = extractIssueNumberFromInlineBlockerMarker(c.body);
    if (issueNumber !== null) {
      return !currentlyClosingIssueNumbers.has(issueNumber);
    }
    return (
      currentlyClosingIssueNumbers.size === 0 &&
      !diffTruncationBlocksClosingClaim &&
      bodyContainsMarkerAsStandaloneLine(c.body, DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER)
    );
  });
  let deletedCount = 0;
  for (const comment of obsolete) {
    try {
      await githubRequest(token, "DELETE", `/repos/${owner}/${repo}/pulls/comments/${comment.id}`);
      deletedCount += 1;
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 404) {
        continue; // Already gone -- nothing to do, not a failure.
      }
      throw err;
    }
  }
  return { ok: true, deletedCount };
}
