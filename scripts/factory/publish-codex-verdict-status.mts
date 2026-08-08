import { githubRequest, requireEnv } from "./github-api.mts";
import {
  collectAndPlan,
  collectSignalInput,
  MAX_STATUS_DESCRIPTION_LENGTH,
  type RawCollectionInput,
  type RawIssueComment,
  type RawPrReviewComment,
  type RawPullRequest,
  type RawReaction,
  type RawReview,
  type RawReviewComment,
  type RawTimelineEvent,
  type ReactionSubject,
} from "./codex-signal-collection-logic.mts";
import { FULL_SHA_PATTERN, isPlainRecord } from "./codex-signal-schema.mts";
import {
  filterAuthorizedTriggerComments,
  filterRootReviewComments,
  namespacedStatusContext,
  toNamespacedPlan,
  type NamespacedStatusPlan,
} from "./publish-codex-verdict-status-logic.mts";

export const MAX_PAGES = 50;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const STATUS_STATES = new Set(["success", "failure", "pending"]);
const BOUNDARY_TIMELINE_EVENT_TYPES = new Set([
  "ready_for_review",
  "convert_to_draft",
  "head_ref_force_pushed",
  "head_ref_deleted",
  "head_ref_restored",
]);

export type GithubRequest = <T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

interface PageResult<T> {
  readonly records: readonly T[];
  readonly complete: boolean;
}

interface PullRequestResponse {
  readonly head?: unknown;
  readonly draft?: unknown;
  readonly created_at?: unknown;
}

function field(value: unknown, name: string): unknown {
  return isPlainRecord(value) ? value[name] : undefined;
}

export function boundaryTimelineEvents(
  raw: readonly RawTimelineEvent[],
): RawTimelineEvent[] {
  return raw.filter((record) =>
    typeof record.event === "string" &&
    BOUNDARY_TIMELINE_EVENT_TYPES.has(record.event)
  );
}

async function fetchPages<T>(
  request: GithubRequest,
  token: string,
  path: string,
  map: (record: unknown) => T,
): Promise<PageResult<T>> {
  const records: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await request<unknown>(
      token,
      "GET",
      `${path}?per_page=100&page=${page}`,
    );
    if (!Array.isArray(response)) {
      throw new Error(`GitHub API ${path} returned a non-array page`);
    }
    records.push(...response.map(map));
    if (response.length < 100) return { records, complete: true };
  }
  return { records, complete: false };
}

function pullRequestSnapshot(
  response: PullRequestResponse,
  repository: string,
): RawPullRequest {
  const head = field(response, "head");
  const headRepo = field(head, "repo");
  const headRepoFullName = field(headRepo, "full_name");
  return {
    headSha: field(head, "sha"),
    isDraft: field(response, "draft"),
    headRepoIsSameRepo: typeof headRepoFullName === "string"
      ? headRepoFullName === repository
      : undefined,
    createdAt: field(response, "created_at"),
  };
}

function targetUrl(repository: string): string | undefined {
  const runId = process.env.GITHUB_RUN_ID;
  return runId !== undefined && POSITIVE_DECIMAL_PATTERN.test(runId)
    ? `https://github.com/${repository}/actions/runs/${runId}`
    : undefined;
}

export function assertPostableStatus(
  snapshotHeadSha: unknown,
  final: NamespacedStatusPlan,
  prNumber: number,
): asserts snapshotHeadSha is string {
  if (typeof snapshotHeadSha !== "string" ||
    !FULL_SHA_PATTERN.test(snapshotHeadSha)) {
    throw new Error("refusing status POST: snapshot head SHA is not a full SHA");
  }
  if (final.kind !== "write") {
    throw new Error("refusing status POST: plan is not writable");
  }
  if (final.context !== namespacedStatusContext(prNumber)) {
    throw new Error("refusing status POST: status context is not PR-namespaced");
  }
  if (!STATUS_STATES.has(final.state)) {
    throw new Error("refusing status POST: status state is outside the closed set");
  }
  if (final.description.length > MAX_STATUS_DESCRIPTION_LENGTH) {
    throw new Error("refusing status POST: description exceeds GitHub's limit");
  }
}

async function fetchReactions(
  request: GithubRequest,
  token: string,
  repositoryPath: string,
  prNumber: number,
  subject: ReactionSubject,
): Promise<PageResult<RawReaction>> {
  const path = subject.kind === "pull-request"
    ? `${repositoryPath}/issues/${prNumber}/reactions`
    : `${repositoryPath}/issues/comments/${subject.commentId}/reactions`;
  return fetchPages(request, token, path, (record) => ({
    authorLogin: field(field(record, "user"), "login"),
    content: field(record, "content"),
    createdAt: field(record, "created_at"),
  }));
}

async function postStatus(
  request: GithubRequest,
  token: string,
  repositoryPath: string,
  snapshotHeadSha: unknown,
  final: Extract<NamespacedStatusPlan, { kind: "write" }>,
  prNumber: number,
  url: string | undefined,
): Promise<void> {
  assertPostableStatus(snapshotHeadSha, final, prNumber);
  await request(
    token,
    "POST",
    `${repositoryPath}/statuses/${snapshotHeadSha}`,
    {
      state: final.state,
      context: final.context,
      description: final.description,
      ...(url === undefined ? {} : { target_url: url }),
    },
  );
}

export async function main(request: GithubRequest = githubRequest): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be canonical "owner/repo"');
  }
  const [owner, repo] = repository.split("/", 2);
  const prNumberRaw = requireEnv("TARGET_PR_NUMBER");
  if (!POSITIVE_DECIMAL_PATTERN.test(prNumberRaw)) {
    throw new Error("TARGET_PR_NUMBER must be a canonical positive decimal integer");
  }
  const prNumber = Number(prNumberRaw);
  if (!Number.isSafeInteger(prNumber)) {
    throw new Error("TARGET_PR_NUMBER exceeds JavaScript's safe integer range");
  }

  const pullResponse = await request<PullRequestResponse>(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
  );
  const pullRequest = pullRequestSnapshot(pullResponse, repository);
  const issuePath = `/repos/${owner}/${repo}/issues/${prNumber}`;
  const pullPath = `/repos/${owner}/${repo}/pulls/${prNumber}`;
  const repositoryPath = `/repos/${owner}/${repo}`;
  const url = targetUrl(repository);

  try {
    const [timeline, reviews, pullComments, issueComments] =
      await Promise.all([
        fetchPages<RawTimelineEvent>(request, token, `${issuePath}/timeline`, (record) => ({
          event: field(record, "event"), createdAt: field(record, "created_at"),
        })),
        fetchPages<RawReview>(request, token, `${pullPath}/reviews`, (record) => ({
          authorLogin: field(field(record, "user"), "login"),
          commitSha: field(record, "commit_id"),
          submittedAt: field(record, "submitted_at"),
          reviewId: field(record, "id"),
          state: field(record, "state"),
        })),
        fetchPages<unknown>(request, token, `${pullPath}/comments`, (record) => record),
        fetchPages<RawIssueComment>(request, token, `${issuePath}/comments`, (record) => ({
          authorLogin: field(field(record, "user"), "login"),
          body: field(record, "body"), createdAt: field(record, "created_at"),
          id: field(record, "id"),
        })),
      ]);
    const rawReviewComments: PageResult<RawReviewComment & { inReplyToId?: unknown }> = {
      records: pullComments.records.map((record) => ({
        pullRequestReviewId: field(record, "pull_request_review_id"),
        inReplyToId: field(record, "in_reply_to_id"),
      })),
      complete: pullComments.complete,
    };
    const prReviewComments: PageResult<RawPrReviewComment> = {
      records: pullComments.records.map((record) => ({
        authorLogin: field(field(record, "user"), "login"),
        body: field(record, "body"), createdAt: field(record, "created_at"),
        id: field(record, "id"),
      })),
      complete: pullComments.complete,
    };
    const roots = filterRootReviewComments(rawReviewComments.records);
    const authorizedIssueComments = filterAuthorizedTriggerComments(issueComments.records);
    const raw0: RawCollectionInput = {
      pullRequest,
      evaluatedAt: new Date().toISOString(),
      timelineEvents: boundaryTimelineEvents(timeline.records),
      reviews: reviews.records,
      reviewComments: roots.records,
      issueComments: authorizedIssueComments,
      prReviewComments: prReviewComments.records,
      sourceComplete: {
        timelineEvents: timeline.complete,
        reviews: reviews.complete,
        reviewComments: rawReviewComments.complete && roots.complete,
        issueComments: issueComments.complete,
        prReviewComments: prReviewComments.complete,
      },
    };
    const phase1 = collectSignalInput(raw0);
    let plan;
    if (phase1.kind === "ready") {
      const reactions = await fetchReactions(
        request,
        token,
        repositoryPath,
        prNumber,
        phase1.reactionSubject,
      );
      plan = collectAndPlan({
        ...raw0,
        reactions: reactions.records,
        reactionSubject: phase1.reactionSubject,
        sourceComplete: { ...raw0.sourceComplete, reactions: reactions.complete },
      });
    } else {
      plan = collectAndPlan(raw0);
    }
    const final = toNamespacedPlan(plan, prNumber);
    if (final.kind === "no-write") {
      if (final.reason === "fork-head") {
        console.log(`Skipping advisory status for fork PR #${prNumber}`);
        return;
      }
      console.error(`Cannot publish advisory status for PR #${prNumber}: ${final.reason}`);
      process.exitCode = 1;
      return;
    }

    await postStatus(
      request,
      token,
      repositoryPath,
      pullRequest.headSha,
      final,
      prNumber,
      url,
    );
  } catch (error) {
    console.error(`Codex advisory evaluation failed for PR #${prNumber}:`, error);
    process.exitCode = 1;
    if (typeof pullRequest.headSha !== "string" ||
      !FULL_SHA_PATTERN.test(pullRequest.headSha) ||
      pullRequest.headRepoIsSameRepo !== true) {
      return;
    }
    const context = namespacedStatusContext(prNumber);
    /* v8 ignore next -- prNumber has already passed positive-safe-integer validation. */
    if (context === null) return;
    const retraction: Extract<NamespacedStatusPlan, { kind: "write" }> = {
      kind: "write",
      state: "pending",
      context,
      description: "pending reasons=evaluation-failed; advice=retry",
    };
    try {
      await postStatus(
        request,
        token,
        repositoryPath,
        pullRequest.headSha,
        retraction,
        prNumber,
        url,
      );
    } catch (retractionError) {
      console.error(`Could not retract advisory status for PR #${prNumber}:`, retractionError);
    }
  }
}

/* v8 ignore start -- exercised by the workflow process, not import-based tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("publish-codex-verdict-status failed:", err);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
