/**
 * CLI entrypoint for the privileged `apply` job in
 * `.github/workflows/triage-issues.yml`.
 *
 * This is the ONLY piece of the triage pipeline that holds a writable
 * GitHub token, and it never executes anything the agent produced — it
 * reads a JSON artifact written by the read-only `triage` job, validates it
 * with {@link validateTriageVerdict} (schema.mts), and if (and only if)
 * that passes, re-checks the target and makes deterministic GitHub REST API
 * calls to replace this execution's exact hold comment, replace the issue's
 * label set, and verify the result. All agent-controlled text reaches GitHub
 * only as a JSON request body over `fetch` — never through a shell command —
 * so there is no shell-interpolation injection surface.
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
 * - `FACTORY_APP_TOKEN`: optional issues-only App token. When present, it is
 *   used only for a successful-path `ready-to-spec` label write and its
 *   verification read. Comment writes and fallback writes always use
 *   `GH_TOKEN`.
 * - `GITHUB_REPOSITORY` — `owner/repo` (set automatically by Actions).
 * - `TRUSTED_ISSUE_NUMBER` — the canonical workflow target, never from the
 *   verdict artifact.
 * - `TRUSTED_TRIAGE_COMMENT_ID` — the exact bot-owned comment seed created
 *   or updated with this execution's hold.
 * - `TRIAGE_JOB_RESULT` — `needs.triage.result` from the workflow. A verdict
 *   artifact is only ever trusted when this is exactly `"success"` — the
 *   `triage` step uploads its artifact with `if: always()` (so a failed run
 *   still leaves something to diagnose), which means a schema-valid verdict
 *   can exist on disk even though the job that wrote it did NOT succeed
 *   (timeout, internal error, a forbidden-tool attempt). Schema validity
 *   alone is not sufficient grounds to apply a verdict; job success is a
 *   second, independent gate checked BEFORE the artifact is even read.
 * - `TRIAGE_EXECUTION` — trusted `<run_id>.<run_attempt>` identity. Seed
 *   installed `hold:<TRIAGE_EXECUTION>` before the agent started; an
 *   apply-only retry may find the same final generation.
 * - `TRIAGE_MODE` - trusted workflow-event mode. Unknown or absent values
 *   fail closed to `pre-filter`.
 * - `APPROVED_REVISION` - optional lowercase SHA-256 of the REST issue body
 *   reviewed by the owner. A malformed value or body mismatch fails closed.
 * - `VERDICT_PATH` — path to the downloaded artifact file (may not exist).
 */

import { readFile, stat } from "node:fs/promises";
import {
  enforceDiffVerifiableAc,
  type DiffVerifiableAcResult,
} from "./diff-verifiable-ac.mts";
import { githubRequest, requireEnv } from "./github-api.mts";
import {
  canonicalIssueRevision,
  isApprovedRevision,
} from "./approve-revision.mts";
import {
  MAX_PAYLOAD_BYTES,
  validateTriageVerdict,
  type TriageVerdictValidationResult,
} from "./triage-verdict-schema.mts";
import {
  clampTriageReadiness,
  validateTriageMode,
} from "./triage-mode.mts";
import {
  buildFallbackCommentBody,
  buildTriageHoldGeneration,
  buildVerdictCommentBody,
  computeNewLabelSet,
  extractTriageGeneration,
  selectLabelWriteToken,
  TRIAGE_COMMENT_AUTHOR_LOGIN,
  TRIAGE_COMMENT_MARKER,
} from "./apply-triage-verdict-logic.mts";

interface GitHubIssueLabel {
  readonly name: string;
}

interface GitHubIssue {
  readonly state: string;
  readonly title: string;
  readonly body: string | null;
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

async function requireRetryableTriageGeneration(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  commentId: number,
  expectedHold: string,
  expectedFinal: string,
): Promise<void> {
  const comment = await githubRequest<GitHubComment>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/comments/${commentId}`,
  );
  const isOwned =
    comment.id === commentId &&
    comment.user?.type === "Bot" &&
    comment.user.login === TRIAGE_COMMENT_AUTHOR_LOGIN &&
    (comment.body === TRIAGE_COMMENT_MARKER ||
      comment.body.endsWith(`\n${TRIAGE_COMMENT_MARKER}`));
  const currentGeneration = isOwned
    ? extractTriageGeneration(comment.body)
    : "none";
  if (
    !isOwned ||
    (currentGeneration !== expectedHold && currentGeneration !== expectedFinal)
  ) {
    throw new Error(
      `target #${issueNumber} triage generation is not ${expectedHold} or ` +
        `${expectedFinal}; found ${currentGeneration}; ` +
        `refusing stale triage writes`,
    );
  }
}

async function updateComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  await githubRequest(
    token,
    "PATCH",
    `/repos/${owner}/${repo}/issues/comments/${commentId}`,
    { body },
  );
}

async function verifyLabelSet(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  expectedLabels: readonly string[],
): Promise<void> {
  const labels = await githubRequest<GitHubIssueLabel[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels?per_page=100`,
  );
  const actual = Array.from(new Set(labels.map((label) => label.name))).sort();
  const expected = Array.from(new Set(expectedLabels)).sort();
  if (
    actual.length !== expected.length ||
    actual.some((label, index) => label !== expected[index])
  ) {
    throw new Error(
      `target #${issueNumber} readiness verification failed: expected ` +
        `[${expected.join(", ")}], got [${actual.join(", ")}]`,
    );
  }
}

/**
 * Applies a validated verdict: replaces this execution's hold comment, THEN
 * swaps the readiness label — comment first, label flip last, deliberately.
 * The label is the write that can make the issue look buildable (F1-S3 trusts
 * `ready-to-implement`); the comment is purely informational. Posting the
 * comment first means a comment failure leaves the label exactly as it was
 * (fail closed — no readiness change without an explanation already in
 * place), while a label-write failure after a successful comment at least
 * leaves the explanation behind for a human to act on. The prerequisite
 * publisher fence makes every generation non-publishable in this slice.
 *
 * Deliberately never calls the issue-close API, for any readiness value
 * including `wontfix` — see {@link buildVerdictCommentBody}'s docstring for
 * why.
 */
async function applyValidVerdict(
  ghToken: string,
  appToken: string,
  owner: string,
  repo: string,
  result: Extract<TriageVerdictValidationResult, { ok: true }>,
  diffVerifiableAc: DiffVerifiableAcResult,
  commentId: number,
  generation: string,
  approvedRevision: string,
): Promise<void> {
  const { verdict } = result;

  // Durable full-evidence to the 90-day run log BEFORE the first network write.
  // The posted comment bounds and defangs `verdict.reasoning`/questions (#158
  // slice 3), and the PATCH can fail — so the complete, untruncated verdict
  // content is logged here first, where the bounded comment's disclosure
  // pointer ("full detail in the run log") resolves. Ordering below (comment
  // first, label flip last) is unchanged and deliberate.
  console.log(
    JSON.stringify({
      issue_number: verdict.issue_number,
      readiness: verdict.readiness,
      effective_readiness: diffVerifiableAc.effectiveReadiness,
      diff_verifiable_ac_pattern_id: diffVerifiableAc.patternId,
      reasoning: verdict.reasoning,
      missing_info_questions: verdict.missing_info_questions,
    }),
  );

  await updateComment(
    ghToken,
    owner,
    repo,
    commentId,
    buildVerdictCommentBody(
      verdict,
      generation,
      diffVerifiableAc.effectiveReadiness,
      diffVerifiableAc.downgradeNotice,
      approvedRevision,
    ),
  );

  const currentLabels = await githubRequest<GitHubIssueLabel[]>(
    ghToken,
    "GET",
    `/repos/${owner}/${repo}/issues/${verdict.issue_number}/labels?per_page=100`,
  );
  const newLabelSet = computeNewLabelSet(
    currentLabels.map((l) => l.name),
    diffVerifiableAc.effectiveReadiness,
  );
  const labelWriteToken = selectLabelWriteToken(
    diffVerifiableAc.effectiveReadiness,
    ghToken,
    appToken,
  );
  try {
    await githubRequest(
      labelWriteToken,
      "PUT",
      `/repos/${owner}/${repo}/issues/${verdict.issue_number}/labels`,
      { labels: newLabelSet },
    );
    await verifyLabelSet(
      labelWriteToken,
      owner,
      repo,
      verdict.issue_number,
      newLabelSet,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await applyFallback(
      ghToken,
      owner,
      repo,
      verdict.issue_number,
      [`validated verdict readiness apply failed: ${message}`],
      commentId,
      buildTriageHoldGeneration(generation),
    );
    throw err;
  }

  console.log(
    `Applied verdict for #${verdict.issue_number}: readiness=${diffVerifiableAc.effectiveReadiness}, ` +
      `labels=[${newLabelSet.join(", ")}]`,
  );
}

async function applyFallback(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  errors: readonly string[],
  commentId: number,
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
  // incorrectly claims it's safe. The fallback comment keeps this execution's
  // non-authorizing hold generation.
  //
  // Durable full-evidence to the 90-day run log BEFORE the first network write
  // of this path. The posted fallback comment bounds and two-tier caps its
  // error list (#158 slice 3), and every write below can fail (the label PUT,
  // its verification, or the comment PATCH) — so the complete error list is
  // logged here first, where the bounded comment's disclosure pointer resolves.
  // This precedes the label GET and does NOT reorder the labels-first writes.
  console.error(JSON.stringify(errors));
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
  await verifyLabelSet(token, owner, repo, issueNumber, resetLabelSet);

  await updateComment(
    token,
    owner,
    repo,
    commentId,
    buildFallbackCommentBody(errors, generation),
  );
  console.error(
    `Triage verdict for #${issueNumber} was invalid; readiness reset to ` +
      `needs-triage. Errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
}

export async function main(): Promise<void> {
  const ghToken = requireEnv("GH_TOKEN");
  const appToken = process.env.FACTORY_APP_TOKEN ?? "";
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY must be "owner/repo", got ${process.env.GITHUB_REPOSITORY}`,
    );
  }
  const trustedIssueNumberRaw = requireEnv("TRUSTED_ISSUE_NUMBER");
  if (!/^[1-9][0-9]*$/.test(trustedIssueNumberRaw)) {
    throw new Error(
      `TRUSTED_ISSUE_NUMBER must be a canonical positive decimal integer`,
    );
  }
  const trustedIssueNumber = Number(trustedIssueNumberRaw);
  if (!Number.isSafeInteger(trustedIssueNumber)) {
    throw new Error(
      `TRUSTED_ISSUE_NUMBER exceeds JavaScript's safe integer range`,
    );
  }
  const trustedCommentId = Number(requireEnv("TRUSTED_TRIAGE_COMMENT_ID"));
  if (!Number.isSafeInteger(trustedCommentId) || trustedCommentId < 1) {
    throw new Error(`TRUSTED_TRIAGE_COMMENT_ID must be a positive integer`);
  }
  const verdictPath = process.env.VERDICT_PATH ?? "triage-output/verdict.json";
  const triageJobResult = requireEnv("TRIAGE_JOB_RESULT");
  const generation = requireEnv("TRIAGE_EXECUTION");
  const holdGeneration = buildTriageHoldGeneration(generation);
  const triageMode = validateTriageMode(process.env.TRIAGE_MODE);
  const approvedRevision = process.env.APPROVED_REVISION ?? "";

  // Re-check immediately at the privileged boundary. The issue can close
  // after seed validates it, and neither a verdict nor the fail-closed
  // fallback may relabel or comment on closed work.
  const issue = await githubRequest<GitHubIssue>(
    ghToken,
    "GET",
    `/repos/${owner}/${repo}/issues/${trustedIssueNumber}`,
  );
  if (issue.state !== "open") {
    throw new Error(
      `target #${trustedIssueNumber} is not open (state=${issue.state}); ` +
        `refusing all triage writes`,
    );
  }
  await requireRetryableTriageGeneration(
    ghToken,
    owner,
    repo,
    trustedIssueNumber,
    trustedCommentId,
    holdGeneration,
    generation,
  );
  const fallback = (errors: readonly string[]): Promise<void> =>
    applyFallback(
      ghToken,
      owner,
      repo,
      trustedIssueNumber,
      errors,
      trustedCommentId,
      holdGeneration,
    );

  if (approvedRevision !== "" && !isApprovedRevision(approvedRevision)) {
    await fallback(["APPROVED_REVISION must be empty or canonical lowercase SHA-256"]);
    process.exitCode = 1;
    return;
  }
  if (
    approvedRevision !== "" &&
    (typeof issue.title !== "string" ||
      typeof issue.body !== "string" ||
      canonicalIssueRevision(issue.title, issue.body) !== approvedRevision)
  ) {
    await fallback([
      "approved issue revision no longer matches the current REST issue body",
    ]);
    process.exitCode = 1;
    return;
  }

  // Gate on triage job success BEFORE ever reading the artifact. A verdict
  // is applied only when (triage succeeded AND the artifact is valid) —
  // schema validity alone is not enough, since `if: always()` means the
  // artifact can exist and be well-formed even from a run that failed
  // partway through after writing it.
  if (triageJobResult !== "success") {
    await fallback([
      `triage job result was "${triageJobResult}", not "success" — the ` +
        `verdict artifact (even if present and schema-valid) is not ` +
        `trusted; only a successful triage run's verdict is ever applied`,
    ]);
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
    await fallback([readError]);
    process.exitCode = 1;
    return;
  }

  const result = validateTriageVerdict(raw, trustedIssueNumber);
  if (!result.ok) {
    await fallback(result.errors);
    process.exitCode = 1;
    return;
  }

  // Evaluate both monotone guards against the original validated readiness,
  // then join their results at ready-to-spec. Each guard only passes through
  // or downgrades to ready-to-spec, so the join is idempotent and independent
  // of evaluation order. Independent evaluation also retains both trusted
  // notices when both downgrade reasons apply.
  const modeClamp = clampTriageReadiness(
    triageMode,
    result.verdict.readiness,
  );
  const diffVerifiableAc = enforceDiffVerifiableAc(
    result.verdict.readiness,
    issue.body ?? "",
  );
  const downgradeNotices = [
    modeClamp.clampNotice,
    diffVerifiableAc.downgradeNotice,
  ].filter((notice): notice is string => notice !== null);
  const deterministicReadiness: DiffVerifiableAcResult = {
    effectiveReadiness:
      modeClamp.effectiveReadiness === "ready-to-spec" ||
      diffVerifiableAc.effectiveReadiness === "ready-to-spec"
        ? "ready-to-spec"
        : result.verdict.readiness,
    downgraded: modeClamp.clamped || diffVerifiableAc.downgraded,
    patternId: diffVerifiableAc.patternId,
    downgradeNotice:
      downgradeNotices.length > 0 ? downgradeNotices.join("\n\n") : null,
  };

  await applyValidVerdict(
    ghToken,
    appToken,
    owner,
    repo,
    result,
    deterministicReadiness,
    trustedCommentId,
    generation,
    approvedRevision,
  );
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
