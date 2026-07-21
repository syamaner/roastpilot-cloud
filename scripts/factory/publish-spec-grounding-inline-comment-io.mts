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
 * @returns `{ ok: true }` once every comment posted/updated successfully
 *   (including the trivial case of an empty plan); `{ ok: false, reason:
 *   "anchor-rejected-422" }` if the first genuine CREATE attempt was
 *   rejected with a 422.
 */
export async function postInlineCommentPlan(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  plan: readonly BlockerCommentPlan[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: InlinePostingDegradeReason }> {
  if (plan.length === 0) {
    return { ok: true };
  }
  const existing = await findExistingInlineComments(token, owner, repo, prNumber);
  let firstCreateSucceeded = false;
  for (const entry of plan) {
    // Determined BEFORE the call, independent of success or failure -- a
    // PATCH (an existing match) never re-validates the anchor at all
    // (see upsertInlineComment's own docstring), so only a CREATE
    // attempt is ever diagnostic for the whole plan's shared anchor.
    const isCreateAttempt = findExistingInlineCommentId(existing, entry) === null;
    try {
      await upsertInlineComment(token, owner, repo, prNumber, headSha, existing, entry);
      if (isCreateAttempt) {
        firstCreateSucceeded = true;
      }
    } catch (err) {
      if (isCreateAttempt && !firstCreateSucceeded && err instanceof GithubApiError && err.status === 422) {
        return { ok: false, reason: "anchor-rejected-422" };
      }
      throw err;
    }
  }
  return { ok: true };
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

/**
 * Deletes every bot-owned inline blocker comment whose OWN issue is no
 * longer among this PR's CURRENT closing-kind references (F1-S9 slice
 * 90.4, redesigned — the #90 PR-plan's own core reconciliation item,
 * #363, per the operator's #801 resolution): a de-referenced or
 * downgraded-to-non-closing obligation stops gating forever, so a FIXED
 * blocker for one no longer has a live thread pinning it open.
 *
 * DELIBERATELY DOES NOT auto-clear a VERDICT-SATISFIED blocker whose own
 * issue is STILL closing-referenced (#801, the operator's own anti-gaming
 * ruling): a human resolves that class — this function's own membership
 * test never looks at the agent's verdict at all, only at whether the
 * comment's own issue is CURRENTLY closing-referenced, so a satisfied-
 * but-still-referenced criterion's comment is structurally never a
 * candidate here regardless of what any run's verdict says about it.
 * Distinct from {@link clearStaleInlineBlockerComments}'s own
 * `hasCriteria: false` path (no linked criteria left at all) — this
 * function runs on the `hasCriteria: true` side, alongside posting/
 * patching this run's own plan, never instead of it.
 *
 * GATED, mirroring {@link clearStaleInlineBlockerComments}'s own scope
 * discipline, PLUS the generation guard this function alone needs:
 * 1. `authorType === "Bot"` and `authorLogin ===
 *    SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN` — genuinely posted by this
 *    workflow, never mistaken for a look-alike from elsewhere.
 * 2. {@link extractIssueNumberFromInlineBlockerMarker}`(c.body)` is
 *    non-null — an INDIVIDUAL, per-issue blocker marker (never one of
 *    the three fixed AGGREGATE markers, which have no single issue to
 *    test membership for at all — see that function's own docstring for
 *    why `null` there IS the "leave aggregates alone" gate).
 * 3. NOT in `currentlyClosingIssueNumbers` — this comment's own decoded
 *    issue number is absent from the PR's CURRENT closing-kind
 *    references. Covers BOTH the de-referenced case (the issue is not
 *    mentioned at all anymore) and the downgraded case (still mentioned,
 *    but only as a plain/non-closing reference now, e.g. `Closes #N`
 *    edited to `Refs #N`) — both are equally "no live closing obligation
 *    for this issue", the operator's own bright line for what may be
 *    auto-cleared.
 * 4. GENERATION-SAFE — {@link extractInlineBlockerGeneration}`(c.body)`
 *    is a non-null value `<= currentGeneration`. A NULL/unparseable
 *    generation (a pre-90.3 comment predating this whole mechanism, or a
 *    corrupted one) is NEVER deleted here — this function cannot confirm
 *    it is safe to remove, so it fails closed by leaving it in place (a
 *    documented residual, not a gap: legacy pre-90.3 comments are
 *    near-zero, since the generation-marker mechanism only just shipped,
 *    and a corrupted marker is this workflow's OWN trusted output, never
 *    adversarial content).
 *
 * WHY THE GENERATION GUARD MATTERS: this workflow's own dedicated,
 * serialized concurrency group (`cancel-in-progress: false`) means two
 * publish runs for the same PR never execute concurrently, but an OLDER
 * run can still be the one QUEUED to run after a NEWER one already
 * posted a comment for a genuinely new closing reference. Comparing
 * generations means an older run only ever deletes what it can PROVE is
 * at least as old as itself, never something a newer run already
 * established.
 *
 * NO CALLER-SIDE RELIABILITY GATE NEEDED (unlike the prior, reverted
 * verdict-keep-set design): this function's own membership test depends
 * ONLY on `currentlyClosingIssueNumbers` (the CURRENT, already-verified
 * PR body — see this function's own caller, `publish-spec-grounding-
 * verdict.mts`'s `publishSummary`) and each comment's own generation —
 * NEITHER of which is affected by whether THIS run's own new blockers
 * happened to post inline successfully. Team-lead's Fork-1 ruling: call
 * this UNCONDITIONALLY on every `hasCriteria: true` publish, regardless
 * of this run's own blocker count or posting outcome.
 *
 * RE-VERIFIES `currentlyClosingIssueNumbers` ITSELF, AFTER pagination,
 * IMMEDIATELY BEFORE THE FIRST DELETE (F1-S9 slice 90.4, PR #95 review
 * round 4, Codex, P1, cid 3625635476 — round 3's own re-verify, in the
 * CALLER, ran before this function was ever invoked, leaving this
 * function's own {@link findExistingInlineComments} pagination — a
 * multi-page GET loop, not instantaneous — still inside the TOCTOU
 * window). Re-fetching and re-parsing the body here, after pagination
 * completes and immediately before the delete loop below, narrows that
 * window to the delete loop's own execution time — as tight as this
 * mechanism can get without true API-level atomicity, which GitHub's
 * REST API does not offer across multiple separate calls.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param currentlyClosingIssueNumbers - Every issue number this PR's
 *   CURRENT (already head/base-verified) body referenced with a
 *   `closing`-kind keyword, AT THE TIME the caller took this snapshot —
 *   re-verified fresh by this function itself before it is trusted for
 *   any delete (see above).
 * @param currentGeneration - This run's own validated, canonicalized
 *   `github.run_number`, as a number.
 * @returns `{ ok: true, deletedCount }` once every eligible de-referenced
 *   comment has been deleted (`deletedCount` may be `0`); `{ ok: false,
 *   reason: "closing-references-changed" }` if the re-verify found the
 *   PR's closing-kind reference set no longer matches
 *   `currentlyClosingIssueNumbers` — NO delete is attempted in that case,
 *   for ANY comment, since the caller's own posting decisions (computed
 *   against the SAME now-stale snapshot) are equally suspect; the caller
 *   is expected to treat this as a fail-closed signal for the WHOLE run,
 *   not merely skip this one function's own work (see
 *   `publish-spec-grounding-verdict.mts`'s own `publishSummary`).
 */
export async function deleteDeReferencedInlineBlockerComments(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  currentlyClosingIssueNumbers: ReadonlySet<number>,
  currentGeneration: number,
): Promise<
  { readonly ok: true; readonly deletedCount: number } | { readonly ok: false; readonly reason: "closing-references-changed" }
> {
  const existing = await findExistingInlineComments(token, owner, repo, prNumber);

  const pr = await githubRequest<{ readonly body: string | null }>(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
  );
  const freshClosingIssueNumbers = new Set(
    parseLinkedIssueReferences(pr.body ?? "", `${owner}/${repo}`)
      .filter((reference) => reference.kind === "closing")
      .map((reference) => reference.issueNumber),
  );
  const unchanged =
    freshClosingIssueNumbers.size === currentlyClosingIssueNumbers.size &&
    [...freshClosingIssueNumbers].every((issueNumber) => currentlyClosingIssueNumbers.has(issueNumber));
  if (!unchanged) {
    return { ok: false, reason: "closing-references-changed" };
  }

  const deReferenced = existing.filter((c) => {
    if (c.authorType !== "Bot" || c.authorLogin !== SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN) {
      return false;
    }
    const issueNumber = extractIssueNumberFromInlineBlockerMarker(c.body);
    if (issueNumber === null) {
      return false; // Not an individual issue/criterion marker (aggregate, generation-only, or not ours) -- conservative, never delete.
    }
    if (currentlyClosingIssueNumbers.has(issueNumber)) {
      return false; // Still closing-referenced -- verdict-satisfied stays human-resolved (#801).
    }
    const generation = extractInlineBlockerGeneration(c.body);
    if (generation === null || generation > currentGeneration) {
      return false;
    }
    return true;
  });
  let deletedCount = 0;
  for (const comment of deReferenced) {
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
