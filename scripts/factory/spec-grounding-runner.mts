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
 * 1. Fetches the PR (body + head/base SHAs), and parses the body with
 *    {@link parseLinkedIssueReferences}. Empty references ⇒ nothing to
 *    spec-ground; exits early (`has-criteria=false`) before any further
 *    fetch, matching that function's own graceful-no-op contract.
 * 2. Calls {@link selectIssuesToFetch} BEFORE fetching anything else — the
 *    primary control for the fetch-count resource-exhaustion vector that
 *    function's own docstring describes; only its capped output is ever
 *    fetched.
 * 3. Fetches each capped issue number. Only a VERIFIED 404 degrades to
 *    "nothing to say" for that one issue — {@link buildLinkedIssueSpecs}'s
 *    own documented contract for an issue number present in `references`
 *    but absent from the fetched map. Any OTHER failure (403, 429, a 5xx,
 *    a network error) FAILS the whole run (Codex finding, PR #72 review —
 *    a fail-OPEN security bug in an earlier version of this script: since
 *    an omitted issue's unmet criteria never reach the gate at all, a
 *    gaming PR could evade review via an induced or merely lucky transient
 *    fetch failure on its own `Closes`-kind issue. Failing the whole run
 *    is the correct direction — a red CI run over a silently-defanged
 *    gate).
 * 4. Renders the criteria data block ({@link renderCriteriaDataBlock}) and
 *    the trusted criteria spine ({@link buildCriteriaSpine}, built from
 *    that SAME rendered block — see its own docstring for why). An empty
 *    block (every linked issue's criteria already met, or no issue had an
 *    acceptance-criteria section at all) is the SECOND early exit —
 *    still before ever fetching the diff, since there is nothing left to
 *    judge it against.
 * 5. Only once there is real work does it fetch the PR's own diff — for
 *    the TRUSTED head SHA specifically, verified against the PR's current
 *    head before the fetch (Codex finding, PR #72 review — the mutable
 *    `/pulls/{n}` diff endpoint always serves whatever the branch
 *    currently points to; a push landing between the PR-fetch and the
 *    diff-fetch could otherwise pair an earlier body with a later,
 *    unreviewed diff) — and wraps it in its own untrusted-data delimiter
 *    ({@link wrapUntrustedDiffBlock}) — the diff is author-controlled on
 *    this public repo exactly like an issue body is, so it never reaches
 *    slice 3b-ii's prompt unwrapped.
 *
 * TRUSTED PR identity and TRUSTED HEAD SHA (factory-security-reviewer
 * invariant 6, and a named must-cover for slice 3b-ii's pre-open
 * security-reviewer pass per the #12 3b PR-plan sign-off): both
 * `TRUSTED_PR_NUMBER` and `TRUSTED_HEAD_SHA` must come from the GitHub
 * Actions event context (`github.event.pull_request.number` /
 * `github.event.pull_request.head.sha`, wired into these env vars by the
 * workflow YAML) — NEVER re-derived from the PR's own title, body,
 * branch name, or current mutable state, all of which are
 * attacker-influenced (the first three) or racy (the last) on a public
 * repo. This script verifies the PR's OWN reported head SHA against
 * `TRUSTED_HEAD_SHA` before fetching the diff, and fails closed on a
 * mismatch.
 *
 * Required environment variables:
 * - `GH_TOKEN` — the calling job's read-only token.
 * - `GITHUB_REPOSITORY` — `owner/repo` (set automatically by Actions).
 * - `TRUSTED_PR_NUMBER` — from `github.event.pull_request.number`.
 * - `TRUSTED_HEAD_SHA` — from `github.event.pull_request.head.sha`.
 *
 * Optional environment variables (output paths, overridable for tests /
 * local runs; default to the paths slice 3b-ii's workflow step reads
 * from):
 * - `CRITERIA_BLOCK_PATH` (default `review-context/criteria-data-block.txt`)
 * - `CRITERIA_SPINE_PATH` (default `review-context/criteria-spine.json`)
 * - `PR_DIFF_BLOCK_PATH` (default `review-context/pr-diff-block.txt`)
 */

import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { GithubApiError, githubRequest, requireEnv } from "./github-api.mts";
import {
  buildLinkedIssueSpecs,
  parseLinkedIssueReferences,
  renderCriteriaDataBlock,
  selectIssuesToFetch,
  type FetchedIssue,
} from "./spec-grounding-logic.mts";
import {
  buildCriteriaSpine,
  computeCriteriaSpineTruncation,
  GITHUB_COMPARE_DIFF_FILE_LIMIT,
  wrapUntrustedDiffBlock,
} from "./spec-grounding-runner-logic.mts";

interface GitHubPullRequest {
  readonly body: string | null;
  readonly head: { readonly sha: string };
  readonly base: { readonly sha: string };
  /**
   * The PR's TRUE total changed-file count, from the PR resource itself —
   * used to detect when {@link fetchPrDiff}'s compare-endpoint response
   * silently truncated at {@link GITHUB_COMPARE_DIFF_FILE_LIMIT} (Codex
   * finding, PR #72 review round 2, MEDIUM). See
   * `wrapUntrustedDiffBlock`'s `knownFileCountTruncated` option.
   */
  readonly changed_files: number;
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

/**
 * Bytes of CSPRNG entropy in the per-run delimiter nonce — 16 bytes
 * (128 bits), team-lead's explicit floor from the #12 3b-ii PR-plan
 * sign-off, hex-encoded into the fence name
 * (`spec-grounding-logic.mts`'s `buildDataBlockOpen` /
 * `spec-grounding-runner-logic.mts`'s `wrapUntrustedDiffBlock`).
 */
const DELIMITER_NONCE_BYTES = 16;

/**
 * `DELIMITER_NONCE_OVERRIDE` is only ever honoured when this is `true` —
 * see {@link generateDelimiterNonce}'s own docstring for the three-part
 * hardening this gate exists to close (Codex + independent security-
 * reviewer finding, F1-S9 slice 3b-ii-a, issue #12, PR pre-open pass,
 * MEDIUM). `VITEST` is set to the literal string `"true"` automatically
 * by every Vitest test run (verified empirically, not assumed), and by
 * nothing else — a narrower, more precise signal than `NODE_ENV==="test"`
 * would be, which a maintainer could set for an unrelated reason in a
 * real environment.
 */
const NONCE_OVERRIDE_ALLOWED = process.env.VITEST === "true";

/** {@link generateDelimiterNonce}'s own validation for a test-mode `DELIMITER_NONCE_OVERRIDE` value. */
const VALID_NONCE_OVERRIDE_PATTERN = /^[0-9a-f]+$/;

/**
 * Generates this run's delimiter nonce — the categorical end of the
 * three-round delimiter-breakout arms race (F1-S9 slice 3b-ii-a, issue
 * #12): a fresh, unpredictable, CSPRNG-sourced token untrusted text
 * cannot forge, appended to BOTH fence names for this run
 * (`UNTRUSTED_ISSUE_DATA_<nonce>` / `UNTRUSTED_PR_DIFF_<nonce>` — ONE
 * shared token, per team-lead's sign-off: the two fences already stay
 * distinguishable by NAME, and both are read by the same agent in the
 * same prompt regardless).
 *
 * `DELIMITER_NONCE_OVERRIDE` exists ONLY for deterministic test fixtures
 * (team-lead's sign-off: "Fixed-inject the nonce in tests for
 * determinism") — and is now gated behind {@link NONCE_OVERRIDE_ALLOWED}
 * plus format validation (Codex + independent security-reviewer finding,
 * PR pre-open pass, MEDIUM — a real gap in the first version of this
 * function: an unconditional `process.env.DELIMITER_NONCE_OVERRIDE ??
 * randomBytes(...)` had three latent foot-guns, none attacker-reachable
 * in THIS slice — the runner isn't wired to any workflow yet, and Actions
 * env is maintainer-controlled — but this slice EXISTS to establish the
 * nonce guarantee, and slice 3b-ii-c is where any input-to-env mapping
 * first goes live, so closing it here rather than trusting "not
 * reachable yet" to stay true is the fold):
 *
 * 1. `DELIMITER_NONCE_OVERRIDE=""` — `??` does not fall back on an empty
 *    STRING (only `null`/`undefined`), so the nonce becomes `""`, and the
 *    fence collapses to the fully-static, attacker-known
 *    `<UNTRUSTED_ISSUE_DATA_>` / `</UNTRUSTED_ISSUE_DATA_>` — the exact
 *    breakout this whole slice exists to prevent. (And `_>` alone
 *    doesn't match the neutralization patterns' own `(?:_[0-9a-f]+)?`
 *    branch either, since one-or-more hex digits are required — so the
 *    char-class defense-in-depth layer doesn't cover this specific
 *    degenerate case.)
 * 2. Any OTHER pinned value (e.g. always `DELIMITER_NONCE_OVERRIDE=
 *    deadbeef`) is a KNOWN nonce, which is exactly as forgeable as no
 *    nonce at all.
 * 3. No format validation meant the override was written VERBATIM to
 *    `$GITHUB_OUTPUT` (`${key}=${value}\n`) — the CSPRNG path is
 *    guaranteed hex-only and therefore safe there, but the override was
 *    the ONLY path that could carry a literal newline, injecting an
 *    arbitrary SECOND output line (e.g. a value of
 *    `x\nhas-criteria=false` would forge a second, attacker/test-author-
 *    controlled `has-criteria` line).
 *
 * Production (`NONCE_OVERRIDE_ALLOWED === false`) now ALWAYS takes the
 * `crypto.randomBytes` branch, full stop — the environment variable is
 * never even read. In test mode, a set override MUST be non-empty
 * lowercase hex ({@link VALID_NONCE_OVERRIDE_PATTERN}), which by
 * construction can never be empty and can never contain a newline —
 * closing both the nonce-pinning and the `$GITHUB_OUTPUT`-injection
 * vectors at once, not just the reachable-today one.
 *
 * Exported (PR pre-open pass fold) so the production-vs-test-mode GATE
 * itself can be exercised directly: since {@link NONCE_OVERRIDE_ALLOWED}
 * is evaluated once at module load, verifying the production branch
 * requires re-importing this module with `VITEST` unset (`vi.resetModules`
 * + a fresh dynamic `import`) — see this function's own test file for
 * that pattern, the same class of "must genuinely run outside the test
 * runner's own signal" case the self-invoke guard's subprocess test
 * already established a precedent for in this file.
 *
 * @returns A lowercase hex string, {@link DELIMITER_NONCE_BYTES} bytes
 *   (128 bits) of entropy in the production path.
 * @throws In test mode only, if `DELIMITER_NONCE_OVERRIDE` is set to a
 *   value that is not non-empty lowercase hex.
 */
export function generateDelimiterNonce(): string {
  if (NONCE_OVERRIDE_ALLOWED) {
    const override = process.env.DELIMITER_NONCE_OVERRIDE;
    if (override !== undefined) {
      if (!VALID_NONCE_OVERRIDE_PATTERN.test(override)) {
        throw new Error(
          `DELIMITER_NONCE_OVERRIDE must be non-empty lowercase hex, got: ${JSON.stringify(override)}`,
        );
      }
      return override;
    }
  }
  return randomBytes(DELIMITER_NONCE_BYTES).toString("hex");
}

async function fetchPr(token: string, owner: string, repo: string, prNumber: number): Promise<GitHubPullRequest> {
  return githubRequest<GitHubPullRequest>(token, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
}

/**
 * Fetches one linked issue's title/body. Only a VERIFIED 404 degrades to
 * `null` — see this module's own top-level docstring, point 3 (Codex
 * finding, PR #72 review, a fail-open security bug): {@link GithubApiError}'s
 * `status` field is what makes this distinction possible at all; a plain
 * `Error` (the previous shape) gave this function no reliable way to tell
 * a genuine "issue doesn't exist" apart from "the fetch failed for some
 * OTHER reason" short of parsing the error message's text.
 *
 * @throws Any error that is NOT a `GithubApiError` with `status === 404`
 *   — propagates uncaught, failing the whole run.
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
    if (err instanceof GithubApiError && err.status === 404) {
      console.warn(`Issue #${issueNumber} not found (404) — treated as "nothing to say" for this issue.`);
      return null;
    }
    // FAIL CLOSED (Codex finding, PR #72 review): any failure other than
    // a verified 404 — auth/403, rate-limit/429, a 5xx, a network error —
    // must fail the whole run rather than silently omit this issue's
    // unmet criteria from the anti-gaming gate. See this module's own
    // top-level docstring, point 3.
    throw new Error(
      `Failed to fetch issue #${issueNumber} for a reason other than a verified 404 — ` +
        `failing closed rather than silently omitting this issue's criteria from the ` +
        `review: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Fetches the PR's raw unified diff for the EXACT `baseSha...headSha`
 * range via GitHub's compare endpoint (not the mutable `/pulls/{n}` diff
 * endpoint, which always serves whatever the branch currently points to —
 * Codex finding, PR #72 review, low severity but cheap to fix: pins the
 * diff to the same trusted head SHA {@link main} already verified the PR
 * against, so a push landing between the PR-fetch and this call can never
 * pair an earlier-fetched body with a later, unreviewed diff). A plain
 * text response, not JSON (see {@link githubRequest}'s `responseType`
 * option). Unlike {@link fetchIssue}, a failure here propagates
 * uncaught: there is no meaningful "nothing to say" degradation for the
 * PR's OWN diff — without it, there is nothing for slice 3b-ii's review
 * agent to check the criteria against at all.
 */
async function fetchPrDiff(
  token: string,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  return githubRequest<string>(
    token,
    "GET",
    `/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`,
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
  // TRUSTED PR identity and head SHA — see this module's own top-level
  // docstring.
  const prNumber = Number(requireEnv("TRUSTED_PR_NUMBER"));
  const trustedHeadSha = requireEnv("TRUSTED_HEAD_SHA");
  const paths = resolvePaths();
  // One shared per-run nonce for BOTH fences — see generateDelimiterNonce's
  // own docstring. Generated unconditionally (cheap, no I/O) even though
  // an early exit below may never use it.
  const nonce = generateDelimiterNonce();

  const pr = await fetchPr(token, owner, repo, prNumber);
  if (pr.head.sha !== trustedHeadSha) {
    // FAIL CLOSED (Codex finding, PR #72 review): the PR moved between
    // whatever triggered this run and this fetch — reviewing a diff that
    // may not match the trusted event this run was actually triggered for
    // would be worse than failing outright.
    throw new Error(
      `PR #${prNumber}'s current head SHA (${pr.head.sha}) does not match the trusted ` +
        `event head SHA (${trustedHeadSha}) — the PR moved between the review trigger and ` +
        `this fetch; failing closed rather than reviewing a possibly-stale or possibly-newer diff.`,
    );
  }
  const references = parseLinkedIssueReferences(pr.body ?? "", `${owner}/${repo}`);

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
  const criteriaBlock = renderCriteriaDataBlock(result, nonce);

  if (criteriaBlock === "") {
    console.log(
      `PR #${prNumber}'s linked issue(s) have no unmet acceptance criteria; nothing to spec-ground.`,
    );
    writeGithubOutput("has-criteria", "false");
    return;
  }

  const spine = buildCriteriaSpine(result, criteriaBlock, nonce);
  // Trusted truncation metadata (Codex finding, PR #76 review, L181 —
  // slice 3b-iii's own disposition): computed ADDITIVELY from data already
  // in hand, never a change to buildCriteriaSpine's own signature or
  // internal truncation tracking — see computeCriteriaSpineTruncation's
  // own docstring for the full reasoning.
  const truncationSummary = computeCriteriaSpineTruncation(references, result, spine);
  const diff = await fetchPrDiff(token, owner, repo, pr.base.sha, pr.head.sha);
  // Detects GitHub's compare-endpoint 300-changed-file cap (Codex finding,
  // PR #72 review round 2, MEDIUM): the diff media type is plain text with
  // no in-band truncation marker, so this compares the PR's OWN reported
  // total against the documented cap — a trusted source independent of
  // the diff text itself.
  const diffBlock = wrapUntrustedDiffBlock(diff, nonce, undefined, {
    knownFileCountTruncated: pr.changed_files > GITHUB_COMPARE_DIFF_FILE_LIMIT,
  });

  await writeOutputFile(paths.criteriaBlockPath, criteriaBlock);
  // criteria-spine.json's TOP-LEVEL shape is now a wrapper object, not a
  // bare array (Codex finding, PR #76 review, L181): `entries` is the
  // array the review agent's own criterionId correlation matches against
  // (unchanged shape from before); `truncated`/`droppedClosingIssueNumbers`
  // are new trusted metadata for slice 3b-iii's privileged publisher only
  // — the read-only review agent never reads or acts on these two fields.
  await writeOutputFile(
    paths.criteriaSpinePath,
    JSON.stringify(
      {
        entries: spine,
        truncated: truncationSummary.truncated,
        droppedClosingIssueNumbers: truncationSummary.droppedClosingIssueNumbers,
      },
      null,
      2,
    ),
  );
  await writeOutputFile(paths.prDiffBlockPath, diffBlock);

  console.log(
    `Wrote spec-grounding context for PR #${prNumber}: ${spine.length} unmet criterion(ia) ` +
      `across ${result.specs.length} linked issue(s).`,
  );
  writeGithubOutput("has-criteria", "true");
  // The nonce is trusted, short, and non-attacker-influenced (this
  // process generated it), so slice 3b-ii-c's prompt-composition step can
  // safely interpolate it directly into the workflow's prompt string —
  // unlike the criteria/spine/diff CONTENT above, which stays file-based
  // and reaches the agent only via its Read tool, never spliced into
  // workflow YAML (see the #12 3b-ii PR-plan sign-off for why that
  // boundary matters).
  writeGithubOutput("delimiter-nonce", nonce);
}

// Only self-invoke when run directly, not when imported by a test —
// matches `apply-triage-verdict.mts`'s own identical guard. Genuinely
// exercised by a REAL subprocess test (spawning `node
// --experimental-strip-types` against this file, the exact form
// triage-issues.yml/implement-ready-issues.yml use for the sibling
// scripts) in spec-grounding-runner.test.ts — but v8/istanbul coverage
// instrumentation only tracks code executed IN-PROCESS by the vitest
// worker itself, never inside a spawned child process, so that
// subprocess test (verified to genuinely pass and genuinely exercise
// this exact branch) still cannot contribute LINE coverage credit here,
// a structural tooling limitation, not a gap in what's tested.
/* v8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("spec-grounding-runner failed:", err);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
