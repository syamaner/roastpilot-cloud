import { githubRequest, requireEnv } from "./github-api.mts";
import {
  READY_TO_SPEC_LABEL,
  decideSweepIssue,
  isIssueHandled,
  type SweepIssue,
  type SweepLabelOperation,
} from "./story-planner-sweep-logic.mts";
import type { StoryPlannerMarkerComment } from "./story-planner-marker.mts";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PAGE_SIZE = 100;
export const MAX_PAGES = 50;
export const MAX_CONFIRMATION_ATTEMPTS = 3;
export const MAX_LABEL_READD_ATTEMPTS = 3;
const CONFIRMATION_RETRY_DELAY_MS = 10_000;

export type GithubRequest = <T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

interface SweepDependencies {
  readonly request: GithubRequest;
  readonly ghToken: string;
  readonly appToken: string;
  readonly owner: string;
  readonly repo: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly log?: (message: string) => void;
  readonly error?: (message: string) => void;
}

function validateIssue(raw: unknown, expectedState: SweepIssue["state"]): SweepIssue {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("number" in raw) ||
    !Number.isSafeInteger(raw.number) ||
    typeof raw.number !== "number" ||
    raw.number < 1 ||
    !("state" in raw) ||
    raw.state !== expectedState ||
    "pull_request" in raw ||
    !("labels" in raw) ||
    !Array.isArray(raw.labels)
  ) {
    throw new Error(`malformed ${expectedState} ready-to-spec issue response`);
  }
  const labels = raw.labels.map((label: unknown) => {
    if (typeof label === "string") return label;
    if (
      typeof label === "object" &&
      label !== null &&
      "name" in label &&
      typeof label.name === "string"
    ) return label.name;
    throw new Error(`malformed ${expectedState} ready-to-spec issue response`);
  });
  if (!labels.includes(READY_TO_SPEC_LABEL)) {
    throw new Error(`malformed ${expectedState} ready-to-spec issue response`);
  }
  return { number: raw.number, state: expectedState };
}

export async function enumerateReadyToSpecIssues(
  request: GithubRequest,
  token: string,
  owner: string,
  repo: string,
  state: SweepIssue["state"],
): Promise<SweepIssue[]> {
  const issues: SweepIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const results = await request<unknown>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues?labels=${READY_TO_SPEC_LABEL}&state=${state}&per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(results)) {
      throw new Error(`malformed ${state} ready-to-spec issue response`);
    }
    issues.push(...results.map((issue) => validateIssue(issue, state)));
    if (results.length < PAGE_SIZE) return issues;
  }
  throw new Error(`ready-to-spec ${state} issue enumeration exceeded ${MAX_PAGES} pages`);
}

async function fetchComments(
  request: GithubRequest,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<StoryPlannerMarkerComment[]> {
  const comments: StoryPlannerMarkerComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const results = await request<StoryPlannerMarkerComment[]>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`,
    );
    comments.push(...results);
    if (results.length < PAGE_SIZE) return comments;
  }
  throw new Error(`comment enumeration for #${issueNumber} exceeded ${MAX_PAGES} pages`);
}

async function isStillOpenReadyToSpec(
  request: GithubRequest,
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<boolean> {
  const raw = await request<unknown>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}`,
  );
  try {
    validateIssue(raw, "open");
    return true;
  } catch (error) {
    if (
      typeof raw === "object" &&
      raw !== null &&
      "state" in raw &&
      raw.state === "closed"
    ) return false;
    throw error;
  }
}

async function writeLabelOperation(
  request: GithubRequest,
  appToken: string,
  owner: string,
  repo: string,
  issueNumber: number,
  operation: SweepLabelOperation,
  reportError: (message: string) => void,
): Promise<void> {
  const issuePath = `/repos/${owner}/${repo}/issues/${issueNumber}`;
  if (operation.method === "DELETE") {
    await request(
      appToken,
      "DELETE",
      `${issuePath}/labels/${encodeURIComponent(operation.label)}`,
    );
    return;
  }
  for (let attempt = 1; attempt <= MAX_LABEL_READD_ATTEMPTS; attempt += 1) {
    try {
      await request(appToken, "POST", `${issuePath}/labels`, {
        labels: [operation.label],
      });
      return;
    } catch (error) {
      if (attempt === MAX_LABEL_READD_ATTEMPTS) {
        reportError(
          `::error::Failed to re-add ${READY_TO_SPEC_LABEL} to issue #${issueNumber} ` +
            `after ${MAX_LABEL_READD_ATTEMPTS} attempts. Manually re-add ` +
            `${READY_TO_SPEC_LABEL} to issue #${issueNumber}; its prior DELETE succeeded.`,
        );
        throw error;
      }
    }
  }
}

async function confirmHandled(
  dependencies: SweepDependencies,
  issueNumber: number,
): Promise<boolean> {
  // Production timing fallback; tests inject sleep to avoid real wall-clock waits.
  /* v8 ignore start */
  const sleep = dependencies.sleep ??
    ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  /* v8 ignore stop */
  for (let attempt = 1; attempt <= MAX_CONFIRMATION_ATTEMPTS; attempt += 1) {
    const comments = await fetchComments(
      dependencies.request,
      dependencies.ghToken,
      dependencies.owner,
      dependencies.repo,
      issueNumber,
    );
    if (isIssueHandled(comments, issueNumber)) return true;
    if (attempt < MAX_CONFIRMATION_ATTEMPTS) {
      await sleep(CONFIRMATION_RETRY_DELAY_MS);
    }
  }
  return false;
}

export async function runSweep(dependencies: SweepDependencies): Promise<void> {
  if (dependencies.appToken.trim() === "") {
    throw new Error("FACTORY_APP_TOKEN is required; refusing all label writes");
  }
  const log = dependencies.log ?? console.log;
  const openIssues = await enumerateReadyToSpecIssues(
    dependencies.request,
    dependencies.ghToken,
    dependencies.owner,
    dependencies.repo,
    "open",
  );
  const closedIssues = await enumerateReadyToSpecIssues(
    dependencies.request,
    dependencies.ghToken,
    dependencies.owner,
    dependencies.repo,
    "closed",
  );

  for (const issue of [...closedIssues, ...openIssues]) {
    const comments = await fetchComments(
      dependencies.request,
      dependencies.ghToken,
      dependencies.owner,
      dependencies.repo,
      issue.number,
    );
    const decision = decideSweepIssue(issue, comments);
    if (decision.kind === "skip-handled") {
      log(JSON.stringify({ issue_number: issue.number, result: "already-handled" }));
      continue;
    }
    if (decision.kind === "log-closed") {
      log(JSON.stringify({ issue_number: issue.number, result: "closed-unplanned-no-write" }));
      continue;
    }
    if (!await isStillOpenReadyToSpec(
      dependencies.request,
      dependencies.ghToken,
      dependencies.owner,
      dependencies.repo,
      issue.number,
    )) {
      log(JSON.stringify({ issue_number: issue.number, result: "closed-before-write-no-write" }));
      continue;
    }
    for (const operation of decision.operations) {
      await writeLabelOperation(
        dependencies.request,
        dependencies.appToken,
        dependencies.owner,
        dependencies.repo,
        issue.number,
        operation,
        dependencies.error ?? console.error,
      );
    }
    const planned = await confirmHandled(dependencies, issue.number);
    log(JSON.stringify({
      issue_number: issue.number,
      result: planned ? "planned" : "still-unplanned-after-bounded-confirmation",
    }));
  }
}

export async function main(request: GithubRequest = githubRequest): Promise<void> {
  const ghToken = requireEnv("GH_TOKEN");
  const appToken = requireEnv("FACTORY_APP_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be canonical "owner/repo"');
  }
  const [owner, repo] = repository.split("/", 2) as [string, string];
  await runSweep({ request, ghToken, appToken, owner, repo });
}

/* v8 ignore start -- exercised by the workflow process, not import-based tests. */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error("story-planner sweep failed:", error);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
