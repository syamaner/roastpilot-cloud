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
 * The patch-path guard is APPLIER-AUTHORITATIVE, not a re-parse: it asks
 * `git apply --numstat` what the patch will actually touch, with the exact
 * same invocation (no `-p` override, on either call) that later applies
 * it — see {@link getAuthoritativeChangedPaths}'s docstring for the exploit
 * this replaced (a `zz/`-style diff-header prefix reads as an unprotected
 * path to a naive `a/`/`b/`-stripping parser, but `git apply`'s own
 * default `-p1` strips whatever the first path segment actually is,
 * landing the write at a *different, protected* path than the one the
 * parser checked).
 *
 * Exactly one outcome, always: either the patch is valid and a PR is
 * opened/refreshed, or it isn't and a single explanatory comment is posted
 * on the issue. Every git/API operation happens inside one `main()` so
 * there is exactly one place a comment gets posted, instead of
 * coordinating comment-avoidance across several workflow steps and their
 * `if:` conditions.
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

import { stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { githubRequest, requireEnv } from "./github-api.mts";
import {
  buildImplementFailureCommentBody,
  buildImplementPrBody,
  deriveBranchName,
  findForbiddenPatchPaths,
  findPrForIssueNumber,
  findProtectedPathMentionsInSummaryText,
  parseNumstatZ,
  type PullRequestSummary,
} from "./implement-patch-logic.mts";

/**
 * Upper bound on the on-disk patch artifact size, in bytes, checked via
 * `stat` BEFORE the file is read/processed at all — same DoS-guard
 * rationale as `MAX_PAYLOAD_BYTES` in `triage-verdict-schema.mts`, sized
 * up from that verdict-JSON bound since a real code patch is legitimately
 * much larger. 2 MiB comfortably covers the house "thin slice" convention
 * (~400 changed lines, plus diff context and test files) with a lot of
 * headroom, while still being far below anything that could meaningfully
 * stall the runner or `git apply` itself.
 */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

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

interface GitHubPullRequestApi {
  readonly html_url: string;
  readonly number: number;
  readonly head: { readonly ref: string };
}

/** Enforces the size cap via `stat`, before the file is touched any other way. */
async function assertPatchArtifactSize(path: string): Promise<void> {
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
}

/**
 * Asks `git apply` itself which paths the patch will touch, via
 * `git apply --numstat -z <patch>` — deliberately NOT a re-parse of the
 * diff text. An earlier version of this guard parsed `diff --git a/X b/Y`
 * header lines directly and stripped a literal `a/`/`b/` prefix before
 * checking against protected paths. That is exploitable: `git apply`'s
 * default `-p1` strips whatever the diff header's first path segment
 * actually is — not specifically `a`/`b` — so a patch whose headers read
 * `diff --git zz/.github/workflows/evil.yml zz/.github/workflows/evil.yml`
 * parses (under the old logic) as touching the harmless path
 * `zz/.github/workflows/evil.yml`, while the SAME default `git apply`
 * strips `zz/` and writes to the *actually protected*
 * `.github/workflows/evil.yml`. No amount of smarter regex closes this —
 * the guard and the applier were two independent implementations of "what
 * does `-p1` strip", and any two independent implementations of the same
 * parsing logic can diverge. Asking git is the only way to guarantee
 * agreement, because it's the same tool doing both the reporting and the
 * later real apply, with the identical invocation (no `-p` override on
 * either call).
 *
 * `--numstat` only reports the DESTINATION path for a rename (not the
 * source) — `getPatchSummaryText` + `findProtectedPathMentionsInSummaryText`
 * is the complementary check for that gap.
 *
 * @param patchPath - Path to the patch file.
 * @returns The destination path of every file the patch touches.
 * @throws {PublishRejection} If the patch can't be parsed at all
 *   (malformed, or genuinely empty).
 */
function getAuthoritativeChangedPaths(patchPath: string): string[] {
  let output: string;
  try {
    output = execFileSync("git", ["apply", "--numstat", "-z", patchPath], {
      encoding: "utf8",
    });
  } catch (err) {
    throw new PublishRejection(
      `patch could not be parsed by git apply --numstat (malformed or ` +
        `unreadable patch): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseNumstatZ(output);
}

/** Raw `git apply --summary` text — see `findProtectedPathMentionsInSummaryText`'s docstring for why this is checked too. */
function getPatchSummaryText(patchPath: string): string {
  try {
    return execFileSync("git", ["apply", "--summary", patchPath], {
      encoding: "utf8",
    });
  } catch (err) {
    // Not independently exercised by a unit test: --summary and --numstat
    // parse the same underlying patch with the same parser, and --numstat
    // (called first, above) already rejects anything malformed enough to
    // fail here — a patch that gets this far genuinely parses. Kept as a
    // defensive fallback in case that assumption is ever wrong.
    throw new PublishRejection(
      `patch could not be summarized by git apply --summary (malformed or ` +
        `unreadable patch): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
 * `git apply` reads it directly from disk, with the SAME invocation (no
 * `-p` override) as `getAuthoritativeChangedPaths` used to check it.
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
  runGit(["checkout", "-B", branchName]);
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
 * Finds the existing open PR for this issue, if any — see
 * `findPrForIssueNumber`'s docstring for why this keys off the issue
 * number (a stable `feature/{issueNumber}-` branch prefix) rather than
 * the exact branch name a fresh `deriveBranchName` call would produce
 * from today's title.
 */
async function findExistingPrForIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<PullRequestSummary | null> {
  const results = await githubRequest<GitHubPullRequestApi[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
  );
  const summaries: PullRequestSummary[] = results.map((pr) => ({
    number: pr.number,
    headRef: pr.head.ref,
  }));
  return findPrForIssueNumber(summaries, issueNumber);
}

async function postFailureComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  reasons: readonly string[],
  runUrl: string,
  branchPushed: boolean,
): Promise<void> {
  await githubRequest(
    token,
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    { body: buildImplementFailureCommentBody(reasons, runUrl, branchPushed) },
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

  // Tracked outside the try so the catch block can tell an unpushed
  // rejection apart from a post-push failure (FIX 5) — a branch that WAS
  // successfully pushed before something later failed must never be
  // reported as "no branch was created".
  let branchName: string | undefined;
  let branchPushed = false;

  try {
    if (implementJobResult !== "success") {
      throw new PublishRejection(
        `implement job result was "${implementJobResult}", not "success" — ` +
          `the patch artifact (even if present and well-formed) is not ` +
          `trusted; only a successful implement run's patch is ever applied`,
      );
    }

    await assertPatchArtifactSize(patchPath);

    const changedPaths = getAuthoritativeChangedPaths(patchPath);
    if (changedPaths.length === 0) {
      // Not independently exercised by a unit test: every real-patch
      // shape tried empirically (including a mode-change-only diff,
      // which has zero added/removed lines) still reports at least one
      // path once git apply --numstat succeeds at all — a totally empty
      // diff instead fails to parse and is caught above, in
      // getAuthoritativeChangedPaths. Kept as a defensive fail-closed
      // check rather than assumed away.
      throw new PublishRejection(
        "the implement run produced no changes (empty patch)",
      );
    }

    const forbidden = findForbiddenPatchPaths(changedPaths);
    if (forbidden.length > 0) {
      throw new PublishRejection(
        `patch touches pipeline-protected path(s), refusing to apply it: ` +
          forbidden.join(", "),
      );
    }

    // Complementary check: --numstat only reports rename DESTINATIONS, so
    // a rename OUT of a protected path (e.g. moving
    // .github/workflows/ci.yml elsewhere) wouldn't show up in
    // changedPaths above. --summary's text does include both sides.
    const summaryText = getPatchSummaryText(patchPath);
    const summaryMentions = findProtectedPathMentionsInSummaryText(summaryText);
    if (summaryMentions.length > 0) {
      throw new PublishRejection(
        `patch summary mentions pipeline-protected path(s), refusing to ` +
          `apply it: ${summaryMentions.join(", ")}`,
      );
    }

    const issue = await githubRequest<GitHubIssue>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}`,
    );

    // Idempotency keys off the issue number (stable), never a freshly
    // re-derived title slug — see findPrForIssueNumber's docstring.
    const existingPr = await findExistingPrForIssue(
      token,
      owner,
      repo,
      issueNumber,
    );
    branchName = existingPr
      ? existingPr.headRef
      : deriveBranchName(issueNumber, issue.title);

    applyPatchAndPush(branchName, patchPath, issueNumber, issue.title);
    branchPushed = true;

    if (existingPr) {
      console.log(
        `PR #${existingPr.number} already exists for issue #${issueNumber} ` +
          `(branch ${branchName}); refreshed, not opening a duplicate.`,
      );
      return;
    }

    const created = await githubRequest<GitHubPullRequestApi>(
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
    const detail = err instanceof Error ? err.message : String(err);
    const reasons =
      err instanceof PublishRejection ? [detail] : [`unexpected error: ${detail}`];

    if (branchPushed && branchName) {
      // FIX 5: the branch write DID succeed — say so accurately, rather
      // than the generic "no branch was created" message, which would be
      // false here and could leave an orphaned branch undiscovered.
      // Deliberately not auto-deleted: it's evidence for whatever failed
      // after the push, and a human can still open a PR from it by hand.
      reasons.unshift(
        `the branch \`${branchName}\` WAS pushed successfully, but ` +
          `publishing the PR failed after that — this needs manual ` +
          `follow-up (open a PR from that branch by hand, or inspect/` +
          `delete it)`,
      );
    }

    await postFailureComment(
      token,
      owner,
      repo,
      issueNumber,
      reasons,
      runUrl,
      branchPushed,
    );
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
