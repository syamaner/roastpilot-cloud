import { writeFileSync } from "node:fs";

import {
  deriveIssueCommandAuthorization,
} from "./derive-issue-command-authorization.mts";
import { computeApprovedRevision } from "./approve-revision.mts";
import { githubRequest, requireEnv } from "./github-api.mts";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;

export type GithubRequest = <T>(
  token: string,
  method: string,
  path: string,
) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePositiveInteger(name: string, raw: string): number {
  if (!POSITIVE_DECIMAL_PATTERN.test(raw)) {
    throw new Error(`${name} must be a canonical positive decimal integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} exceeds the JavaScript safe integer range`);
  }
  return value;
}

function fetchedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`GitHub API returned a malformed ${label}`);
  }
  return value;
}

function appendOutput(path: string, name: string, value: string): void {
  writeFileSync(path, `${name}=${value}\n`, { encoding: "utf8", flag: "a" });
}

export async function main(request: GithubRequest): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repositoryName = requireEnv("GITHUB_REPOSITORY");
  if (!REPOSITORY_PATTERN.test(repositoryName)) {
    throw new Error('GITHUB_REPOSITORY must be canonical "owner/repo"');
  }
  const issueNumber = parsePositiveInteger(
    "TARGET_ISSUE_NUMBER",
    requireEnv("TARGET_ISSUE_NUMBER"),
  );
  const commentId = parsePositiveInteger("COMMENT_ID", requireEnv("COMMENT_ID"));
  const outputPath = requireEnv("GITHUB_OUTPUT");
  const [owner, repo] = repositoryName.split("/", 2) as [string, string];
  const repositoryPath = `/repos/${owner}/${repo}`;

  const [rawComment, rawIssue, rawRepository] = await Promise.all([
    request<unknown>(token, "GET", `${repositoryPath}/issues/comments/${commentId}`),
    request<unknown>(token, "GET", `${repositoryPath}/issues/${issueNumber}`),
    request<unknown>(token, "GET", repositoryPath),
  ]);
  const comment = fetchedRecord(rawComment, "issue comment");
  const issue = fetchedRecord(rawIssue, "issue");
  const repository = fetchedRecord(rawRepository, "repository");
  if (!isRecord(comment.user) || typeof comment.body !== "string") {
    throw new TypeError("GitHub API returned a malformed issue comment");
  }

  const authorization = deriveIssueCommandAuthorization({
    issue,
    repository,
    author: comment.user,
    commentBody: comment.body,
    githubRepository: repositoryName,
  });
  if (!authorization.proceed) {
    appendOutput(outputPath, "proceed", "false");
    return;
  }
  const approvedRevision = authorization.command.verb === "approve"
    ? computeApprovedRevision(issue.body as string)
    : null;
  appendOutput(outputPath, "proceed", "true");
  appendOutput(outputPath, "verb", authorization.command.verb);
  if (approvedRevision !== null) {
    appendOutput(outputPath, "approved_revision", approvedRevision);
  }
}

/* v8 ignore next 3 -- the CLI-only branch is unreachable through module-import tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  await main(githubRequest);
}
