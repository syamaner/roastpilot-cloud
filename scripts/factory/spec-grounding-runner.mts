/**
 * CLI entrypoint for slice 3b-i's runner (F1-S9 slice 3b, issue #12): the
 * deterministic, network-facing half of "spec-grounded review" — fetches
 * exactly what `spec-grounding-logic.mts`'s pure extraction functions need,
 * calls them in the order their own docstrings require, and writes their
 * output to disk for slice 3b-ii's read-only review-agent job to `Read`.
 *
 * This script itself holds a READ-ONLY GitHub token (`GH_TOKEN`, scoped by
 * the calling job's `permissions: contents: read, pull-requests: read,
 * issues: read` — it never writes anything back to GitHub) and never
 * invokes an LLM. It is pure orchestration + I/O over already-reviewed,
 * already-tested pure logic:
 *
 * 1. Fetches the PR body, and parses it with
 *    {@link parseLinkedIssueReferences}. Empty references ⇒ nothing to
 *    spec-ground; exits early (`has-criteria=false`) before any further
 *    fetch, matching that function's own graceful-no-op contract.
 * 2. Calls {@link selectIssuesToFetch} BEFORE fetching anything else — the
 *    primary control for the fetch-count resource-exhaustion vector that
 *    function's own docstring describes; only its capped output is ever
 *    fetched.
 * 3. Fetches each capped issue number, tolerating a per-issue failure (a
 *    404, a deleted issue, a transient error) as "nothing to say" for
 *    that one issue — {@link buildLinkedIssueSpecs}'s own documented
 *    contract for an issue number present in `references` but absent from
 *    the fetched map — rather than failing the whole run over one bad
 *    fetch.
 * 4. Renders the criteria data block ({@link renderCriteriaDataBlock}) and
 *    the trusted criteria spine ({@link buildCriteriaSpine}). An empty
 *    block (every linked issue's criteria already met, or no issue had an
 *    acceptance-criteria section at all) is the SECOND early exit —
 *    still before ever fetching the diff, since there is nothing left to
 *    judge it against.
 * 5. Only once there is real work does it fetch the PR's own diff and wrap
 *    it in its own untrusted-data delimiter
 *    ({@link wrapUntrustedDiffBlock}) — the diff is author-controlled on
 *    this public repo exactly like an issue body is, so it never reaches
 *    slice 3b-ii's prompt unwrapped.
 *
 * TRUSTED PR identity (factory-security-reviewer invariant 6, and a named
 * must-cover for slice 3b-ii's pre-open security-reviewer pass per the #12
 * 3b PR-plan sign-off): `TRUSTED_PR_NUMBER` must come from the GitHub
 * Actions event context (`github.event.pull_request.number`, wired into
 * this env var by the workflow YAML) — NEVER re-derived from the PR's own
 * title, body, or branch name, all of which are attacker-influenced on a
 * public repo. This script never reads any of those three to determine
 * which PR it is reviewing.
 *
 * Required environment variables:
 * - `GH_TOKEN` — the calling job's read-only token.
 * - `GITHUB_REPOSITORY` — `owner/repo` (set automatically by Actions).
 * - `TRUSTED_PR_NUMBER` — from `github.event.pull_request.number`.
 *
 * Optional environment variables (output paths, overridable for tests /
 * local runs; default to the paths slice 3b-ii's workflow step reads
 * from):
 * - `CRITERIA_BLOCK_PATH` (default `review-context/criteria-data-block.txt`)
 * - `CRITERIA_SPINE_PATH` (default `review-context/criteria-spine.json`)
 * - `PR_DIFF_BLOCK_PATH` (default `review-context/pr-diff-block.txt`)
 */

import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { githubRequest, requireEnv } from "./github-api.mts";
import {
  buildLinkedIssueSpecs,
  parseLinkedIssueReferences,
  renderCriteriaDataBlock,
  selectIssuesToFetch,
  type FetchedIssue,
} from "./spec-grounding-logic.mts";
import { buildCriteriaSpine, wrapUntrustedDiffBlock } from "./spec-grounding-runner-logic.mts";

interface GitHubPullRequest {
  readonly body: string | null;
}

interface GitHubIssue {
  readonly title: string;
  readonly body: string | null;
}

interface RunnerPaths {
  readonly criteriaBlockPath: string;
  readonly criteriaSpinePath: string;
  readonly prDiffBlockPath: string;
}

const DEFAULT_PATHS: RunnerPaths = {
  criteriaBlockPath: "review-context/criteria-data-block.txt",
  criteriaSpinePath: "review-context/criteria-spine.json",
  prDiffBlockPath: "review-context/pr-diff-block.txt",
};

function resolvePaths(): RunnerPaths {
  return {
    criteriaBlockPath: process.env.CRITERIA_BLOCK_PATH ?? DEFAULT_PATHS.criteriaBlockPath,
    criteriaSpinePath: process.env.CRITERIA_SPINE_PATH ?? DEFAULT_PATHS.criteriaSpinePath,
    prDiffBlockPath: process.env.PR_DIFF_BLOCK_PATH ?? DEFAULT_PATHS.prDiffBlockPath,
  };
}

async function fetchPrBody(token: string, owner: string, repo: string, prNumber: number): Promise<string> {
  const pr = await githubRequest<GitHubPullRequest>(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
  );
  return pr.body ?? "";
}

/**
 * Fetches one linked issue's title/body, tolerating any failure (404 for a
 * deleted issue, a transient error) as `null` rather than throwing — see
 * this module's own top-level docstring, point 3: {@link buildLinkedIssueSpecs}
 * already treats a missing map entry as "nothing to say" for that issue,
 * so a per-issue fetch failure degrades the same way a real 404 would,
 * never failing the whole run.
 */
async function fetchIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<FetchedIssue | null> {
  try {
    const issue = await githubRequest<GitHubIssue>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
    );
    return { title: issue.title, body: issue.body ?? "" };
  } catch (err) {
    console.warn(
      `Failed to fetch issue #${issueNumber} (treated as "nothing to say" for this issue): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Fetches the PR's raw unified diff via GitHub's diff media type — a plain
 * text response, not JSON (see {@link githubRequest}'s `responseType`
 * option, added for exactly this call). Unlike {@link fetchIssue}, a
 * failure here propagates: there is no meaningful "nothing to say"
 * degradation for the PR's OWN diff — without it, there is nothing for
 * slice 3b-ii's review agent to check the criteria against at all.
 */
async function fetchPrDiff(token: string, owner: string, repo: string, prNumber: number): Promise<string> {
  return githubRequest<string>(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
    undefined,
    { accept: "application/vnd.github.v3.diff", responseType: "text" },
  );
}

async function writeOutputFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

/**
 * Appends a `key=value` line to `$GITHUB_OUTPUT`, silently no-op'ing when
 * the env var is unset — never set outside a real Actions run (every
 * unit/integration test in this repo, and a local invocation), matching
 * `publish-implement-patch.mts`'s own `writeStepSummary` precedent: this
 * is workflow-wiring plumbing, not something a missing env var should
 * crash the run over.
 *
 * Inside a real run, an unset `has-criteria` output is read by the
 * downstream review-agent step's `if:` as empty/falsy — the SAME safe
 * direction as writing `"false"` explicitly: the review pass is skipped,
 * never silently run against incomplete or absent context.
 */
function writeGithubOutput(key: string, value: string): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  appendFileSync(outputPath, `${key}=${value}\n`);
}

export async function main(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY must be "owner/repo", got ${process.env.GITHUB_REPOSITORY}`,
    );
  }
  // TRUSTED PR identity — see this module's own top-level docstring.
  const prNumber = Number(requireEnv("TRUSTED_PR_NUMBER"));
  const paths = resolvePaths();

  const prBody = await fetchPrBody(token, owner, repo, prNumber);
  const references = parseLinkedIssueReferences(prBody, `${owner}/${repo}`);

  if (references.length === 0) {
    console.log(`PR #${prNumber} references no issue; nothing to spec-ground.`);
    writeGithubOutput("has-criteria", "false");
    return;
  }

  const toFetch = selectIssuesToFetch(references);
  const issuesMap = new Map<number, FetchedIssue>();
  for (const reference of toFetch) {
    const issue = await fetchIssue(token, owner, repo, reference.issueNumber);
    if (issue !== null) {
      issuesMap.set(reference.issueNumber, issue);
    }
  }

  const result = buildLinkedIssueSpecs(references, issuesMap);
  const criteriaBlock = renderCriteriaDataBlock(result);

  if (criteriaBlock === "") {
    console.log(
      `PR #${prNumber}'s linked issue(s) have no unmet acceptance criteria; nothing to spec-ground.`,
    );
    writeGithubOutput("has-criteria", "false");
    return;
  }

  const spine = buildCriteriaSpine(result);
  const diff = await fetchPrDiff(token, owner, repo, prNumber);
  const diffBlock = wrapUntrustedDiffBlock(diff);

  await writeOutputFile(paths.criteriaBlockPath, criteriaBlock);
  await writeOutputFile(paths.criteriaSpinePath, JSON.stringify(spine, null, 2));
  await writeOutputFile(paths.prDiffBlockPath, diffBlock);

  console.log(
    `Wrote spec-grounding context for PR #${prNumber}: ${spine.length} unmet criterion(ia) ` +
      `across ${result.specs.length} linked issue(s).`,
  );
  writeGithubOutput("has-criteria", "true");
}

// Only self-invoke when run directly, not when imported by a test —
// matches `apply-triage-verdict.mts`'s own identical guard.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("spec-grounding-runner failed:", err);
    process.exitCode = 1;
  });
}
