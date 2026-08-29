import { writeFileSync } from "node:fs";

import {
  deriveIssueCommandAuthorization,
} from "./derive-issue-command-authorization.mts";
import { canonicalIssueRevision } from "./approve-revision.mts";
import { githubGraphql, githubRequest, requireEnv } from "./github-api.mts";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;

export type GithubRequest = <T>(
  token: string,
  method: string,
  path: string,
) => Promise<T>;

export type GithubGraphql = <T>(
  token: string,
  query: string,
  variables: Readonly<Record<string, unknown>>,
) => Promise<T>;

const ISSUE_BODY_EDIT_HISTORY_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){userContentEdits(first:100){nodes{editedAt}pageInfo{hasNextPage}}}}}";
const ISSUE_TITLE_RENAME_HISTORY_QUERY =
  "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){timelineItems(itemTypes:[RENAMED_TITLE_EVENT],first:100){nodes{... on RenamedTitleEvent{createdAt}}pageInfo{hasNextPage}}}}}";
const ISO_8601_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

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

function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const match = ISO_8601_TIMESTAMP_PATTERN.exec(raw);
  if (!match) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw,
    offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = offsetHourRaw === undefined ? 0 : Number(offsetHourRaw);
  const offsetMinute = offsetMinuteRaw === undefined
    ? 0
    : Number(offsetMinuteRaw);
  /* v8 ignore next -- GitHub event timestamps are contemporary UTC values; the centennial arm has no live-corpus instance. */
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]! ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  const timestamp = Date.parse(raw);
  /* v8 ignore next -- the strict ISO match plus explicit calendar, clock, and offset bounds make Date.parse finite. */
  return Number.isFinite(timestamp) ? timestamp : null;
}

function bodyEditTimestamps(raw: unknown): readonly number[] | null {
  if (!isRecord(raw)) return null;
  const repository = raw.repository;
  if (!isRecord(repository) || !isRecord(repository.issue)) return null;
  const edits = repository.issue.userContentEdits;
  if (
    !isRecord(edits) ||
    !Array.isArray(edits.nodes) ||
    !isRecord(edits.pageInfo) ||
    typeof edits.pageInfo.hasNextPage !== "boolean" ||
    edits.pageInfo.hasNextPage
  ) {
    return null;
  }
  const timestamps: number[] = [];
  for (const node of edits.nodes) {
    if (!isRecord(node)) return null;
    const timestamp = parseTimestamp(node.editedAt);
    if (timestamp === null) return null;
    timestamps.push(timestamp);
  }
  return timestamps;
}

function titleRenameTimestamps(raw: unknown): readonly number[] | null {
  if (!isRecord(raw)) return null;
  const repository = raw.repository;
  if (!isRecord(repository) || !isRecord(repository.issue)) return null;
  const renames = repository.issue.timelineItems;
  if (
    !isRecord(renames) ||
    !Array.isArray(renames.nodes) ||
    !isRecord(renames.pageInfo) ||
    typeof renames.pageInfo.hasNextPage !== "boolean" ||
    renames.pageInfo.hasNextPage
  ) {
    return null;
  }
  const timestamps: number[] = [];
  for (const node of renames.nodes) {
    if (!isRecord(node)) return null;
    const timestamp = parseTimestamp(node.createdAt);
    if (timestamp === null) return null;
    timestamps.push(timestamp);
  }
  return timestamps;
}

export async function main(
  request: GithubRequest,
  graphql: GithubGraphql = githubGraphql,
): Promise<void> {
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
  if (authorization.command.verb === "approve") {
    const commentCreatedAt = parseTimestamp(comment.created_at);
    if (
      commentCreatedAt === null ||
      typeof issue.title !== "string" ||
      typeof issue.body !== "string"
    ) {
      appendOutput(outputPath, "proceed", "false");
      return;
    }
    let rawEditHistory: unknown;
    let rawRenameHistory: unknown;
    try {
      [rawEditHistory, rawRenameHistory] = await Promise.all([
        graphql<unknown>(token, ISSUE_BODY_EDIT_HISTORY_QUERY, {
          owner,
          repo,
          number: issueNumber,
        }),
        graphql<unknown>(token, ISSUE_TITLE_RENAME_HISTORY_QUERY, {
          owner,
          repo,
          number: issueNumber,
        }),
      ]);
    } catch {
      appendOutput(outputPath, "proceed", "false");
      return;
    }
    const editTimestamps = bodyEditTimestamps(rawEditHistory);
    const renameTimestamps = titleRenameTimestamps(rawRenameHistory);
    if (
      editTimestamps === null ||
      renameTimestamps === null ||
      editTimestamps.some((editedAt) => editedAt >= commentCreatedAt) ||
      renameTimestamps.some((renamedAt) => renamedAt >= commentCreatedAt)
    ) {
      appendOutput(outputPath, "proceed", "false");
      return;
    }
    appendOutput(outputPath, "proceed", "true");
    appendOutput(outputPath, "verb", authorization.command.verb);
    appendOutput(
      outputPath,
      "approved_revision",
      canonicalIssueRevision(issue.title, issue.body),
    );
    return;
  }
  appendOutput(outputPath, "proceed", "true");
  appendOutput(outputPath, "verb", authorization.command.verb);
}

/* v8 ignore next 3 -- the CLI-only branch is unreachable through module-import tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  await main(githubRequest, githubGraphql);
}
