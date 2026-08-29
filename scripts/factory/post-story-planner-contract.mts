/** Deterministic, shape-gated publisher for the dark story-planner workflow. */
import { existsSync, readFileSync } from "node:fs";

import { githubRequest, requireEnv } from "./github-api.mts";
import { MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH } from "./github-comment-limit.mts";
import {
  buildTriggerDetectionFold,
  escapeInvisibleCharactersVisibly,
  neutralizeCodexTriggerPhrases,
} from "./untrusted-text.mts";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const ISSUE_REVISION_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 50;
const STORY_PLANNER_CONTRACT_MARKER_PREFIX = "<!-- story-planner-contract:";
export const STORY_PLANNER_ESCALATE_MARKER_PREFIX = "<!-- story-planner-escalate:";
const STORY_PLANNER_BOT_AUTHOR_LOGIN = "github-actions[bot]";
const MARKERS = [
  "<!-- contract:spec -->",
  "<!-- contract:tests -->",
  "<!-- contract:pr-plan -->",
  "<!-- contract:routing -->",
] as const;

/** Workflow-owned issue-scoped marker appended only after model text is sanitized. */
export const STORY_PLANNER_CONTRACT_MARKER = (issueNumber: number): string =>
  `${STORY_PLANNER_CONTRACT_MARKER_PREFIX}issue-${issueNumber} -->`;

/** Workflow-owned issue-scoped marker appended only after escalation text is sanitized. */
export const STORY_PLANNER_ESCALATE_MARKER = (issueNumber: number): string =>
  `${STORY_PLANNER_ESCALATE_MARKER_PREFIX}issue-${issueNumber} -->`;

export type GithubRequest = <T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

function removeCodexSeparatingBackticks(text: string): string {
  const { folded, originStart, originEnd } = buildTriggerDetectionFold(text);
  const foldedBacktickSplitTrigger = /@[\s`]*(?=codex\b)/giu;
  const spans: Array<{ start: number; end: number }> = [];
  const seenSpans = new Set<string>();
  for (
    let match = foldedBacktickSplitTrigger.exec(folded);
    match !== null;
    match = foldedBacktickSplitTrigger.exec(folded)
  ) {
    for (
      let foldedIndex = match.index + 1;
      foldedIndex < match.index + match[0].length;
      foldedIndex++
    ) {
      if (folded[foldedIndex] !== "`") {
        continue;
      }
      const start = originStart[foldedIndex]!;
      const end = originEnd[foldedIndex]!;
      const spanKey = `${start}:${end}`;
      if (!seenSpans.has(spanKey)) {
        spans.push({ start, end });
        seenSpans.add(spanKey);
      }
    }
  }
  let result = text;
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index]!;
    result = result.slice(0, span.start) + result.slice(span.end);
  }
  return result;
}

/** Defang control tokens in a model-authored contract without wrapping its Markdown. */
export function sanitizeContractForPosting(contract: string): string {
  const invisiblesMarked = escapeInvisibleCharactersVisibly(contract);
  return neutralizeCodexTriggerPhrases(removeCodexSeparatingBackticks(invisiblesMarked));
}

function fenceVerbatim(text: string): string {
  const backtickRuns = text.match(/`+/g) ?? [];
  const longestRun = backtickRuns.reduce(
    (longest, run) => Math.max(longest, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}\n${text}\n${fence}`;
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

export function stripHtmlComments(region: string): string {
  const outsideComments: string[] = [];
  let inComment = false;
  for (let index = 0; index < region.length;) {
    if (!inComment && region.startsWith("<!--", index)) {
      inComment = true;
      index += 4;
    } else if (region.startsWith("-->", index)) {
      inComment = false;
      index += 3;
    } else {
      if (!inComment) {
        outsideComments.push(region[index]!);
      }
      index += 1;
    }
  }
  return outsideComments.join("");
}

function isSubstantive(region: string): boolean {
  const words = stripHtmlComments(region).match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? [];
  return new Set(words.map((word) => word.toLowerCase())).size >= 3;
}

/** Reject malformed model output before the writable token makes any request. */
export function validateStoryPlannerContract(
  contract: string,
  issueNumber: number,
): void {
  if (contract.includes(STORY_PLANNER_CONTRACT_MARKER_PREFIX)) {
    throw new Error("contract contains the reserved story-planner contract marker prefix");
  }
  if (
    contract.includes("<!-- escalate:") ||
    contract.includes(STORY_PLANNER_ESCALATE_MARKER_PREFIX)
  ) {
    throw new Error("contract contains a reserved story-planner escalation marker prefix");
  }
  const expectedSentinel =
    `CONTRACT-COMPLETE: story-planner contract finished (issue #${issueNumber})`;
  if (contract.split(expectedSentinel).length - 1 !== 1) {
    throw new Error("terminal sentinel must appear exactly once");
  }
  const nonEmptyLines = contract.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (nonEmptyLines.at(-1)?.trim() !== expectedSentinel) {
    throw new Error("contract is missing the issue-bound terminal sentinel as its final non-empty line");
  }

  const positions = MARKERS.map((marker) => {
    const first = contract.indexOf(marker);
    if (first < 0 || contract.indexOf(marker, first + marker.length) >= 0) {
      throw new Error(`contract must contain ${marker} exactly once`);
    }
    return first;
  });
  if (!positions.every((position, index) => index === 0 || position > positions[index - 1]!)) {
    throw new Error("contract markers are not in the required order");
  }

  const sentinelPosition = contract.lastIndexOf(expectedSentinel);
  const regionEnds = [...positions.slice(1), sentinelPosition];
  const regions = positions.map((position, index) =>
    contract.slice(position + MARKERS[index]!.length, regionEnds[index]),
  );
  regions.forEach((region, index) => {
    if (!isSubstantive(region)) {
      throw new Error(`contract region after ${MARKERS[index]} is empty or vacuous`);
    }
  });

  const testsRegion = regions[1]!;
  const testsRegionWithoutComments = stripHtmlComments(testsRegion);
  if (!/^\s*[-*]\s+\S/m.test(testsRegionWithoutComments)) {
    throw new Error("contract tests region must contain at least one Markdown test bullet");
  }
  if (!/negative|must fail|reject/i.test(testsRegionWithoutComments)) {
    throw new Error("contract tests region must contain a negative-case indicator");
  }
}

/** Reject malformed model-authored escalation output before any request. */
export function validateStoryPlannerEscalation(
  escalate: string,
  issueNumber: number,
): void {
  if (
    escalate.includes("<!-- contract:") ||
    escalate.includes(STORY_PLANNER_CONTRACT_MARKER_PREFIX) ||
    escalate.includes(STORY_PLANNER_ESCALATE_MARKER_PREFIX)
  ) {
    throw new Error("escalation contains a reserved story-planner marker prefix");
  }

  const marker = "<!-- escalate:question -->";
  const markerPosition = escalate.indexOf(marker);
  if (
    markerPosition < 0 ||
    escalate.indexOf(marker, markerPosition + marker.length) >= 0
  ) {
    throw new Error(`escalation must contain ${marker} exactly once`);
  }

  const expectedSentinel =
    `ESCALATE-COMPLETE: story-planner escalation finished (issue #${issueNumber})`;
  if (escalate.split(expectedSentinel).length - 1 !== 1) {
    throw new Error("escalation terminal sentinel must appear exactly once");
  }
  const nonEmptyLines = escalate.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (nonEmptyLines.at(-1)?.trim() !== expectedSentinel) {
    throw new Error(
      "escalation is missing the issue-bound terminal sentinel as its final non-empty line",
    );
  }

  const sentinelPosition = escalate.lastIndexOf(expectedSentinel);
  const questionRegion = escalate.slice(markerPosition + marker.length, sentinelPosition);
  if (!isSubstantive(questionRegion)) {
    throw new Error(`escalation region after ${marker} is empty or vacuous`);
  }
}

interface GitHubComment {
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}

async function hasExistingBotMarkerComment(
  request: GithubRequest,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  marker: string,
): Promise<boolean> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await request<GitHubComment[]>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
    );
    if (
      comments.some(
        (comment) =>
          comment.user?.type === "Bot" &&
          comment.user.login === STORY_PLANNER_BOT_AUTHOR_LOGIN &&
          (comment.body === marker || comment.body.endsWith(`\n${marker}`)),
      )
    ) {
      return true;
    }
    if (comments.length < COMMENT_PAGE_SIZE) {
      return false;
    }
  }
  console.warn(
    `Scanned ${MAX_COMMENT_PAGES} pages of comments on #${issueNumber} ` +
      `without finding a prior story-planner contract; posting a new one ` +
      `rather than risking missing a marker beyond this page limit.`,
  );
  return false;
}

async function fetchIssueAndAssertReadyToSpec(
  request: GithubRequest,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<Record<string, unknown>> {
  const issue = await request<unknown>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
  );
  if (
    typeof issue !== "object" ||
    issue === null ||
    !("labels" in issue) ||
    !Array.isArray(issue.labels)
  ) {
    throw new Error("issue labels response is malformed; refusing to publish");
  }
  const labelNames = issue.labels.map((label) => {
    if (
      typeof label !== "object" ||
      label === null ||
      !("name" in label) ||
      typeof label.name !== "string"
    ) {
      throw new Error("issue labels response is malformed; refusing to publish");
    }
    return label.name;
  });
  if (!labelNames.includes("ready-to-spec")) {
    throw new Error(
      "ready-to-spec was withdrawn before publish; refusing to post a stale contract",
    );
  }
  return issue as Record<string, unknown>;
}

export async function main(request: GithubRequest = githubRequest): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be canonical "owner/repo"');
  }
  const issueNumber = parsePositiveInteger(
    "TARGET_ISSUE_NUMBER",
    requireEnv("TARGET_ISSUE_NUMBER"),
  );
  const contractPath = requireEnv("CONTRACT_PATH");
  const escalatePath = process.env.ESCALATE_PATH;
  const contractExists = existsSync(contractPath);
  const escalateExists = escalatePath !== undefined && existsSync(escalatePath);
  if (contractExists && escalateExists) {
    throw new Error(
      "story-planner produced both a contract and an escalation; ambiguous output, refusing to publish",
    );
  }
  const [owner, repo] = repository.split("/", 2) as [string, string];
  if (contractExists) {
    const contract = readFileSync(contractPath, "utf8");
    validateStoryPlannerContract(contract, issueNumber);
    const finalBody =
      sanitizeContractForPosting(contract) +
      "\n" +
      STORY_PLANNER_CONTRACT_MARKER(issueNumber);
    if (finalBody.length > MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH) {
      throw new Error(
        `story-planner contract comment length ${finalBody.length} exceeds GitHub comment limit ${MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH}`,
      );
    }

    if (
      await hasExistingBotMarkerComment(
        request,
        token,
        owner,
        repo,
        issueNumber,
        STORY_PLANNER_CONTRACT_MARKER(issueNumber),
      )
    ) {
      console.log(`contract already posted on #${issueNumber}; skipping`);
      return;
    }

    const issue = await fetchIssueAndAssertReadyToSpec(
      request,
      token,
      owner,
      repo,
      issueNumber,
    );

    // GitHub updated_at (and GraphQL updatedAt) has only second granularity, so
    // an edit after Prepare's read in the same wall-clock second is undetectable.
    // No finer token exists; the residual is a marginally stale advisory comment
    // in this dark, human-reviewed workflow—a known limitation, not a fail-open.
    const revision = JSON.parse(
      readFileSync(requireEnv("REVISION_PATH"), "utf8"),
    ) as unknown;
    if (
      typeof revision !== "object" ||
      revision === null ||
      Array.isArray(revision) ||
      Object.keys(revision).length !== 2 ||
      !("issueNumber" in revision) ||
      typeof revision.issueNumber !== "number" ||
      !("updatedAt" in revision) ||
      typeof revision.updatedAt !== "string" ||
      revision.issueNumber !== issueNumber ||
      !ISSUE_REVISION_PATTERN.test(revision.updatedAt)
    ) {
      throw new Error("revision binding is malformed; refusing to publish");
    }
    if (
      !("updated_at" in issue) ||
      typeof issue.updated_at !== "string" ||
      !ISSUE_REVISION_PATTERN.test(issue.updated_at)
    ) {
      throw new Error("issue updated_at is malformed; refusing to publish");
    }
    if (issue.updated_at !== revision.updatedAt) {
      throw new Error(
        "issue was modified after planning (revision binding mismatch); refusing to post a contract planned against stale content",
      );
    }

    await request(
      token,
      "POST",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      {
        body: finalBody,
      },
    );
    console.log(`Posted one story-planner contract on issue #${issueNumber}.`);
    return;
  } else if (escalateExists) {
    const escalate = readFileSync(escalatePath, "utf8");
    validateStoryPlannerEscalation(escalate, issueNumber);
    const finalBody =
      "This is a re-scoping question, not an authorization: no label has been changed and no work is authorized by this comment." +
      "\n\n" +
      fenceVerbatim(sanitizeContractForPosting(escalate)) +
      "\n" +
      STORY_PLANNER_ESCALATE_MARKER(issueNumber);
    if (finalBody.length > MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH) {
      throw new Error(
        `story-planner escalation comment length ${finalBody.length} exceeds GitHub comment limit ${MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH}`,
      );
    }
    if (
      await hasExistingBotMarkerComment(
        request,
        token,
        owner,
        repo,
        issueNumber,
        STORY_PLANNER_ESCALATE_MARKER(issueNumber),
      )
    ) {
      console.log(`escalation already posted on #${issueNumber}; skipping`);
      return;
    }
    // An escalation is a non-authorizing re-scoping question, not a body-bound
    // spec. Deliberately omit revision binding so a benign same-run body edit
    // cannot recreate the red-job/no-question failure, while still refusing
    // publication when ready-to-spec was withdrawn.
    await fetchIssueAndAssertReadyToSpec(
      request,
      token,
      owner,
      repo,
      issueNumber,
    );
    await request(
      token,
      "POST",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body: finalBody },
    );
    console.log(`Posted one story-planner escalation on issue #${issueNumber}.`);
    return;
  }

  throw new Error("story-planner produced neither a contract nor an escalation file");
}

/* v8 ignore start -- exercised by the workflow process, not import-based tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error("post-story-planner-contract failed:", error);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
