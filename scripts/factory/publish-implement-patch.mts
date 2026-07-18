/**
 * CLI entrypoint for the privileged `publish` job in
 * `.github/workflows/implement-ready-issues.yml`.
 *
 * This is the ONLY piece of the implement pipeline that holds a writable
 * GitHub token, and it never runs anything the agent produced as code — a
 * `git diff` patch is DATA applied by `git apply` (a structured-diff
 * consumer, not a script interpreter), never executed. Mirrors
 * `apply-triage-verdict.mts`'s shape closely: read an artifact the
 * read-only agent job produced, validate it thoroughly BEFORE trusting it,
 * and only then perform the privileged side effects — here, applying the
 * patch, pushing a branch, and opening a PR, instead of a label/comment.
 *
 * Exactly one outcome, always: either the patch is valid and a PR is
 * opened/refreshed, or it isn't and a single explanatory comment is posted
 * on the issue with no branch and no PR created. Every git/API operation
 * happens inside one `main()` so there is exactly one place a comment gets
 * posted, instead of coordinating comment-avoidance across several
 * workflow steps and their `if:` conditions.
 *
 * Required environment variables:
 * - `GH_TOKEN` — the job's `permissions: contents: write, pull-requests:
 *   write, issues: write` token.
 * - `GITHUB_REPOSITORY` — `owner/repo`.
 * - `TRUSTED_ISSUE_NUMBER` — from the `workflow_dispatch` `issue_number`
 *   input. Trusted because dispatch-first means a human explicitly chose
 *   this issue for this run — the human dispatch IS the authorization
 *   seam (factory.md's staged-autonomy note); this is not read from
 *   anything agent-controlled.
 * - `IMPLEMENT_JOB_RESULT` — `needs.implement.result`. A patch artifact is
 *   only ever trusted when this is exactly `"success"` — same F1-S2
 *   lesson (FIX E) applied here: the `implement` step uploads its patch
 *   with `if: always()`, so a non-empty, well-formed patch can exist even
 *   from a run that did not succeed.
 * - `PATCH_PATH` — path to the downloaded patch artifact (may not exist).
 * - `RUN_URL` — link to the implement run, for the PR body / failure
 *   comment.
 */

import { readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { githubRequest, requireEnv } from "./github-api.mts";
import {
  extractChangedPathsFromDiff,
  isEmptyDiff,
  MAX_PATCH_BYTES,
} from "./patch-diff.mts";
import {
  buildImplementFailureCommentBody,
  buildImplementPrBody,
  deriveBranchName,
  findForbiddenPatchPaths,
} from "./implement-patch-logic.mts";

/**
 * Raised for a validated, expected reason implementation must not
 * proceed (bad job result, oversized/empty/forbidden patch) — as opposed
 * to an unexpected error (a git or API call failing). Both end up posting
 * the same shape of comment; the distinction only changes the wording.
 */
class PublishRejection extends Error {}

interface GitHubIssue {
  readonly title: string;
}

interface GitHubPullRequest {
  readonly html_url: string;
  readonly number: number;
}

/** Reads the patch artifact, enforcing the size cap before ever reading its content. */
async function readPatchArtifact(path: string): Promise<string> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(path);
  } catch (err) {
    throw new PublishRejection(
      `patch artifact not found at ${path} (implement job likely failed or ` +
        `produced no output): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (fileStat.size > MAX_PATCH_BYTES) {
    throw new PublishRejection(
      `patch artifact at ${path} is ${fileStat.size} bytes, exceeds the ` +
        `${MAX_PATCH_BYTES}-byte limit — rejected before being read into memory`,
    );
  }
  return readFile(path, "utf8");
}

function runGit(args: string[]): void {
  execFileSync("git", args, { stdio: "pipe" });
}

/**
 * Applies the patch, commits, and pushes the branch. All arguments that
 * reach `execFileSync` here are either paths we control or the
 * already-sanitized `branchName` (see `deriveBranchName` —
 * `[a-z0-9-]+`-only, so it carries no shell-meaningful characters even
 * though `execFileSync` with an argv array never invokes a shell to begin
 * with). The patch file's own content is never passed as an argv value —
 * `git apply` reads it directly from disk.
 */
function applyPatchAndPush(
  branchName: string,
  patchPath: string,
  issueNumber: number,
  issueTitle: string,
): void {
  runGit(["config", "user.name", "github-actions[bot]"]);
  runGit([
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  runGit(["checkout", "-b", branchName]);
  runGit(["apply", patchPath]);
  runGit(["add", "-A"]);
  const commitTitle = `Implement #${issueNumber}: ${issueTitle}`.slice(
    0,
    120,
  );
  runGit(["commit", "-m", commitTitle, "-m", `Closes #${issueNumber}`]);
  runGit(["push", "--force", "origin", branchName]);
}

/**
 * Finds an existing open PR for this branch, if any (idempotency guard —
 * factory.md §13 point 8: a re-dispatch of the same issue must refresh the
 * existing PR, not open a duplicate).
 */
async function findExistingPr(
  token: string,
  owner: string,
  repo: string,
  branchName: string,
): Promise<GitHubPullRequest | null> {
  const results = await githubRequest<GitHubPullRequest[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls?head=${owner}:${branchName}&state=open`,
  );
  return results[0] ?? null;
}

async function postFailureComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  reasons: readonly string[],
  runUrl: string,
): Promise<void> {
  await githubRequest(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { body: buildImplementFailureCommentBody(reasons, runUrl) },
  );
}

export async function main(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY must be "owner/repo", got ${process.env.GITHUB_REPOSITORY}`,
    );
  }
  const issueNumber = Number(requireEnv("TRUSTED_ISSUE_NUMBER"));
  const implementJobResult = requireEnv("IMPLEMENT_JOB_RESULT");
  const patchPath = process.env.PATCH_PATH ?? "patch-output/patch.diff";
  const runUrl = requireEnv("RUN_URL");

  try {
    if (implementJobResult !== "success") {
      throw new PublishRejection(
        `implement job result was "${implementJobResult}", not "success" — ` +
          `the patch artifact (even if present and well-formed) is not ` +
          `trusted; only a successful implement run's patch is ever applied`,
      );
    }

    const patchContent = await readPatchArtifact(patchPath);

    if (isEmptyDiff(patchContent)) {
      throw new PublishRejection(
        "the implement run produced no changes (empty patch)",
      );
    }

    const changedPaths = extractChangedPathsFromDiff(patchContent);
    const forbidden = findForbiddenPatchPaths(changedPaths);
    if (forbidden.length > 0) {
      throw new PublishRejection(
        `patch touches pipeline-protected path(s), refusing to apply it: ` +
          forbidden.join(", "),
      );
    }

    const issue = await githubRequest<GitHubIssue>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
    );
    const branchName = deriveBranchName(issueNumber, issue.title);

    applyPatchAndPush(branchName, patchPath, issueNumber, issue.title);

    const existingPr = await findExistingPr(token, owner, repo, branchName);
    if (existingPr) {
      console.log(
        `PR #${existingPr.number} already exists for ${branchName}; branch ` +
          `refreshed, not opening a duplicate.`,
      );
      return;
    }

    const created = await githubRequest<GitHubPullRequest>(
      token,
      "POST",
      `/repos/${owner}/${repo}/pulls`,
      {
        title: `[#${issueNumber}] ${issue.title.replace(/^\s*\[[^\]]*\]\s*/, "")}`,
        head: branchName,
        base: "main",
        body: buildImplementPrBody({ issueNumber, runUrl }),
      },
    );
    console.log(`Opened PR #${created.number}: ${created.html_url}`);
  } catch (err) {
    const reasons =
      err instanceof PublishRejection
        ? [err.message]
        : [`unexpected error: ${err instanceof Error ? err.message : String(err)}`];
    await postFailureComment(token, owner, repo, issueNumber, reasons, runUrl);
    console.error(
      `Implement run for #${issueNumber} did not produce a PR. Reasons:\n` +
        reasons.map((r) => `  - ${r}`).join("\n"),
    );
    process.exitCode = 1;
  }
}

// Only self-invoke when run directly (`node publish-implement-patch.mts`),
// not when imported by a test. Genuinely uncovered by unit tests (they
// import `main` directly rather than exec'ing the file) — exercised
// instead by running the script directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("publish-implement-patch failed:", err);
    process.exitCode = 1;
  });
}
