/**
 * CLI entrypoint for the privileged `apply` job in
 * `.github/workflows/triage-issues.yml`.
 *
 * This is the ONLY piece of the triage pipeline that holds a writable
 * GitHub token, and it never executes anything the agent produced — it
 * reads a JSON artifact written by the read-only `triage` job, validates it
 * with {@link validateTriageVerdict} (schema.mts), and if (and only if)
 * that passes, re-checks the trusted target is still open, then makes
 * deterministic GitHub REST API calls to replace the issue's label set and
 * upsert a tracking comment. All agent-controlled text (the verdict's
 * `reasoning` / `missing_info_questions`) reaches GitHub only as a JSON
 * request body over `fetch` — never through a shell command — so there is
 * no shell-interpolation injection surface.
 *
 * On a missing or invalid verdict, readiness is explicitly RESET to
 * `needs-triage` (not just left as whatever it already was — a rerun could
 * find a stale `ready-to-implement` from an earlier valid verdict or manual
 * pre-labelling, and leaving that in place while triage has just failed
 * would let a later implement stage build it despite no successful triage
 * having run) — the fail-safe resting state — and this script exits
 * non-zero purely for workflow-run visibility (so a broken triage run shows
 * red in Actions, not just a silent no-op).
 *
 * Required environment variables:
 * - `GH_TOKEN` — the job's `permissions: issues: write` token.
 * - `GITHUB_REPOSITORY` — `owner/repo` (set automatically by Actions).
 * - `TRUSTED_ISSUE_NUMBER` — normalized from the workflow's issue event or
 *   required dispatch input, never from the verdict artifact.
 * - `TRIAGE_JOB_RESULT` — `needs.triage.result` from the workflow. A verdict
 *   artifact is only ever trusted when this is exactly `"success"` — the
 *   `triage` step uploads its artifact with `if: always()` (so a failed run
 *   still leaves something to diagnose), which means a schema-valid verdict
 *   can exist on disk even though the job that wrote it did NOT succeed
 *   (timeout, internal error, a forbidden-tool attempt). Schema validity
 *   alone is not sufficient grounds to apply a verdict; job success is a
 *   second, independent gate checked BEFORE the artifact is even read.
 * - `GITHUB_RUN_ID` — the trusted Actions run generation embedded in the
 *   factory comment before readiness is restored.
 * - `VERDICT_PATH` — path to the downloaded artifact file (may not exist).
 */

import { readFile, stat } from "node:fs/promises";
import { githubRequest, requireEnv } from "./github-api.mts";
import {
  MAX_PAYLOAD_BYTES,
  validateTriageVerdict,
  type TriageVerdictValidationResult,
} from "./triage-verdict-schema.mts";
import {
  buildFallbackCommentBody,
  buildVerdictCommentBody,
  computeNewLabelSet,
  findExistingTriageCommentId,
  type ExistingComment,
} from "./apply-triage-verdict-logic.mts";

interface GitHubIssueLabel {
  readonly name: string;
}

interface GitHubIssue {
  readonly state: string;
}

interface GitHubComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}

/**
 * Reads and JSON-parses the verdict artifact, tolerating a missing file.
 *
 * Checks the file's size via `stat` BEFORE reading its contents into
 * memory or handing them to `JSON.parse` — a runaway or adversarial
 * multi-GB artifact must be rejected without ever being fully read, or it
 * could OOM/stall this privileged job before the fail-closed path even
 * runs. The same {@link MAX_PAYLOAD_BYTES} bound the schema validator uses
 * for the in-memory verdict applies here to the on-disk file.
 */
async function readVerdictArtifact(path: string): Promise<unknown> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(path);
  } catch (err) {
    throw new Error(
      `triage artifact not found at ${path} (triage job likely failed or ` +
        `produced no output): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (fileStat.size > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `triage artifact at ${path} is ${fileStat.size} bytes, exceeds the ` +
        `${MAX_PAYLOAD_BYTES}-byte limit — rejected before being read into ` +
        `memory`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    // Narrow TOCTOU race (stat succeeds, the file vanishes/becomes
    // unreadable before readFile runs) — not meaningfully triggerable in
    // this single-shot CI job, so not exercised by a unit test; kept as a
    // defensive branch so a real occurrence still fails closed with a
    // clear error instead of an unhandled rejection.
    throw new Error(
      `triage artifact at ${path} could not be read after a successful ` +
        `stat (possible race with another process): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `triage artifact at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const COMMENT_PAGE_SIZE = 100;
/**
 * Upper bound on how many comment pages to scan looking for a prior
 * triage comment (~5,000 comments) — pathologically high for a factory
 * issue, but a sane cap against an unbounded loop rather than trusting the
 * API to always terminate cleanly.
 */
const MAX_COMMENT_PAGES = 50;

/**
 * Finds this job's own prior triage comment, if any, paginating through
 * every page of comments rather than only the first. An issue with more
 * than one page of comments (>100) could otherwise have its marker
 * comment missed, causing a duplicate post on a rerun instead of an edit.
 */
async function findExistingTriageComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<number | null> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await githubRequest<GitHubComment[]>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
    );
    const existing: ExistingComment[] = comments.map((c) => ({
      id: c.id,
      body: c.body,
      authorType: c.user?.type ?? null,
      authorLogin: c.user?.login ?? null,
    }));
    const found = findExistingTriageCommentId(existing);
    if (found !== null) {
      return found;
    }
    if (comments.length < COMMENT_PAGE_SIZE) {
      return null; // Last page: no more comments to check.
    }
  }
  console.warn(
    `Scanned ${MAX_COMMENT_PAGES} pages of comments on #${issueNumber} ` +
      `without finding a prior triage comment; posting a new one rather ` +
      `than risking missing a marker beyond this page limit.`,
  );
  return null;
}

async function upsertComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const existingId = await findExistingTriageComment(
    token,
    owner,
    repo,
    issueNumber,
  );

  if (existingId !== null) {
    await githubRequest(
      token,
      "PATCH",
      `/repos/${owner}/${repo}/issues/comments/${existingId}`,
      { body },
    );
  } else {
    await githubRequest(
      token,
      "POST",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
    );
  }
}

/**
 * Applies a validated verdict: upserts the tracking comment, THEN swaps the
 * readiness label — comment first, label flip last, deliberately. The
 * label is the write that can make the issue look buildable (F1-S3 trusts
 * `ready-to-implement`); the comment is purely informational. Posting the
 * comment first means a comment failure leaves the label exactly as it
 * was (fail closed — no readiness change without an explanation already
 * in place), while a label-write failure after a successful comment at
 * least leaves the explanation behind for a human to act on.
 *
 * Deliberately never calls the issue-close API, for any readiness value
 * including `wontfix` — see {@link buildVerdictCommentBody}'s docstring for
 * why.
 */
async function applyValidVerdict(
  token: string,
  owner: string,
  repo: string,
  result: Extract<TriageVerdictValidationResult, { ok: true }>,
  generation: string,
): Promise<void> {
  const { verdict } = result;

  await upsertComment(
    token,
    owner,
    repo,
    verdict.issue_number,
    buildVerdictCommentBody(verdict, generation),
  );

  const currentLabels = await githubRequest<GitHubIssueLabel[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${verdict.issue_number}/labels?per_page=100`,
  );
  const newLabelSet = computeNewLabelSet(
    currentLabels.map((l) => l.name),
    verdict.readiness,
  );
  await githubRequest(
    token,
    "PUT",
    `/repos/${owner}/${repo}/issues/${verdict.issue_number}/labels`,
    { labels: newLabelSet },
  );

  console.log(
    `Applied verdict for #${verdict.issue_number}: readiness=${verdict.readiness}, ` +
      `labels=[${newLabelSet.join(", ")}]`,
  );
}

async function applyFallback(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  errors: readonly string[],
  generation: string,
): Promise<void> {
  // Fail closed on readiness, not just on comment content: a rerun could
  // find the issue already carrying a stale ready-to-implement (from an
  // earlier, since-superseded valid verdict, or manual pre-labelling) —
  // leaving that in place while triage has just failed would let F1-S3
  // pick it up as buildable despite no successful triage having run. Reset
  // to needs-triage explicitly, the same way `seed` would have, every time.
  //
  // Deliberately labels-first here — the MIRROR IMAGE of
  // applyValidVerdict's comment-first ordering, not an inconsistency. The
  // dangerous write on THIS path is a stale ready-to-implement surviving a
  // failed reset; the comment is secondary. Resetting the label first
  // means a comment failure afterward leaves the safe needs-triage state
  // already in place. Reordering to comment-first would risk the opposite
  // of applyValidVerdict's fix: a comment claiming "reset to needs-triage"
  // could post successfully and THEN the actual reset PUT could fail,
  // leaving a stale ready-to-implement label alongside a comment that
  // incorrectly claims it's safe — worse than either order failing
  // silently, since it actively misleads a reader who trusts the comment
  // over the label.
  const currentLabels = await githubRequest<GitHubIssueLabel[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels?per_page=100`,
  );
  const resetLabelSet = computeNewLabelSet(
    currentLabels.map((l) => l.name),
    "needs-triage",
  );
  await githubRequest(
    token,
    "PUT",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    { labels: resetLabelSet },
  );

  await upsertComment(
    token,
    owner,
    repo,
    issueNumber,
    buildFallbackCommentBody(errors, generation),
  );
  console.error(
    `Triage verdict for #${issueNumber} was invalid; readiness reset to ` +
      `needs-triage. Errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
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
  const trustedIssueNumber = Number(requireEnv("TRUSTED_ISSUE_NUMBER"));
  const verdictPath = process.env.VERDICT_PATH ?? "triage-output/verdict.json";
  const triageJobResult = requireEnv("TRIAGE_JOB_RESULT");
  const generation = requireEnv("GITHUB_RUN_ID");

  // Re-check immediately at the privileged boundary. The issue can close
  // after seed validates it, and neither a verdict nor the fail-closed
  // fallback may relabel or comment on closed work.
  const issue = await githubRequest<GitHubIssue>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${trustedIssueNumber}`,
  );
  if (issue.state !== "open") {
    throw new Error(
      `target #${trustedIssueNumber} is not open (state=${issue.state}); ` +
        `refusing all triage writes`,
    );
  }

  // Gate on triage job success BEFORE ever reading the artifact. A verdict
  // is applied only when (triage succeeded AND the artifact is valid) —
  // schema validity alone is not enough, since `if: always()` means the
  // artifact can exist and be well-formed even from a run that failed
  // partway through after writing it.
  if (triageJobResult !== "success") {
    await applyFallback(
      token,
      owner,
      repo,
      trustedIssueNumber,
      [
        `triage job result was "${triageJobResult}", not "success" — the ` +
          `verdict artifact (even if present and schema-valid) is not ` +
          `trusted; only a successful triage run's verdict is ever applied`,
      ],
      generation,
    );
    process.exitCode = 1;
    return;
  }

  let raw: unknown;
  let readError: string | null = null;
  try {
    raw = await readVerdictArtifact(verdictPath);
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  }

  if (readError !== null) {
    await applyFallback(
      token,
      owner,
      repo,
      trustedIssueNumber,
      [readError],
      generation,
    );
    process.exitCode = 1;
    return;
  }

  const result = validateTriageVerdict(raw, trustedIssueNumber);
  if (!result.ok) {
    await applyFallback(
      token,
      owner,
      repo,
      trustedIssueNumber,
      result.errors,
      generation,
    );
    process.exitCode = 1;
    return;
  }

  await applyValidVerdict(token, owner, repo, result, generation);
}

// Only self-invoke when run directly (`node apply-triage-verdict.mts`), not
// when imported by a test. Genuinely uncovered by unit tests (they import
// `main` directly rather than exec'ing the file) — exercised instead by
// running the script directly, as documented in the PR description.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("apply-triage-verdict failed:", err);
    process.exitCode = 1;
  });
}
