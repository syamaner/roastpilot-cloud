import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { githubRequest, requireEnv } from "./github-api.mts";
import { isPullRequestIssue } from "./owner-command-logic.mts";
import {
  buildQuestionResponseBody,
  buildResponseMarker,
  buildTaskResponseBody,
  deriveResponseAuthorization,
  hasExistingResponse,
  validateAnswerArtifact,
} from "./post-owner-command-response-logic.mts";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const MAX_COMMENT_PAGES = 50;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STALE_SNAPSHOT_NOTICE =
  "the command or the pull request changed after this run started; no answer was posted — re-issue the command";
const TRUNCATED_INPUT_NOTICE =
  "_Note: this response was generated from a truncated question and/or pull-request diff; some content was not available to the reviewer._";

export type GithubRequest = <T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fetchedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`GitHub API returned a malformed ${label}`);
  }
  return value;
}

function parsePositiveInteger(name: string, raw: string): number {
  if (!POSITIVE_DECIMAL_PATTERN.test(raw)) {
    throw new Error(`${name} must be a canonical positive decimal integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} exceeds JavaScript's safe integer range`);
  }
  return value;
}

function readAnswerArtifact(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error: unknown) {
    if (
      isRecord(error) &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

type QuestionBinding = {
  readonly version: 3;
  readonly prHeadSha: string;
  readonly prBaseSha: string;
  readonly titleSha256: string;
  readonly bodySha256: string;
  readonly commandPayloadSha256: string;
  readonly questionTruncated: boolean;
  readonly diffTruncated: boolean;
};

function readQuestionBinding(path: string): QuestionBinding {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "bodySha256,commandPayloadSha256,diffTruncated,prBaseSha,prHeadSha,questionTruncated,titleSha256,version" ||
    parsed.version !== 3 ||
    typeof parsed.prHeadSha !== "string" ||
    !FULL_SHA_PATTERN.test(parsed.prHeadSha) ||
    typeof parsed.prBaseSha !== "string" ||
    !FULL_SHA_PATTERN.test(parsed.prBaseSha) ||
    typeof parsed.titleSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.titleSha256) ||
    typeof parsed.bodySha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.bodySha256) ||
    typeof parsed.commandPayloadSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.commandPayloadSha256) ||
    typeof parsed.questionTruncated !== "boolean" ||
    typeof parsed.diffTruncated !== "boolean"
  ) {
    throw new TypeError("question binding artifact is malformed");
  }
  return {
    version: 3,
    prHeadSha: parsed.prHeadSha,
    prBaseSha: parsed.prBaseSha,
    titleSha256: parsed.titleSha256,
    bodySha256: parsed.bodySha256,
    commandPayloadSha256: parsed.commandPayloadSha256,
    questionTruncated: parsed.questionTruncated,
    diffTruncated: parsed.diffTruncated,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildStaleSnapshotNotice(commentId: number): string {
  return `${STALE_SNAPSHOT_NOTICE}\n\n${buildResponseMarker(commentId)}`;
}

function appendTrustedNoticeBeforeMarker(
  body: string,
  commentId: number,
  notice: string,
): string {
  const markerSuffix = `\n\n${buildResponseMarker(commentId)}`;
  /* v8 ignore next -- the sole input is the response builder whose final-marker contract is asserted directly. */
  if (!body.endsWith(markerSuffix)) {
    throw new Error("question response body is missing its final marker");
  }
  return `${body.slice(0, -markerSuffix.length)}\n\n${notice}${markerSuffix}`;
}

async function fetchAllComments(
  request: GithubRequest,
  token: string,
  issuePath: string,
): Promise<unknown[]> {
  const comments: unknown[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const response = await request<unknown>(
      token,
      "GET",
      `${issuePath}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(response)) {
      // Preserve hasExistingResponse's authoritative malformed-array failure.
      hasExistingResponse(response, 1);
      /* v8 ignore next -- the helper above always throws for a non-array. */
      throw new TypeError("GitHub API returned malformed issue comments");
    }
    comments.push(...response);
    if (response.length < 100) return comments;
  }
  throw new Error("issue-comment pagination exceeded its fail-closed cap");
}

export async function main(request: GithubRequest = githubRequest): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be canonical "owner/repo"');
  }
  const prNumber = parsePositiveInteger(
    "TARGET_PR_NUMBER",
    requireEnv("TARGET_PR_NUMBER"),
  );
  const commentId = parsePositiveInteger("COMMENT_ID", requireEnv("COMMENT_ID"));
  const answerArtifactPath = requireEnv("ANSWER_ARTIFACT_PATH");
  const bindingArtifactPath = requireEnv("BINDING_ARTIFACT_PATH");
  const intakeVerb = requireEnv("INTAKE_VERB");
  if (intakeVerb !== "question" && intakeVerb !== "task") {
    throw new Error('INTAKE_VERB must be exactly "question" or "task"');
  }
  const runId = requireEnv("GITHUB_RUN_ID");
  if (!POSITIVE_DECIMAL_PATTERN.test(runId)) {
    throw new Error("GITHUB_RUN_ID must be a canonical positive decimal integer");
  }
  const [owner, repo] = repository.split("/", 2) as [string, string];
  const repositoryPath = `/repos/${owner}/${repo}`;
  const issuePath = `${repositoryPath}/issues/${prNumber}`;

  const [rawComment, rawIssue] = await Promise.all([
    request<unknown>(token, "GET", `${repositoryPath}/issues/comments/${commentId}`),
    request<unknown>(token, "GET", issuePath),
  ]);
  const comment = fetchedRecord(rawComment, "issue comment");
  const issue = fetchedRecord(rawIssue, "issue");
  if (typeof comment.body !== "string" || !isRecord(comment.user)) {
    throw new TypeError("GitHub API returned a malformed issue comment");
  }
  // Ordinary issue comments are an expected trigger class; avoid the PR-only
  // endpoint (and its expected 404) until the issue marker proves this is a PR.
  if (!isPullRequestIssue(issue)) {
    console.log(`Owner-command run ${runId} is ineligible; no response posted.`);
    return;
  }
  const pullRequest = fetchedRecord(
    await request<unknown>(token, "GET", `${repositoryPath}/pulls/${prNumber}`),
    "pull request",
  );
  const authorization = deriveResponseAuthorization({
    issue,
    pullRequest,
    author: comment.user,
    commentBody: comment.body,
    githubRepository: repository,
  });
  if (!authorization.proceed) {
    console.log(`Owner-command run ${runId} is ineligible; no response posted.`);
    return;
  }

  const comments = await fetchAllComments(request, token, issuePath);
  if (hasExistingResponse(comments, commentId)) {
    console.log(`Owner-command run ${runId} already has a response; skipping.`);
    return;
  }

  let body: string;
  // MUTATION-CHECK: removing this directional transition guard makes an
  // intake-task/current-question run read artifacts that were never created.
  if (intakeVerb === "task" && authorization.command.verb === "question") {
    body = buildStaleSnapshotNotice(commentId);
  } else if (authorization.command.verb === "task") {
    // A question→task edit is safe to acknowledge authoritatively: the fixed
    // task response consumes no stale answer artifact or question snapshot.
    body = buildTaskResponseBody(commentId);
  } else {
    const binding = readQuestionBinding(bindingArtifactPath);
    const currentHead = pullRequest.head;
    const currentBase = pullRequest.base;
    if (
      !isRecord(currentHead) ||
      typeof currentHead.sha !== "string" ||
      !FULL_SHA_PATTERN.test(currentHead.sha) ||
      !isRecord(currentBase) ||
      typeof currentBase.sha !== "string" ||
      !FULL_SHA_PATTERN.test(currentBase.sha) ||
      typeof pullRequest.title !== "string" ||
      (typeof pullRequest.body !== "string" && pullRequest.body !== null)
    ) {
      throw new TypeError("GitHub API returned a malformed pull-request snapshot");
    }
    // MUTATION-CHECK: removing any comparison makes its independent drift
    // regression post an answer generated from a stale snapshot instead.
    if (
      currentHead.sha !== binding.prHeadSha ||
      currentBase.sha !== binding.prBaseSha ||
      sha256(pullRequest.title) !== binding.titleSha256 ||
      sha256(pullRequest.body ?? "") !== binding.bodySha256 ||
      sha256(authorization.command.payload) !== binding.commandPayloadSha256 ||
      authorization.command.truncated !== binding.questionTruncated
    ) {
      body = buildStaleSnapshotNotice(commentId);
    } else {
      const artifact = validateAnswerArtifact(readAnswerArtifact(answerArtifactPath));
      if (!artifact.ok) {
        throw new Error(`question answer artifact is ${artifact.reason}`);
      }
      body = buildQuestionResponseBody({
        commentId,
        command: {
          ...authorization.command,
          verb: authorization.command.verb,
        },
        answerText: artifact.text,
        fullDetailLocation:
          `the owner-question-answer artifact from workflow run ${runId}`,
      });
      // MUTATION-CHECK: dropping this trusted insertion makes the independent
      // question/diff truncation tests lose their publisher-owned disclosure.
      if (binding.questionTruncated || binding.diffTruncated) {
        body = appendTrustedNoticeBeforeMarker(
          body,
          commentId,
          TRUNCATED_INPUT_NOTICE,
        );
      }
    }
  }

  await request(
    token,
    "POST",
    `${issuePath}/comments`,
    { body },
  );
  console.log(`Owner-command run ${runId} posted one ${authorization.command.verb} response.`);
}

/* v8 ignore start -- exercised by the workflow process, not import-based tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error("post-owner-command-response failed:", error);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
