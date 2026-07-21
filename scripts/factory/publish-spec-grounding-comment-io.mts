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
      reasons.map((r) => `  - ${r}`).join("\n"),
  );
}
