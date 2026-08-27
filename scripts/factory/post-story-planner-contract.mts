/** Deterministic, shape-gated publisher for the dark story-planner workflow. */
import { readFileSync } from "node:fs";

import { githubRequest, requireEnv } from "./github-api.mts";
import {
  buildTriggerDetectionFold,
  escapeInvisibleCharactersVisibly,
  neutralizeCodexTriggerPhrases,
} from "./untrusted-text.mts";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const COMMENT_PAGE_SIZE = 100;
const MAX_COMMENT_PAGES = 50;
const STORY_PLANNER_CONTRACT_MARKER_PREFIX = "<!-- story-planner-contract:";
const STORY_PLANNER_CONTRACT_AUTHOR_LOGIN = "github-actions[bot]";
const MARKERS = [
  "<!-- contract:spec -->",
  "<!-- contract:tests -->",
  "<!-- contract:pr-plan -->",
  "<!-- contract:routing -->",
] as const;

/** Workflow-owned issue-scoped marker appended only after model text is sanitized. */
export const STORY_PLANNER_CONTRACT_MARKER = (issueNumber: number): string =>
  `${STORY_PLANNER_CONTRACT_MARKER_PREFIX}issue-${issueNumber} -->`;

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

interface GitHubComment {
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}

async function hasExistingStoryPlannerContract(
  request: GithubRequest,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  const marker = STORY_PLANNER_CONTRACT_MARKER(issueNumber);
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
          comment.user.login === STORY_PLANNER_CONTRACT_AUTHOR_LOGIN &&
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
  const contract = readFileSync(requireEnv("CONTRACT_PATH"), "utf8");
  validateStoryPlannerContract(contract, issueNumber);

  const [owner, repo] = repository.split("/", 2) as [string, string];
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

  if (
    await hasExistingStoryPlannerContract(
      request,
      token,
      owner,
      repo,
      issueNumber,
    )
  ) {
    console.log(`contract already posted on #${issueNumber}; skipping`);
    return;
  }

  await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      body:
        sanitizeContractForPosting(contract) +
        "\n" +
        STORY_PLANNER_CONTRACT_MARKER(issueNumber),
    },
  );
  console.log(`Posted one story-planner contract on issue #${issueNumber}.`);
}

/* v8 ignore start -- exercised by the workflow process, not import-based tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error("post-story-planner-contract failed:", error);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
