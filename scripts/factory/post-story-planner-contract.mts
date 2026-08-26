/** Deterministic, shape-gated publisher for the dark story-planner workflow. */
import { readFileSync } from "node:fs";

import { githubRequest, requireEnv } from "./github-api.mts";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const MARKERS = [
  "<!-- contract:spec -->",
  "<!-- contract:tests -->",
  "<!-- contract:pr-plan -->",
  "<!-- contract:routing -->",
] as const;

export type GithubRequest = <T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

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

function isSubstantive(region: string): boolean {
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
  const words = outsideComments
    .join("")
    .match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? [];
  return new Set(words.map((word) => word.toLowerCase())).size >= 3;
}

/** Reject malformed model output before the writable token makes any request. */
export function validateStoryPlannerContract(
  contract: string,
  issueNumber: number,
): void {
  const expectedSentinel =
    `CONTRACT-COMPLETE: story-planner contract finished (issue #${issueNumber})`;
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
  if (!/^\s*[-*]\s+\S/m.test(testsRegion)) {
    throw new Error("contract tests region must contain at least one Markdown test bullet");
  }
  if (!/negative|must fail|reject/i.test(testsRegion)) {
    throw new Error("contract tests region must contain a negative-case indicator");
  }
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

  await request(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { body: contract },
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
