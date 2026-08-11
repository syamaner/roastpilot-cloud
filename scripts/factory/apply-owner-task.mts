import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { GithubApiError, githubRequest, requireEnv } from "./github-api.mts";
import { isPullRequestIssue } from "./owner-command-logic.mts";
import {
  MAX_TRAILER_COMMIT_WINDOW,
  buildTaskApplyMarker,
  buildTaskTrailer,
  decideOwnerTaskPatch,
  hasExistingTaskApply,
  neutralizeTaskMarkers,
  parseTaskBinding,
  type OwnerTaskGamingAnnotations,
  type OwnerTaskPatchAnalysisResult,
  type OwnerTaskPatchDecision,
  type OwnerTaskPatchDecisionInput,
} from "./owner-task-patch-logic.mts";
import {
  MAX_PATCH_BYTES,
  parseAuthoritativePatchAnalysis,
} from "./patch-analysis-format.mts";
import {
  MAX_ANSWER_ARTIFACT_BYTES,
  deriveResponseAuthorization,
} from "./post-owner-command-response-logic.mts";
import { renderBoundedUntrustedReason } from "./untrusted-text.mts";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA_FILE_PATTERN = /^([0-9a-f]{40})(?:\n)?$/;
const REF_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
const MAX_COMMENT_PAGES = 50;
const RESPONSE_BOT_LOGIN = "github-actions[bot]";
const MAX_NOTICE_REASONS = 10;
const MAX_NOTICE_REASON_CODE_POINTS = 1000;
export const MAX_OWNER_TASK_COMMENT_BYTES = 32 * 1024;
export const MAX_OWNER_TASK_ANALYSIS_FILE_BYTES = MAX_PATCH_BYTES;
export const MAX_OWNER_TASK_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_FAILED_ANALYSIS_BYTES = 64 * 1024;
export const MAX_PLAN_ANNOTATIONS_BYTES = 64 * 1024;

const ANALYSIS_FILES = {
  failed: "failed",
  baseSha: "base_sha",
  treeOid: "tree_oid",
  nameStatus: "name_status",
  numstat: "numstat",
  diff: "diff",
} as const;

export type GithubRequest = <T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

type ApplyPhase = "prepare" | "decide" | "finalize";

interface Environment {
  readonly phase: ApplyPhase;
  readonly token: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly commentId: number;
  readonly runId: string;
  readonly bindingArtifactPath: string;
  readonly patchArtifactPath: string;
  readonly analysisDir: string;
  readonly planDir: string;
  readonly outputPath: string;
  readonly repositoryPath: string;
  readonly issuePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function readEnvironment(): Environment {
  const rawPhase = requireEnv("APPLY_PHASE");
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const prNumber = parsePositiveInteger(
    "TARGET_PR_NUMBER",
    requireEnv("TARGET_PR_NUMBER"),
  );
  const commentId = parsePositiveInteger("COMMENT_ID", requireEnv("COMMENT_ID"));
  const runId = requireEnv("GITHUB_RUN_ID");
  const bindingArtifactPath = requireEnv("BINDING_ARTIFACT_PATH");
  const patchArtifactPath = requireEnv("PATCH_ARTIFACT_PATH");
  const analysisDir = requireEnv("ANALYSIS_DIR");
  const planDir = requireEnv("PLAN_DIR");
  const outputPath = requireEnv("GITHUB_OUTPUT");
  if (rawPhase !== "prepare" && rawPhase !== "decide" && rawPhase !== "finalize") {
    throw new Error('APPLY_PHASE must be exactly "prepare", "decide", or "finalize"');
  }
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be canonical "owner/repo"');
  }
  if (!POSITIVE_DECIMAL_PATTERN.test(runId)) {
    throw new Error("GITHUB_RUN_ID must be a canonical positive decimal integer");
  }
  const [owner, repo] = repository.split("/", 2) as [string, string];
  const repositoryPath = `/repos/${owner}/${repo}`;
  const issuePath = `${repositoryPath}/issues/${prNumber}`;
  return {
    phase: rawPhase,
    token,
    repository,
    prNumber,
    commentId,
    runId,
    bindingArtifactPath,
    patchArtifactPath,
    analysisDir,
    planDir,
    outputPath,
    repositoryPath,
    issuePath,
  };
}

function appendOutput(path: string, name: string, value: string): void {
  writeFileSync(path, `${name}=${value}\n`, { encoding: "utf8", flag: "a" });
}

function fetchedRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`GitHub API returned a malformed ${label}`);
  }
  return value;
}

function commentFields(comment: Record<string, unknown>): {
  readonly body: string;
  readonly user: Record<string, unknown>;
} {
  if (typeof comment.body !== "string" || !isRecord(comment.user)) {
    throw new TypeError("GitHub API returned a malformed issue comment");
  }
  return { body: comment.body, user: comment.user };
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

type DescriptorReader = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => number;

export function readOptionalCappedFile(
  path: string,
  maxBytes: number,
  readFromDescriptor: DescriptorReader = readSync,
): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new Error(`artifact at ${path} is not a regular file`);
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `artifact at ${path} is ${stats.size} bytes, exceeds the ${maxBytes}-byte limit before read`,
      );
    }
    const bytes = Buffer.alloc(stats.size);
    let offset = 0;
    let bytesRead = 1;
    while (offset < stats.size && bytesRead > 0) {
      bytesRead = readFromDescriptor(fd, bytes, offset, stats.size - offset, null);
      offset += bytesRead;
    }
    if (offset !== stats.size) {
      throw new Error(`artifact at ${path} changed size during read`);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    closeSync(fd);
  }
}

function readRequiredCappedFile(path: string, maxBytes: number): string {
  const value = readOptionalCappedFile(path, maxBytes);
  if (value === null) throw new Error(`required artifact is missing at ${path}`);
  return value;
}

function readBindingArtifact(path: string): string | null {
  return readOptionalCappedFile(path, MAX_ANSWER_ARTIFACT_BYTES);
}

function readShaArtifact(path: string, label: string): string {
  const raw = readRequiredCappedFile(path, 64);
  const match = raw.match(SHA_FILE_PATTERN);
  if (match === null) throw new Error(`${label} artifact is not a full SHA`);
  return match[1]!;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function fetchCommentAndIssue(
  request: GithubRequest,
  environment: Environment,
): Promise<{
  readonly comment: Record<string, unknown>;
  readonly issue: Record<string, unknown>;
  readonly commentBody: string;
  readonly author: Record<string, unknown>;
}> {
  const [rawComment, rawIssue] = await Promise.all([
    request<unknown>(
      environment.token,
      "GET",
      `${environment.repositoryPath}/issues/comments/${environment.commentId}`,
    ),
    request<unknown>(environment.token, "GET", environment.issuePath),
  ]);
  const comment = fetchedRecord(rawComment, "issue comment");
  const issue = fetchedRecord(rawIssue, "issue");
  const { body: commentBody, user: author } = commentFields(comment);
  return { comment, issue, commentBody, author };
}

async function fetchPullRequest(
  request: GithubRequest,
  environment: Environment,
): Promise<Record<string, unknown>> {
  return fetchedRecord(
    await request<unknown>(
      environment.token,
      "GET",
      `${environment.repositoryPath}/pulls/${environment.prNumber}`,
    ),
    "pull request",
  );
}

async function fetchAllComments(
  request: GithubRequest,
  environment: Environment,
): Promise<unknown[]> {
  const comments: unknown[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const response = await request<unknown>(
      environment.token,
      "GET",
      `${environment.issuePath}/comments?per_page=100&page=${page}`,
    );
    if (!Array.isArray(response)) {
      throw new TypeError("GitHub API returned malformed issue comments");
    }
    comments.push(...response);
    if (response.length < 100) return comments;
  }
  throw new Error("issue-comment pagination exceeded its fail-closed cap");
}

function markerAppliedCommit(
  comments: readonly unknown[],
  commentId: number,
  botLogin: string,
): string | null {
  const marker = buildTaskApplyMarker(commentId);
  let newestAppliedCommit: string | null = null;
  for (const comment of comments) {
    if (!isRecord(comment) || !isRecord(comment.user)) continue;
    if (comment.user.login !== botLogin) continue;
    if (typeof comment.body !== "string") {
      throw new TypeError("bot-authored comment has a malformed body");
    }
    const lines = comment.body.trimEnd().split(/\r?\n/);
    if (lines.at(-1)?.trim() !== marker) continue;
    const appliedCommits = lines.flatMap((line) => {
      const match = line.match(/^Applied-Commit: ([0-9a-f]{40})$/);
      return match === null ? [] : [match[1]!];
    });
    if (appliedCommits.length === 1) newestAppliedCommit = appliedCommits[0]!;
  }
  return newestAppliedCommit;
}

type AppliedCommitReachability =
  | { readonly status: "reachable"; readonly commit: Record<string, unknown> }
  | { readonly status: "not-reachable" };

async function checkAppliedCommitReachability(
  request: GithubRequest,
  environment: Environment,
  pullRequest: Record<string, unknown>,
  appliedCommit: string,
): Promise<AppliedCommitReachability> {
  const head = pullRequest.head;
  if (!isRecord(head) || typeof head.sha !== "string" || !/^[0-9a-f]{40}$/.test(head.sha)) {
    throw new TypeError("GitHub API returned a malformed pull-request head SHA");
  }
  let rawAppliedCommit: unknown;
  try {
    rawAppliedCommit = await request<unknown>(
      environment.token,
      "GET",
      `${environment.repositoryPath}/commits/${appliedCommit}`,
    );
  } catch (error: unknown) {
    if (error instanceof GithubApiError && error.status === 404) {
      return { status: "not-reachable" };
    }
    throw error;
  }
  const commit = fetchedRecord(rawAppliedCommit, "applied commit");
  if (commit.sha !== appliedCommit) {
    throw new TypeError("GitHub API returned the wrong applied commit");
  }
  const rawComparison = await request<unknown>(
    environment.token,
    "GET",
    // Compare current head as the base and applied commit as the head: a
    // `behind` result means the applied commit is an ancestor of current head.
    `${environment.repositoryPath}/compare/${head.sha}...${appliedCommit}`,
  );
  const comparison = fetchedRecord(rawComparison, "commit comparison");
  if (comparison.status === "behind" || comparison.status === "identical") {
    return { status: "reachable", commit };
  }
  if (comparison.status === "ahead" || comparison.status === "diverged") {
    return { status: "not-reachable" };
  }
  throw new TypeError("GitHub API returned a malformed commit comparison status");
}

function requireCommitCount(pullRequest: Record<string, unknown>): number {
  const count = pullRequest.commits;
  if (!Number.isSafeInteger(count) || typeof count !== "number" || count < 0) {
    throw new TypeError("GitHub API returned a malformed pull-request commit count");
  }
  if (count > MAX_TRAILER_COMMIT_WINDOW) {
    throw new RangeError(
      `pull request exceeds the ${MAX_TRAILER_COMMIT_WINDOW}-commit replay window`,
    );
  }
  return count;
}

function patchArtifactBytes(path: string): number {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : 0;
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return 0;
    throw error;
  }
}

interface NameStatusShape {
  readonly allPaths: ReadonlySet<string>;
  readonly lineBearingPaths: ReadonlySet<string>;
}

function parseNameStatusShape(raw: string): NameStatusShape {
  const allPaths = new Set<string>();
  const lineBearingPaths = new Set<string>();
  if (raw === "") return { allPaths, lineBearingPaths };
  const fields = raw.split("\0");
  if (fields.pop() !== "") {
    throw new Error("name-status output is not NUL-terminated");
  }
  for (let index = 0; index < fields.length;) {
    const status = fields[index];
    if (
      status === undefined ||
      !/^(?:[ACDMTUXB]|[RC](?:100|0[0-9][0-9]))$/.test(status)
    ) {
      throw new Error("name-status output contains an invalid status");
    }
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    for (let offset = 1; offset <= pathCount; offset += 1) {
      const path = fields[index + offset];
      if (path === undefined || path.length === 0) {
        throw new Error("name-status output contains a missing path");
      }
      allPaths.add(path);
      if (!status.startsWith("C") || offset === 2) {
        lineBearingPaths.add(path);
      }
    }
    index += pathCount + 1;
  }
  return { allPaths, lineBearingPaths };
}

function assertAnalysisStreamsAgree(
  nameStatus: NameStatusShape,
  lineStats: readonly { readonly path: string; readonly sourcePath?: string }[],
): void {
  const numstatPaths = new Set<string>();
  for (const stat of lineStats) {
    numstatPaths.add(stat.path);
    if (stat.sourcePath !== undefined) numstatPaths.add(stat.sourcePath);
  }
  for (const path of numstatPaths) {
    if (!nameStatus.allPaths.has(path)) {
      throw new Error("numstat contains a path absent from name-status");
    }
  }
  for (const path of nameStatus.lineBearingPaths) {
    if (!numstatPaths.has(path)) {
      throw new Error("incomplete numstat: a line-bearing name-status path is absent");
    }
  }
}

export function readPatchAnalysis(analysisDir: string): OwnerTaskPatchAnalysisResult {
  try {
    const failed = readOptionalCappedFile(
      join(analysisDir, ANALYSIS_FILES.failed),
      MAX_FAILED_ANALYSIS_BYTES,
    );
    if (failed !== null) {
      const reasons = failed.split(/\r?\n/).filter((reason) => reason.length > 0);
      return {
        status: "failed",
        reasons: reasons.length > 0
          ? reasons
          : ["patch analysis failed without a diagnostic reason"],
      };
    }
    const baseSha = readShaArtifact(
      join(analysisDir, ANALYSIS_FILES.baseSha),
      "base SHA",
    );
    const treeOid = readShaArtifact(
      join(analysisDir, ANALYSIS_FILES.treeOid),
      "tree OID",
    );
    const nameStatusOutput = readRequiredCappedFile(
      join(analysisDir, ANALYSIS_FILES.nameStatus),
      MAX_OWNER_TASK_ANALYSIS_FILE_BYTES,
    );
    const numstatOutput = readRequiredCappedFile(
      join(analysisDir, ANALYSIS_FILES.numstat),
      MAX_OWNER_TASK_ANALYSIS_FILE_BYTES,
    );
    const diffText = readRequiredCappedFile(
      join(analysisDir, ANALYSIS_FILES.diff),
      MAX_OWNER_TASK_DIFF_BYTES,
    );
    const nameStatus = parseNameStatusShape(nameStatusOutput);
    const analysis = parseAuthoritativePatchAnalysis({
      baseSha,
      treeOid,
      nameStatusOutput,
      numstatOutput,
      diffText,
    });
    assertAnalysisStreamsAgree(nameStatus, analysis.lineStats);
    return { status: "ok", analysis };
  } catch (error: unknown) {
    return {
      status: "failed",
      reasons: [
        `patch analysis artifacts are invalid: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export function buildBoundedMarkedComment(
  heading: string,
  reasons: readonly string[],
  commentId: number,
): string {
  const marker = buildTaskApplyMarker(commentId);
  const rendered = reasons.slice(0, MAX_NOTICE_REASONS).map((reason) =>
    neutralizeTaskMarkers(renderBoundedUntrustedReason(
      reason,
      MAX_NOTICE_REASON_CODE_POINTS,
      "the owner-task workflow artifacts",
    )));
  let selected: string[] = [];
  const compose = (items: readonly string[]): string => {
    const omitted = reasons.length - items.length;
    return [
      heading,
      "",
      `Reasons shown: ${items.length} of ${reasons.length}; comment byte cap: ${MAX_OWNER_TASK_COMMENT_BYTES}.`,
      ...items.map((reason) => `- ${reason}`),
      ...(omitted > 0
        ? [`- _${omitted} reason(s) omitted by the visible count/byte bounds; full detail remains in the owner-task workflow artifacts._`]
        : []),
      "",
      marker,
    ].join("\n");
  };
  for (const reason of rendered) {
    const candidate = [...selected, reason];
    if (Buffer.byteLength(compose(candidate), "utf8") > MAX_OWNER_TASK_COMMENT_BYTES) {
      break;
    }
    selected = candidate;
  }
  const body = compose(selected);
  if (Buffer.byteLength(body, "utf8") > MAX_OWNER_TASK_COMMENT_BYTES) {
    throw new Error("trusted owner-task notice framing exceeds its byte cap");
  }
  return body;
}

async function postComment(
  request: GithubRequest,
  environment: Environment,
  body: string,
): Promise<void> {
  await request(
    environment.token,
    "POST",
    `${environment.issuePath}/comments`,
    { body },
  );
}

async function postBlankTaskNotice(
  request: GithubRequest,
  environment: Environment,
): Promise<void> {
  await postComment(request, environment, buildBoundedMarkedComment(
    "**Owner task rejected: no actionable task description.**",
    ["the owner task payload is empty or whitespace-only; re-issue it with a concrete change"],
    environment.commentId,
  ));
}

async function postTruncatedTaskNotice(
  request: GithubRequest,
  environment: Environment,
): Promise<void> {
  await postComment(request, environment, buildBoundedMarkedComment(
    "**Owner task rejected: task description was truncated.**",
    ["owner task was truncated; reissue a shorter command"],
    environment.commentId,
  ));
}

async function postFinalizeStaleNotice(
  request: GithubRequest,
  environment: Environment,
  comments: readonly unknown[],
  reason: string,
): Promise<void> {
  if (hasExistingTaskApply(comments, environment.commentId, RESPONSE_BOT_LOGIN)) return;
  await postComment(request, environment, buildBoundedMarkedComment(
    "**Owner task source is stale; success was not recorded.**",
    [reason],
    environment.commentId,
  ));
}

function staleReasons(
  decision: Extract<OwnerTaskPatchDecision, { kind: "stale-notice" }>,
): string[] {
  return [
    `authorised head ${decision.expectedHeadSha}; current head ${decision.currentHeadSha}`,
    `authorised base ${decision.expectedBaseSha}; current base ${decision.currentBaseSha}`,
  ];
}

async function handleNonApplyDecision(
  request: GithubRequest,
  environment: Environment,
  decision: Exclude<OwnerTaskPatchDecision, { kind: "apply" }>,
): Promise<void> {
  if (decision.kind === "ignore") return;
  if (decision.kind === "no-op-success") return;
  if (decision.kind === "reject-notice") {
    await postComment(request, environment, buildBoundedMarkedComment(
      `**Owner task patch rejected at ${decision.stage}.**`,
      decision.reasons,
      environment.commentId,
    ));
    return;
  }
  await postComment(request, environment, buildBoundedMarkedComment(
    "**Owner task snapshot is stale; no patch was applied.**",
    staleReasons(decision),
    environment.commentId,
  ));
}

function requireHeadRef(pullRequest: Record<string, unknown>): string {
  const head = pullRequest.head;
  if (!isRecord(head) || typeof head.ref !== "string") {
    throw new TypeError("GitHub API returned a malformed pull-request head ref");
  }
  const ref = head.ref;
  if (
    ref.length === 0 ||
    !REF_NAME_PATTERN.test(ref) ||
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.split("/").some((component) => component.startsWith("."))
  ) {
    throw new TypeError("GitHub API returned an unsafe pull-request head ref");
  }
  return ref;
}

function requireBaseRef(pullRequest: Record<string, unknown>): string {
  const base = pullRequest.base;
  if (!isRecord(base) || typeof base.ref !== "string" || base.ref.length === 0) {
    throw new TypeError("GitHub API returned a malformed pull-request base ref");
  }
  return base.ref;
}

function repositoryDefaultBranch(
  repository: Record<string, unknown>,
  label: string,
): string | null {
  if (!("default_branch" in repository)) return null;
  const value = repository.default_branch;
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`GitHub API returned a malformed ${label} default branch`);
  }
  return value;
}

function requireRepositoryDefaultBranch(
  pullRequest: Record<string, unknown>,
): string {
  const head = pullRequest.head;
  const base = pullRequest.base;
  if (
    !isRecord(head) ||
    !isRecord(head.repo) ||
    !isRecord(base) ||
    !isRecord(base.repo)
  ) {
    throw new TypeError("GitHub API returned malformed pull-request repositories");
  }
  const headDefault = repositoryDefaultBranch(head.repo, "head-repository");
  const baseDefault = repositoryDefaultBranch(base.repo, "base-repository");
  if (headDefault === null && baseDefault === null) {
    throw new TypeError("GitHub API omitted the repository default branch");
  }
  if (headDefault !== null && baseDefault !== null && headDefault !== baseDefault) {
    throw new TypeError("GitHub API returned inconsistent repository default branches");
  }
  return headDefault ?? baseDefault!;
}

async function isProtectedBranch(
  request: GithubRequest,
  environment: Environment,
  refName: string,
): Promise<boolean> {
  // The contents-readable branch resource exposes classic + ruleset protection;
  // the admin-only `/protection` endpoint is unavailable to the workflow token.
  const rawBranch = await request<unknown>(
    environment.token,
    "GET",
    `${environment.repositoryPath}/branches/${encodeURIComponent(refName)}`,
  );
  const branch = fetchedRecord(rawBranch, "branch");
  if (typeof branch.protected !== "boolean") {
    throw new TypeError("GitHub API returned a malformed branch protection status");
  }
  return branch.protected;
}

function serializePlanAnnotations(
  annotations: OwnerTaskGamingAnnotations,
): string {
  const full = JSON.stringify(annotations);
  const fullBytes = Buffer.byteLength(full, "utf8");
  if (fullBytes <= MAX_PLAN_ANNOTATIONS_BYTES) return full;
  return JSON.stringify({
    bounded: true,
    disclosure:
      "full advisory annotations exceeded the plan byte cap and remain available in the owner-task workflow artifacts",
    originalBytes: fullBytes,
    counts: {
      testFileEdits: annotations.testFileEdits.length,
      coverageSuppressions: annotations.coverageSuppressions.length,
      packageJsonTestScriptEdits: annotations.packageJsonTestScriptEdits.length,
      rootPytestConfigSections: annotations.rootPytestConfigSections.length,
    },
  });
}

function writeApplyPlan(
  planDir: string,
  refName: string,
  decision: Extract<OwnerTaskPatchDecision, { kind: "apply" }>,
): void {
  mkdirSync(planDir, { recursive: true });
  if (readdirSync(planDir).length !== 0) {
    throw new Error("PLAN_DIR must be empty before writing an apply plan");
  }
  const files: Readonly<Record<string, string>> = {
    kind: decision.kind,
    tree_oid: decision.treeOid,
    parent_sha: decision.parent,
    lease_sha: decision.forceWithLeaseExpectedSha,
    ref_name: refName,
    "message.txt": `${decision.commitSubject}\n\n${decision.trailer}`,
    "annotations.json": serializePlanAnnotations(decision.annotations),
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(planDir, name), value, "utf8");
  }
}

async function prepare(
  request: GithubRequest,
  environment: Environment,
): Promise<void> {
  const { issue, commentBody, author } = await fetchCommentAndIssue(request, environment);
  if (!isPullRequestIssue(issue)) {
    appendOutput(environment.outputPath, "proceed", "false");
    return;
  }
  const pullRequest = await fetchPullRequest(request, environment);
  const authorization = deriveResponseAuthorization({
    issue,
    pullRequest,
    author,
    commentBody,
    githubRepository: environment.repository,
  });
  if (!authorization.proceed || authorization.command.verb !== "task") {
    // MUTATION-CHECK: trusting a forged upstream proceed signal fails N7;
    // eligibility is always re-derived from these fresh raw records.
    appendOutput(environment.outputPath, "proceed", "false");
    return;
  }
  if (authorization.command.payload.trim().length === 0) {
    await postBlankTaskNotice(request, environment);
    appendOutput(environment.outputPath, "proceed", "false");
    return;
  }
  const rawBinding = readBindingArtifact(environment.bindingArtifactPath);
  if (rawBinding === null) throw new Error("owner-task binding artifact is missing");
  const binding = parseTaskBinding(rawBinding);
  if (
    sha256(authorization.command.payload) !== binding.commandPayloadSha256 ||
    authorization.command.truncated !== binding.taskTruncated
  ) {
    throw new Error("owner-task binding does not match the authorised command");
  }
  if (authorization.command.truncated) {
    await postTruncatedTaskNotice(request, environment);
    appendOutput(environment.outputPath, "proceed", "false");
    return;
  }
  appendOutput(environment.outputPath, "proceed", "true");
  appendOutput(environment.outputPath, "base_sha", binding.prHeadSha);
}

function ignoredInput(
  issue: unknown,
  pullRequest: unknown,
  author: unknown,
  commentBody: string,
  environment: Environment,
): OwnerTaskPatchDecisionInput {
  return {
    issue,
    pullRequest,
    author,
    commentBody,
    githubRepository: environment.repository,
    commentId: environment.commentId,
    bindingArtifact: null,
    markerPresent: false,
    trailerCommitPresent: false,
    patchArtifactBytes: 0,
    patchAnalysis: { status: "failed", reasons: ["analysis was not read"] },
  };
}

async function decide(
  request: GithubRequest,
  environment: Environment,
): Promise<void> {
  const { issue, commentBody, author } = await fetchCommentAndIssue(request, environment);
  if (!isPullRequestIssue(issue)) {
    const outcome = decideOwnerTaskPatch(
      ignoredInput(issue, null, author, commentBody, environment),
    );
    /* v8 ignore next 3 -- decideOwnerTaskPatch must ignore a non-PR input; reaching this throw requires violating that decision-module contract. */
    if (outcome.kind !== "ignore") {
      throw new Error("a non-pull-request command unexpectedly produced an action");
    }
    await handleNonApplyDecision(request, environment, outcome);
    return;
  }
  const pullRequest = await fetchPullRequest(request, environment);
  const authorization = deriveResponseAuthorization({
    issue,
    pullRequest,
    author,
    commentBody,
    githubRepository: environment.repository,
  });
  if (!authorization.proceed || authorization.command.verb !== "task") {
    const outcome = decideOwnerTaskPatch(
      ignoredInput(issue, pullRequest, author, commentBody, environment),
    );
    /* v8 ignore next 3 -- decideOwnerTaskPatch must ignore freshly re-derived ineligible input; reaching this throw requires violating that decision-module contract. */
    if (outcome.kind !== "ignore") {
      throw new Error("an ineligible owner command unexpectedly produced an action");
    }
    await handleNonApplyDecision(request, environment, outcome);
    return;
  }

  const comments = await fetchAllComments(request, environment);
  const markerPresent = hasExistingTaskApply(
    comments,
    environment.commentId,
    RESPONSE_BOT_LOGIN,
  );
  const recordedCommit = markerAppliedCommit(
    comments,
    environment.commentId,
    RESPONSE_BOT_LOGIN,
  );
  let effectiveMarkerPresent = markerPresent;
  if (markerPresent) {
    if (recordedCommit !== null) {
      const reachability = await checkAppliedCommitReachability(
        request,
        environment,
        pullRequest,
        recordedCommit,
      );
      effectiveMarkerPresent = reachability.status === "reachable";
    }
    if (effectiveMarkerPresent) {
      const markerReplay = decideOwnerTaskPatch({
        ...ignoredInput(issue, pullRequest, author, commentBody, environment),
        markerPresent: true,
      });
      if (markerReplay.kind === "no-op-success") {
        await handleNonApplyDecision(request, environment, markerReplay);
        return;
      }
    }
  }
  if (authorization.command.payload.trim().length === 0) {
    await postBlankTaskNotice(request, environment);
    return;
  }

  const commitCount = requireCommitCount(pullRequest);
  const bindingArtifact = readBindingArtifact(environment.bindingArtifactPath);
  const common: Omit<OwnerTaskPatchDecisionInput, "patchArtifactBytes" | "patchAnalysis"> = {
    issue,
    pullRequest,
    author,
    commentBody,
    githubRepository: environment.repository,
    commentId: environment.commentId,
    bindingArtifact,
    markerPresent: effectiveMarkerPresent,
    // A same-repository branch author controls arbitrary commit messages.
    // Only the bot-authored marker is authenticated replay evidence in decide.
    trailerCommitPresent: false,
  };
  const notRead: OwnerTaskPatchAnalysisResult = {
    status: "failed",
    reasons: ["analysis was not read"],
  };
  const preliminary = decideOwnerTaskPatch({
    ...common,
    patchArtifactBytes: 0,
    patchAnalysis: notRead,
  });
  if (authorization.command.truncated) {
    // MUTATION-CHECK: removing this staged return fails N4 because the absent
    // analysis directory would then be read before the truncation rejection.
    /* v8 ignore next 3 -- decideOwnerTaskPatch rejects a bound truncated task before artifact analysis; apply here requires violating its outcome contract. */
    if (preliminary.kind === "apply") {
      throw new Error("truncated task unexpectedly reached an apply decision");
    }
    await handleNonApplyDecision(request, environment, preliminary);
    return;
  }

  const artifactBytes = patchArtifactBytes(environment.patchArtifactPath);
  const beforeAnalysis = decideOwnerTaskPatch({
    ...common,
    patchArtifactBytes: artifactBytes,
    patchAnalysis: notRead,
  });
  if (
    beforeAnalysis.kind !== "reject-notice" ||
    beforeAnalysis.stage !== "patch-analysis"
  ) {
    /* v8 ignore next 3 -- a deliberately unread failed analysis cannot produce apply under decideOwnerTaskPatch's contract. */
    if (beforeAnalysis.kind === "apply") {
      throw new Error("unread patch analysis unexpectedly reached an apply decision");
    }
    await handleNonApplyDecision(request, environment, beforeAnalysis);
    return;
  }

  const outcome = decideOwnerTaskPatch({
    ...common,
    patchArtifactBytes: artifactBytes,
    patchAnalysis: readPatchAnalysis(environment.analysisDir),
  });
  if (outcome.kind !== "apply") {
    await handleNonApplyDecision(request, environment, outcome);
    return;
  }
  if (commitCount >= MAX_TRAILER_COMMIT_WINDOW) {
    await postComment(request, environment, buildBoundedMarkedComment(
      "**Owner task patch rejected at replay-window.**",
      ["PR has too many commits for the owner-task replay window; reduce commits and re-issue"],
      environment.commentId,
    ));
    return;
  }
  const refName = requireHeadRef(pullRequest);
  const defaultBranch = requireRepositoryDefaultBranch(pullRequest);
  const baseRef = requireBaseRef(pullRequest);
  // MUTATION-CHECK: T-U1.5b rejects a non-default base before plan creation.
  if (baseRef !== defaultBranch) {
    await postComment(request, environment, buildBoundedMarkedComment(
      "**Owner task patch rejected at branch-boundary.**",
      [
        "the pull-request base is not the repository default branch; owner-task apply targets pull requests into the protected default branch",
      ],
      environment.commentId,
    ));
    return;
  }
  if (refName === defaultBranch) {
    await postComment(request, environment, buildBoundedMarkedComment(
      "**Owner task patch rejected at branch-boundary.**",
      ["the pull-request head is the repository default branch; use an unprotected topic branch"],
      environment.commentId,
    ));
    return;
  }
  if (await isProtectedBranch(request, environment, refName)) {
    await postComment(request, environment, buildBoundedMarkedComment(
      "**Owner task patch rejected at branch-boundary.**",
      ["the pull-request head is protected; use an unprotected topic branch"],
      environment.commentId,
    ));
    return;
  }
  // MUTATION-CHECK: T-U1.5 and N8 bind both the planned parent/lease and the
  // applied tree to the reviewed full SHA and authoritative scratch tree.
  writeApplyPlan(environment.planDir, refName, outcome);
  appendOutput(environment.outputPath, "kind", outcome.kind);
}

async function finalize(
  request: GithubRequest,
  environment: Environment,
): Promise<void> {
  const comments = await fetchAllComments(request, environment);
  let pullRequest: Record<string, unknown>;
  try {
    pullRequest = await fetchPullRequest(request, environment);
  } catch (error: unknown) {
    if (error instanceof GithubApiError && error.status === 404) {
      await postFinalizeStaleNotice(
        request,
        environment,
        comments,
        "the source owner-task comment or pull request no longer exists",
      );
      return;
    }
    throw error;
  }
  const recordedCommit = markerAppliedCommit(
    comments,
    environment.commentId,
    RESPONSE_BOT_LOGIN,
  );
  if (recordedCommit !== null) {
    const recordedReachability = await checkAppliedCommitReachability(
      request,
      environment,
      pullRequest,
      recordedCommit,
    );
    if (recordedReachability.status === "reachable") return;
  }

  let source: Awaited<ReturnType<typeof fetchCommentAndIssue>>;
  try {
    source = await fetchCommentAndIssue(request, environment);
  } catch (error: unknown) {
    if (error instanceof GithubApiError && error.status === 404) {
      await postFinalizeStaleNotice(
        request,
        environment,
        comments,
        "the source owner-task comment or pull request no longer exists",
      );
      return;
    }
    throw error;
  }
  const authorization = deriveResponseAuthorization({
    issue: source.issue,
    pullRequest,
    author: source.author,
    commentBody: source.commentBody,
    githubRepository: environment.repository,
  });
  if (!authorization.proceed || authorization.command.verb !== "task") {
    await postFinalizeStaleNotice(
      request,
      environment,
      comments,
      "the source comment is no longer an eligible owner task",
    );
    return;
  }
  const rawBinding = readBindingArtifact(environment.bindingArtifactPath);
  if (rawBinding === null) throw new Error("owner-task binding artifact is missing");
  const binding = parseTaskBinding(rawBinding);
  if (
    sha256(authorization.command.payload) !== binding.commandPayloadSha256 ||
    authorization.command.truncated !== binding.taskTruncated
  ) {
    await postFinalizeStaleNotice(
      request,
      environment,
      comments,
      "the source owner-task payload or truncation state changed after apply began",
    );
    return;
  }

  const appliedCommit = readShaArtifact(
    join(environment.planDir, "applied_commit"),
    "applied commit",
  );
  const reachability = await checkAppliedCommitReachability(
    request,
    environment,
    pullRequest,
    appliedCommit,
  );
  if (reachability.status !== "reachable") {
    throw new Error("applied commit is not an ancestor of the current pull-request head");
  }
  const appliedCommitRecord = reachability.commit;
  const commit = appliedCommitRecord.commit;
  if (!isRecord(commit) || typeof commit.message !== "string") {
    throw new TypeError("applied commit has a malformed message");
  }
  const expectedTrailer = buildTaskTrailer(environment.commentId);
  if (!commit.message.split(/\r?\n/).some((line) => line.trim() === expectedTrailer)) {
    throw new Error("applied commit does not carry the expected owner-task trailer");
  }
  const plannedTreeOid = readShaArtifact(
    join(environment.planDir, "tree_oid"),
    "planned tree",
  );
  const plannedParentSha = readShaArtifact(
    join(environment.planDir, "parent_sha"),
    "planned parent",
  );
  const tree = commit.tree;
  if (!isRecord(tree) || typeof tree.sha !== "string" || !FULL_SHA_PATTERN.test(tree.sha)) {
    throw new TypeError("applied commit has a malformed tree");
  }
  if (tree.sha !== plannedTreeOid) {
    throw new Error("applied commit tree does not match the admitted plan");
  }
  const parents = appliedCommitRecord.parents;
  if (!Array.isArray(parents)) {
    throw new TypeError("applied commit has malformed parents");
  }
  if (parents.length !== 1) {
    throw new Error("applied commit does not have exactly one parent");
  }
  const parent = parents[0];
  if (!isRecord(parent) || typeof parent.sha !== "string" || !FULL_SHA_PATTERN.test(parent.sha)) {
    throw new TypeError("applied commit has a malformed parent");
  }
  if (parent.sha !== plannedParentSha) {
    throw new Error("applied commit parent does not match the admitted plan");
  }
  const annotations = readRequiredCappedFile(
    join(environment.planDir, "annotations.json"),
    MAX_PLAN_ANNOTATIONS_BYTES,
  );
  const finalBaseRef = requireBaseRef(pullRequest);
  const finalDefaultBranch = requireRepositoryDefaultBranch(pullRequest);
  // MUTATION-CHECK: T-A5 binds the marker-bearing finalize notice to the live
  // authoritative base and prevents a retargeted PR from receiving success.
  if (finalBaseRef !== finalDefaultBranch) {
    await postComment(request, environment, buildBoundedMarkedComment(
      [
        "**Owner task patch applied, but the pull-request base was retargeted after admission.**",
        "",
        `Applied-Commit: ${appliedCommit}`,
        "",
        "The pull-request base was retargeted away from the protected default branch after admission, so the branch-protection re-validation guarantee no longer holds. Do NOT merge. Retarget the pull-request base back to the repository default branch, then close and reopen the pull request to re-run the required checks on the applied head. There is no alternate-base path.",
      ].join("\n"),
      [`Advisory patch annotations: ${annotations}`],
      environment.commentId,
    ));
    return;
  }
  // MUTATION-CHECK: T-A1 through T-A4 protect the trusted re-validation caveat,
  // its reason-cap survival, connector-safe wording, and Applied-Commit parsing.
  await postComment(request, environment, buildBoundedMarkedComment(
    [
      "**Owner task patch applied successfully. The applied head is NOT yet re-validated.**",
      "",
      `Applied-Commit: ${appliedCommit}`,
      "",
      "This commit was pushed with the built-in GITHUB_TOKEN, which does not auto-trigger downstream workflows: no required check (CI, CodeQL) and no review lens (Claude, Codex) has run on this head. Do NOT merge yet. An operator must follow the applied-head re-validation procedure in docs/factory-runbook.md (\"Applied-head roster re-validation\") to re-trigger the required roster on this exact head and confirm every required check passes and every review lens completes per the PR Merge Policy. Branch protection blocks merge until required checks pass on this head.",
    ].join("\n"),
    [`Advisory patch annotations: ${annotations}`],
    environment.commentId,
  ));
}

export async function main(request: GithubRequest = githubRequest): Promise<void> {
  const environment = readEnvironment();
  if (environment.phase === "prepare") {
    await prepare(request, environment);
  } else if (environment.phase === "decide") {
    await decide(request, environment);
  } else {
    await finalize(request, environment);
  }
}

/* v8 ignore start -- exercised by the future workflow process, not import-based tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error("apply-owner-task failed:", error);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
