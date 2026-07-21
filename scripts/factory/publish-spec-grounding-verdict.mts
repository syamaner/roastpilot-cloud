/**
 * CLI entrypoint for the privileged `publish` job in
 * `.github/workflows/claude-code-review.yml` (F1-S9 slice 3b-iii-d,
 * issue #12) — the ONLY piece of the spec-grounded review pipeline that
 * holds a writable GitHub token. Mirrors `apply-triage-verdict.mts`'s own
 * structure exactly: reads JSON artifacts a read-only agent job wrote,
 * validates them, and if (and only if) validation passes, makes
 * deterministic GitHub REST API calls built by already-reviewed pure
 * logic (`publish-spec-grounding-verdict-logic.mts`,
 * `spec-grounding-runner-logic.mts`) — this file itself contains no
 * review judgment, only artifact-reading orchestration and the tri-state
 * gate. The actual comment find/upsert plumbing lives in its own file,
 * `publish-spec-grounding-comment-io.mts` (split out to keep this file
 * under AGENTS.md's 400-logic-line PR-hygiene cap) — this file imports
 * and calls it, never duplicates it.
 *
 * SLICE d4 (this file's current state — split per team-lead's "keep d
 * and e separate PRs, split d if it measures over 400 [logic lines]"
 * direction: d1 = pure-logic artifact parsing, d2 = summary-comment I/O,
 * d3 = this entrypoint's own gate cascade, d4 = the inline-posting
 * wiring below): fetches this run's OWN trusted copy of the raw diff
 * (`spec-grounding-runner.mts`'s own SHA-pinned `fetchPrDiff`, reused —
 * never the read-only job's already-neutralized `pr-diff-block.txt`),
 * selects a deterministic anchor, and attempts to post every blocker as
 * a real, resolvable inline review comment
 * (`publish-spec-grounding-inline-comment-io.mts`'s own `postInlineCommentPlan`,
 * with its own 422 probe-then-degrade). `blockersPostedInline` is
 * `true` only when inline posting genuinely succeeded; it is `false`
 * for BOTH degrade cases — no addable anchor at all
 * (`anchorFallbackNeeded`), or the first inline POST rejected with a
 * 422 — and the full blocker detail is appended to the summary instead
 * either way. This entrypoint exits nonzero ONLY in that `false` case:
 * a blocker posted as a real inline thread is already gated by
 * `required_conversation_resolution` on the thread itself, so a healthy
 * run does not also need this job to fail red. Not yet wired into any
 * workflow (that is slice e, still separate), so none of this has a
 * live, observable effect yet.
 *
 * THE TRI-STATE OUTCOME GATE (team-lead's design, #12 3b-iii-d+e PR-plan
 * sign-off): before this job does anything, it checks TWO independent
 * signals, in order —
 *
 * 1. `SPEC_GROUNDED_REVIEW_JOB_RESULT` (`needs.spec-grounded-review
 *    .result` from the calling workflow) — a THREE-way gate, not the
 *    two-way "success or failure" `apply-triage-verdict.mts`'s own
 *    `TRIAGE_JOB_RESULT` gate uses, because `spec-grounded-review` (unlike
 *    `triage`) has legitimate SKIP states: a draft PR, a Dependabot/fork
 *    PR, or a title-only `edited` event never runs that job at all.
 *      - `"skipped"` → silent no-op (nothing to publish; this was never a
 *        reviewable run in the first place).
 *      - `"cancelled"` → ALSO silent no-op (team-lead's explicit
 *        amendment to the original two-way design): the common cause is a
 *        concurrency supersede (a newer push cancelled this run) — a
 *        NEWER run with the real result is already on its way, so a
 *        "review failed" fallback comment here would be a transient false
 *        alarm the next run immediately overwrites anyway.
 *      - `"success"` → proceed to the outcome tri-state below.
 *      - anything else (`"failure"`, or a value outside GitHub's own
 *        documented set — defensively treated the same way) → visible
 *        fallback: the review pipeline itself broke, and that must be
 *        visible to a human, not silently absent.
 * 2. Once the job result is `"success"`, `review-output/outcome.json`
 *    (`spec-grounding-runner.mts`'s own self-describing marker, ALWAYS
 *    written when the runner step itself succeeds, uploaded `if:
 *    always()`) resolves the remaining tri-state:
 *      - Artifact ABSENT or unreadable/malformed → visible fallback
 *        (a genuine runner crash between a successful job result and a
 *        written marker should not happen, but a corrupted/missing
 *        download must still fail closed, never be silently treated as
 *        "nothing to review").
 *      - Present, `hasCriteria: false` → the runner found no linked issue,
 *        or no unmet criteria — genuinely nothing to spec-ground, not a
 *        failure — but NOT necessarily a silent no-op: {@link
 *        clearStaleSpecGroundingStateOnDisappearedCriteria} clears any
 *        PRIOR summary/fallback comment and inline blocker threads this
 *        workflow posted on an earlier run, so criteria disappearing
 *        (e.g. a body edit removing the last closing-keyword reference)
 *        does not leave stale, no-longer-applicable state visible and
 *        gating forever (PR #86 review, Codex, P2).
 *      - Present, `hasCriteria: true` → the verdict and criteria-spine
 *        artifacts MUST both be present and valid; either being
 *        absent/malformed is ALSO a visible fallback (the review agent
 *        step failed, timed out, or produced garbage) — never acted on.
 *
 * Required environment variables:
 * - `GH_TOKEN` — the job's `permissions: pull-requests: write` token
 *   (proven sufficient for both endpoints this file calls — no
 *   `issues: write` needed; see the #12 3b-iii-d+e PR-plan sign-off).
 * - `GITHUB_REPOSITORY` — `owner/repo` (set automatically by Actions).
 * - `TRUSTED_PR_NUMBER` — from `github.event.pull_request.number`, never
 *   from an artifact.
 * - `TRUSTED_HEAD_SHA` — from `github.event.pull_request.head.sha`; this
 *   run's own anchor-selecting diff fetch is verified against it before
 *   ever being used, the same discipline `spec-grounding-runner.mts`'s
 *   own identical check applies to its own diff fetch.
 * - `SPEC_GROUNDED_REVIEW_JOB_RESULT` — `needs.spec-grounded-review.result`.
 *
 * Optional environment variables (artifact paths, overridable for tests /
 * local runs; default to exactly where `actions/download-artifact`
 * restores the `spec-grounding-review-artifacts` bundle, matching the
 * paths `spec-grounding-runner.mts`/the workflow's own upload step use):
 * - `OUTCOME_PATH` (default `review-output/outcome.json`)
 * - `CRITERIA_SPINE_PATH` (default `review-context/criteria-spine.json`)
 * - `VERDICT_PATH` (default `review-output/spec-grounding-verdict.json`)
 */

import { open } from "node:fs/promises";
import { githubRequest, requireEnv } from "./github-api.mts";
import {
  MAX_PAYLOAD_BYTES as MAX_VERDICT_PAYLOAD_BYTES,
  parseAndValidateVerdict,
  type SpecGroundingVerdict,
} from "./spec-grounding-verdict-schema.mts";
import { fetchPrDiff } from "./spec-grounding-runner.mts";
import {
  MAX_CRITERIA_SPINE_ARTIFACT_BYTES,
  parseCriteriaSpineArtifact,
  type ParsedCriteriaSpine,
} from "./spec-grounding-runner-logic.mts";
import {
  buildSpecGroundingSummaryCommentBody,
  deriveSeverity,
  isDiffTruncationUnverifiableForClosing,
  joinFindingsToSpine,
  type JoinedCriterionResult,
} from "./publish-spec-grounding-verdict-logic.mts";
import {
  buildAnchorFallbackSummarySupplement,
  planBlockerInlineComments,
} from "./publish-spec-grounding-blocker-logic.mts";
import {
  clearStaleSpecGroundingSummary,
  neutralizeReasonForLog,
  publishFallback,
  upsertSummaryComment,
} from "./publish-spec-grounding-comment-io.mts";
import {
  clearStaleInlineBlockerComments,
  postInlineCommentPlan,
} from "./publish-spec-grounding-inline-comment-io.mts";

interface GitHubPullRequestShas {
  readonly head: { readonly sha: string };
  readonly base: { readonly sha: string };
}

/**
 * Fetches the PR's own current head/base SHAs and verifies the head
 * matches the TRUSTED value from the workflow's own event context —
 * mirrors `spec-grounding-runner.mts`'s own identical verification
 * exactly (never re-derived independently, F1-S9 slice 3b-iii-d4): the
 * mutable `/pulls/{n}` resource always reflects whatever the branch
 * currently points to, so without this check, a push landing between
 * this run's trigger and this fetch could pair a trusted verdict
 * (reviewed against an EARLIER head) with a LATER, unreviewed diff for
 * this run's own anchor selection.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param trustedHeadSha - `TRUSTED_HEAD_SHA`, from the workflow's own
 *   event context, never re-derived from this PR's own mutable state.
 * @returns The PR's own head/base SHAs.
 * @throws If the PR's current head SHA does not match `trustedHeadSha`.
 */
async function fetchAndVerifyPrShas(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  trustedHeadSha: string,
): Promise<GitHubPullRequestShas> {
  const pr = await githubRequest<GitHubPullRequestShas>(token, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (pr.head.sha !== trustedHeadSha) {
    throw new Error(
      `PR #${prNumber}'s current head SHA (${pr.head.sha}) does not match the trusted event head SHA ` +
        `(${trustedHeadSha}) — the PR moved between the review trigger and this fetch; failing closed ` +
        `rather than selecting an anchor against a possibly-stale or possibly-newer diff.`,
    );
  }
  return pr;
}

interface RunPaths {
  readonly outcomePath: string;
  readonly criteriaSpinePath: string;
  readonly verdictPath: string;
}

function resolvePaths(): RunPaths {
  return {
    outcomePath: process.env.OUTCOME_PATH ?? "review-output/outcome.json",
    criteriaSpinePath: process.env.CRITERIA_SPINE_PATH ?? "review-context/criteria-spine.json",
    verdictPath: process.env.VERDICT_PATH ?? "review-output/spec-grounding-verdict.json",
  };
}

/**
 * Narrows an unknown catch value to Node's own `ErrnoException` shape,
 * just enough to read its `code` field safely.
 *
 * @param err - The caught value.
 * @returns Whether `err` carries a `code` field the way Node's own
 *   filesystem errors do.
 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * Reads a file's raw bytes AS A BUFFER (never decoded to a string here),
 * tolerating a missing file by returning `null` — the shared shape every
 * artifact read in this entrypoint needs (a missing file is not itself a
 * crash; the CALLER decides what a missing artifact means for its own
 * tri-state gate).
 *
 * Returning a `Buffer` rather than a decoded string is itself a fold (PR
 * #86 review round 2, Codex — a real gap connecting this read to the
 * parsers' own UTF-8 validation): `parseAndValidateVerdict` and
 * `parseCriteriaSpineArtifact` both run a FATAL `isUtf8` check, but ONLY
 * when handed a `Buffer` — a `string` input skips that check entirely
 * (see either function's own docstring/implementation), on the
 * assumption that a caller passing a string has already decoded it
 * safely. The PREVIOUS version of this function called
 * `handle.readFile("utf8")`, which silently replaces any malformed UTF-8
 * byte sequence with U+FFFD during decoding — BEFORE either parser ever
 * saw the artifact — so a corrupted artifact with invalid UTF-8 bytes
 * would slip through as a U+FFFD-mangled-but-ACCEPTED payload, bypassing
 * the exact fail-closed UTF-8 validation added to both parsers across
 * the d1/#74 review rounds. Returning the raw `Buffer` here and handing
 * it directly to those parsers (never `.toString()`-ing it first) lets
 * their own `isUtf8` check run on the true, undecoded bytes.
 *
 * Opens the file ONCE and checks its size via the resulting file
 * descriptor's own `stat()`, then reads through that SAME descriptor
 * (CodeQL `js/file-system-race`, alert #14 — a `stat` by PATH followed by
 * a separate `readFile` by PATH re-resolves the path twice, leaving a
 * real check-then-use gap the path could be swapped within; anchoring
 * both operations to one open file descriptor instead closes that gap by
 * construction, rather than arguing the race is unreachable in this
 * isolated CI job the way `apply-triage-verdict.mts`'s own still-open,
 * structurally-identical alert does today). Preserves the exact same
 * discipline `readVerdictArtifact` there documents — a runaway or
 * adversarial multi-GB artifact must be rejected without ever being fully
 * buffered — just anchored to a descriptor instead of a path.
 *
 * @param path - The artifact's path on disk.
 * @param maxBytes - The size ceiling to enforce, before ever reading the
 *   file's contents into memory.
 * @returns The file's raw bytes as a `Buffer`, or `null` if the file does
 *   not exist.
 * @throws If the file exists but exceeds `maxBytes`, or could not be
 *   opened/read for some other reason.
 */
async function readArtifactFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, "r");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      return null;
    }
    throw new Error(`artifact at ${path} could not be opened: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const fileStat = await handle.stat();
    if (fileStat.size > maxBytes) {
      throw new Error(`artifact at ${path} is ${fileStat.size} bytes, exceeds the ${maxBytes}-byte limit`);
    }
    try {
      return await handle.readFile();
    } catch (err) {
      // Reachable for a path that opens successfully but cannot actually
      // be READ as a regular file — e.g. a directory (EISDIR): `open`
      // alone does not fail for a directory, only the subsequent read
      // does.
      throw new Error(`artifact at ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Upper bound on `outcome.json`'s own raw size — this file is a single
 * boolean field (`spec-grounding-runner.mts`'s own workflow step writes
 * `{"hasCriteria": true|false}` via `jq`), so a generous-but-tiny ceiling
 * is enough; anything meaningfully larger than this is already a
 * corrupted or unexpected artifact.
 */
const MAX_OUTCOME_ARTIFACT_BYTES = 4096;

/**
 * Reads and shape-validates `outcome.json` — kept private and inline
 * (not extracted to a `*-logic.mts` module), matching `apply-triage-
 * verdict.mts`'s own precedent for trivial, entrypoint-specific
 * file-reading glue with no other consumer (`readVerdictArtifact` there
 * is equally private).
 *
 * @param path - `outcome.json`'s path on disk.
 * @returns `null` if the file is absent; the parsed `hasCriteria` value
 *   if present and valid.
 * @throws If the file is present but oversized, unreadable, not valid
 *   JSON, or not shaped exactly `{"hasCriteria": boolean}`.
 */
async function readOutcomeArtifact(path: string): Promise<boolean | null> {
  const raw = await readArtifactFile(path, MAX_OUTCOME_ARTIFACT_BYTES);
  if (raw === null) {
    return null;
  }
  // Unlike the verdict/criteria-spine artifacts (fed straight to parsers
  // with their own Buffer-only fatal isUtf8 check), outcome.json has no
  // such parser — it's a trivial, our-own-runner-written `{"hasCriteria":
  // boolean}` marker with no adversarial-content risk, so a plain UTF-8
  // decode (Node's usual lenient U+FFFD replacement on malformed bytes)
  // is unchanged from this function's prior behavior.
  const rawText = raw.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`outcome.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).hasCriteria !== "boolean" ||
    Object.keys(parsed as Record<string, unknown>).length !== 1
  ) {
    throw new Error(`outcome.json at ${path} must be exactly {"hasCriteria": boolean}, got ${rawText}`);
  }
  return (parsed as { hasCriteria: boolean }).hasCriteria;
}

/**
 * Clears any stale spec-grounded review state on a PR whose linked-issue
 * criteria have disappeared entirely (`hasCriteria: false`) — a P2 fix
 * (PR #86 review, Codex): a PR that PREVIOUSLY got a summary/fallback
 * comment or inline blocker threads, then had a later body edit remove
 * its last closing-keyword reference, used to leave that stale state
 * (still claiming blockers, or a failed pipeline, for criteria that no
 * longer exist) visible and gating forever — this entrypoint's own
 * `hasCriteria: false` path was a pure silent no-op with no upsert or
 * deletion at all. Clears BOTH channels: the summary comment (via {@link
 * clearStaleSpecGroundingSummary}, a no-op if none exists) and any prior
 * inline blocker comments (via {@link clearStaleInlineBlockerComments},
 * matched generically since there is no run plan at all once criteria
 * are gone).
 *
 * Scoped to `hasCriteria: false` ONLY — deliberately NOT extended to the
 * `"skipped"`/`"cancelled"` job-result branch above, even though team-
 * lead's own review raised the question: those two signals mean "this
 * run never checked", not "this run checked and found nothing" — a
 * draft-PR skip or a concurrency-superseded cancellation says nothing
 * about whether a PR's criteria actually disappeared, so clearing on
 * either would risk erasing a STILL-ACCURATE summary or still-open
 * blocker thread purely because this particular event didn't trigger a
 * real run. `hasCriteria: false` is the only signal that has actually
 * VERIFIED "no criteria remain".
 *
 * A genuine failure while clearing (anything other than the benign
 * "nothing to clear"/"already gone" cases, which never throw) is
 * surfaced as a visible fallback, the same "never silent" policy every
 * other network failure in this entrypoint follows.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 */
async function clearStaleSpecGroundingStateOnDisappearedCriteria(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  try {
    const summaryCleared = await clearStaleSpecGroundingSummary(token, owner, repo, prNumber);
    const clearedInlineCount = await clearStaleInlineBlockerComments(token, owner, repo, prNumber);
    console.log(
      `PR #${prNumber} had nothing to spec-ground (hasCriteria: false) — ` +
        (summaryCleared || clearedInlineCount > 0
          ? `cleared stale prior state (summary comment cleared=${summaryCleared}, ` +
            `${clearedInlineCount} inline comment(s) removed).`
          : `nothing to clear, silent no-op.`),
    );
  } catch (err) {
    await publishFallback(token, owner, repo, prNumber, [
      `PR #${prNumber} has no linked-issue criteria left to review, but clearing its prior ` +
        `spec-grounding state failed: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    process.exitCode = 1;
  }
}

export async function main(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY must be "owner/repo", got ${process.env.GITHUB_REPOSITORY}`);
  }
  const prNumber = Number(requireEnv("TRUSTED_PR_NUMBER"));
  const trustedHeadSha = requireEnv("TRUSTED_HEAD_SHA");
  const paths = resolvePaths();

  const jobResult = requireEnv("SPEC_GROUNDED_REVIEW_JOB_RESULT");
  if (jobResult === "skipped" || jobResult === "cancelled") {
    // Silent no-op, both cases — see this module's own top-level
    // docstring for why `cancelled` is grouped with `skipped` rather than
    // treated as a failure.
    console.log(
      `spec-grounded-review job result was "${jobResult}" — nothing to publish (silent no-op).`,
    );
    return;
  }
  if (jobResult !== "success") {
    await publishFallback(token, owner, repo, prNumber, [
      `spec-grounded-review job result was "${jobResult}", not "success" — the review pipeline ` +
        `did not complete; no artifact from this run is trusted.`,
    ]);
    process.exitCode = 1;
    return;
  }

  let hasCriteria: boolean | null;
  try {
    hasCriteria = await readOutcomeArtifact(paths.outcomePath);
  } catch (err) {
    await publishFallback(token, owner, repo, prNumber, [
      err instanceof Error ? err.message : String(err),
    ]);
    process.exitCode = 1;
    return;
  }
  if (hasCriteria === null) {
    await publishFallback(token, owner, repo, prNumber, [
      `outcome.json not found at ${paths.outcomePath} — the spec-grounded-review job result was ` +
        `"success", but its own self-describing marker artifact is missing; the pipeline may have ` +
        `crashed between writing it and this run reading it, or the artifact download failed.`,
    ]);
    process.exitCode = 1;
    return;
  }
  if (!hasCriteria) {
    await clearStaleSpecGroundingStateOnDisappearedCriteria(token, owner, repo, prNumber);
    return;
  }

  let verdictRaw: Buffer | null;
  try {
    verdictRaw = await readArtifactFile(paths.verdictPath, MAX_VERDICT_PAYLOAD_BYTES);
  } catch (err) {
    await publishFallback(token, owner, repo, prNumber, [
      err instanceof Error ? err.message : String(err),
    ]);
    process.exitCode = 1;
    return;
  }
  if (verdictRaw === null) {
    await publishFallback(token, owner, repo, prNumber, [
      `the review agent's verdict was not found at ${paths.verdictPath} — the review skill step ` +
        `likely failed, timed out, or was skipped despite hasCriteria: true.`,
    ]);
    process.exitCode = 1;
    return;
  }
  const verdictResult = parseAndValidateVerdict(verdictRaw);
  if (!verdictResult.ok) {
    await publishFallback(
      token,
      owner,
      repo,
      prNumber,
      verdictResult.errors.map((e) => `verdict validation: ${e}`),
    );
    process.exitCode = 1;
    return;
  }

  let spineRaw: Buffer | null;
  try {
    spineRaw = await readArtifactFile(paths.criteriaSpinePath, MAX_CRITERIA_SPINE_ARTIFACT_BYTES);
  } catch (err) {
    await publishFallback(token, owner, repo, prNumber, [
      err instanceof Error ? err.message : String(err),
    ]);
    process.exitCode = 1;
    return;
  }
  if (spineRaw === null) {
    await publishFallback(token, owner, repo, prNumber, [
      `criteria-spine.json was not found at ${paths.criteriaSpinePath} — the runner step likely ` +
        `did not complete despite hasCriteria: true.`,
    ]);
    process.exitCode = 1;
    return;
  }
  const spineResult = parseCriteriaSpineArtifact(spineRaw);
  if (!spineResult.ok) {
    await publishFallback(
      token,
      owner,
      repo,
      prNumber,
      spineResult.errors.map((e) => `criteria-spine.json validation: ${e}`),
    );
    process.exitCode = 1;
    return;
  }

  await publishSummary(token, owner, repo, prNumber, trustedHeadSha, spineResult.spine, verdictResult.verdict);
}

/**
 * Attempts to post this run's blockers (if any) as real, resolvable
 * inline comments — the diff fetch, deterministic-anchor selection, and
 * the 422 probe-then-degrade, all delegated to already-reviewed pure/
 * network-wiring code (`publish-spec-grounding-blocker-logic.mts`'s own
 * `planBlockerInlineComments`, `publish-spec-grounding-inline-comment-io
 * .mts`'s own `postInlineCommentPlan`).
 *
 * @returns `true` if every blocker was successfully posted as a real
 *   inline comment (`blockersPostedInline`); `false` if there was no
 *   addable anchor at all, or the first inline POST was rejected with a
 *   422 (the anchor-fallback case, either structurally or via the
 *   probe-then-degrade — the caller renders the full blocker detail in
 *   the summary instead either way).
 * @throws Any OTHER failure (a SHA mismatch, a diff-fetch error, a
 *   non-first or non-422 inline-posting failure) — a genuine error, not
 *   a case this function degrades from; the caller converts it into a
 *   visible fallback, same as every other artifact/network failure in
 *   this entrypoint.
 */
async function tryPostBlockersInline(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  trustedHeadSha: string,
  criterionBlockers: readonly JoinedCriterionResult[],
  spine: ParsedCriteriaSpine,
  diffTruncationBlocksClosingClaim: boolean,
): Promise<boolean> {
  const pr = await fetchAndVerifyPrShas(token, owner, repo, prNumber, trustedHeadSha);
  const diff = await fetchPrDiff(token, owner, repo, pr.base.sha, pr.head.sha);
  const plan = planBlockerInlineComments(
    criterionBlockers,
    spine.unreviewedClosingIssues,
    diff,
    diffTruncationBlocksClosingClaim,
  );
  if (plan.anchorFallbackNeeded) {
    return false;
  }
  const postResult = await postInlineCommentPlan(token, owner, repo, prNumber, pr.head.sha, plan.comments);
  return postResult.ok;
}

async function publishSummary(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  trustedHeadSha: string,
  spine: ParsedCriteriaSpine,
  verdict: SpecGroundingVerdict,
): Promise<void> {
  const joined = joinFindingsToSpine(spine.entries, verdict);
  const criterionBlockers: readonly JoinedCriterionResult[] = joined.filter(
    (e) => deriveSeverity(e) === "blocker",
  );
  const diffTruncationBlocksClosingClaim = isDiffTruncationUnverifiableForClosing(
    joined,
    spine.unreviewedClosingIssues,
    spine.diffTruncated,
  );
  const totalBlockerCount =
    criterionBlockers.length + spine.unreviewedClosingIssues.length + (diffTruncationBlocksClosingClaim ? 1 : 0);

  let blockersPostedInline = false;
  if (totalBlockerCount > 0) {
    try {
      blockersPostedInline = await tryPostBlockersInline(
        token,
        owner,
        repo,
        prNumber,
        trustedHeadSha,
        criterionBlockers,
        spine,
        diffTruncationBlocksClosingClaim,
      );
    } catch (err) {
      // A genuine error (SHA mismatch, diff-fetch failure, a non-first or
      // non-422 inline-posting failure) — NOT the anchor-fallback or
      // 422-degrade case, both of which `tryPostBlockersInline` already
      // resolves to a plain `false` return, never a throw. Same "visible
      // fallback, never a silent or bare-CI-red failure" treatment as
      // every other artifact/network failure in this entrypoint.
      await publishFallback(token, owner, repo, prNumber, [
        `failed to post this run's blocking findings as inline comments: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ]);
      process.exitCode = 1;
      return;
    }
  }

  let body = buildSpecGroundingSummaryCommentBody(
    joined,
    spine.unreviewedClosingIssues,
    { truncated: spine.truncated, diffTruncated: spine.diffTruncated },
    blockersPostedInline,
  );
  if (totalBlockerCount > 0 && !blockersPostedInline) {
    body += "\n" + buildAnchorFallbackSummarySupplement(
      criterionBlockers,
      spine.unreviewedClosingIssues,
      diffTruncationBlocksClosingClaim,
    );
  }

  await upsertSummaryComment(token, owner, repo, prNumber, body);
  console.log(
    `Published spec-grounded review summary for PR #${prNumber}: ${totalBlockerCount} blocking ` +
      `finding(s) (postedInline=${blockersPostedInline}), ${joined.length} criterion(a) reviewed.`,
  );

  if (totalBlockerCount > 0 && !blockersPostedInline) {
    // A blocker posted as a REAL inline thread is already gated by
    // `required_conversation_resolution` on the thread itself — this job
    // does not also need to fail red for that, healthy case. Exiting
    // nonzero is reserved for the anchor-fallback/422-degrade case, per
    // `buildAnchorFallbackSummarySupplement`'s own documented contract
    // (LOW2, #12 3b-iii-d+e PR-plan sign-off: the create-review-comment
    // 422 maps to this exact degrade path, not an unhandled failure).
    process.exitCode = 1;
  }
}

/**
 * Formats an uncaught top-level error for the workflow log — factored out
 * of the self-invoke guard below (proactive fold, PR #12 3b-iii-d3, per
 * team-lead's disposition generalizing PR #85's own log-neutralization
 * finding to this entrypoint's own top-level catch-all): `main()`'s own
 * uncaught rejection can transitively carry untrusted text — a
 * `GithubApiError` echoing a raw GitHub API response body, or a wrapped
 * validation-error string surfaced from `readArtifactFile`/
 * `parseAndValidateVerdict`/`parseCriteriaSpineArtifact` — reaching a raw
 * `console.error(..., err)` call untouched would carry the SAME
 * workflow-command/ANSI-escape/bidi-override risk `neutralizeReasonForLog`
 * already closes for `publishFallback`'s own reasons. Reuses that
 * function (now exported from `publish-spec-grounding-comment-io.mts` via
 * PR #85) rather than a second, independently-maintained copy.
 *
 * Prefers `err.stack` over `err.message` alone when available (the
 * top-level catch-all is the LAST chance to log a real stack trace for
 * diagnosis — every other `catch` in this file already extracts just
 * `.message` for a user-facing fallback reason, a narrower need this one
 * doesn't share).
 *
 * EXPORTED for direct unit testing: the self-invoke guard itself
 * (`import.meta.url === ...`) is genuinely unreachable in-process (v8/
 * istanbul coverage instrumentation only tracks code executed by the
 * vitest worker itself, matching `spec-grounding-runner.mts`'s own
 * identical guard and reasoning), but the neutralization behavior itself
 * is ordinary, testable logic and does not need to inherit that
 * limitation.
 *
 * @param err - The uncaught value `main()`'s own top-level rejection carries.
 * @returns A single neutralized, length-bounded line safe for a workflow log.
 */
export function formatUncaughtErrorForLog(err: unknown): string {
  const raw = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return neutralizeReasonForLog(raw);
}

// Only self-invoke when run directly, not when imported by a test —
// matches `apply-triage-verdict.mts`'s own identical guard. Genuinely
// uncovered by unit tests (they import `main` directly): v8/istanbul
// coverage instrumentation only tracks code executed IN-PROCESS by the
// vitest worker itself, matching `spec-grounding-runner.mts`'s own
// identical pragma and reasoning for the identical guard shape.
/* v8 ignore start */
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("publish-spec-grounding-verdict failed:", formatUncaughtErrorForLog(err));
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
