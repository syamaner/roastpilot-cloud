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
 * SLICE d3 SCOPE (deliberately incomplete — split per team-lead's "keep
 * d and e separate PRs, split d if it measures over 400 [logic lines]"
 * direction: d1 = pure-logic artifact parsing, d2 = comment I/O, d3 =
 * this entrypoint, d4 = inline blocker posting, not yet built): posts
 * the SUMMARY comment only — the diff fetch + deterministic-anchor
 * selection `publish-spec-grounding-blocker-logic.mts`'s own {@link
 * import("./publish-spec-grounding-blocker-logic.mts").planBlockerInlineComments}
 * needs are not wired up yet. So EVERY run with a blocking finding is,
 * structurally, exactly the anchor-fallback case: `blockersPostedInline`
 * is always `false`, the full blocker detail is always appended to the
 * summary via `buildAnchorFallbackSummarySupplement`, and this
 * entrypoint exits nonzero whenever there is one, per that function's
 * own documented contract. Self-correcting once d4 lands. Not yet wired
 * into any workflow (that is slice e, also separate), so this interim
 * behavior has no live, observable effect.
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
 *      - Present, `hasCriteria: false` → silent no-op (the runner found
 *        no linked issue, or no unmet criteria — genuinely nothing to
 *        spec-ground, not a failure).
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

import { readFile, stat } from "node:fs/promises";
import { requireEnv } from "./github-api.mts";
import {
  MAX_PAYLOAD_BYTES as MAX_VERDICT_PAYLOAD_BYTES,
  parseAndValidateVerdict,
  type SpecGroundingVerdict,
} from "./spec-grounding-verdict-schema.mts";
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
import { buildAnchorFallbackSummarySupplement } from "./publish-spec-grounding-blocker-logic.mts";
import { publishFallback, upsertSummaryComment } from "./publish-spec-grounding-comment-io.mts";

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
 * Reads a file's raw bytes, tolerating a missing file by returning `null`
 * — the shared shape every artifact read in this entrypoint needs (a
 * missing file is not itself a crash; the CALLER decides what a missing
 * artifact means for its own tri-state gate).
 *
 * Checks the file's size via `stat` BEFORE reading its contents into
 * memory, same discipline as `apply-triage-verdict.mts`'s own
 * `readVerdictArtifact` — a runaway or adversarial multi-GB artifact must
 * be rejected without ever being fully buffered.
 *
 * @param path - The artifact's path on disk.
 * @param maxBytes - The size ceiling to enforce via `stat`, before ever
 *   calling `readFile`.
 * @returns The file's raw text, or `null` if the file does not exist.
 * @throws If the file exists but exceeds `maxBytes`, or exists but could
 *   not be read for some other reason (a narrow TOCTOU race).
 */
async function readArtifactFile(path: string, maxBytes: number): Promise<string | null> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(path);
  } catch {
    return null;
  }
  if (fileStat.size > maxBytes) {
    throw new Error(`artifact at ${path} is ${fileStat.size} bytes, exceeds the ${maxBytes}-byte limit`);
  }
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    // Narrow TOCTOU race (stat succeeds, the file vanishes/becomes
    // unreadable before readFile runs) — not meaningfully triggerable in
    // this single-shot CI job; kept as a defensive branch so a real
    // occurrence still fails closed with a clear error rather than an
    // unhandled rejection.
    /* v8 ignore next 3 */
    throw new Error(
      `artifact at ${path} could not be read after a successful stat (possible race): ${err instanceof Error ? err.message : String(err)}`,
    );
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
    throw new Error(`outcome.json at ${path} must be exactly {"hasCriteria": boolean}, got ${raw}`);
  }
  return (parsed as { hasCriteria: boolean }).hasCriteria;
}

export async function main(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY must be "owner/repo", got ${process.env.GITHUB_REPOSITORY}`);
  }
  const prNumber = Number(requireEnv("TRUSTED_PR_NUMBER"));
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
    console.log(`PR #${prNumber} had nothing to spec-ground (hasCriteria: false) — silent no-op.`);
    return;
  }

  let verdictRaw: string | null;
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

  let spineRaw: string | null;
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

  await publishSummary(token, owner, repo, prNumber, spineResult.spine, verdictResult.verdict);
}

async function publishSummary(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
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

  // Slice d1 never posts inline blocker comments (see this module's own
  // top-level docstring) — every blocker-bearing run is therefore,
  // structurally, the anchor-fallback case: `blockersPostedInline` is
  // always `false`, and the full blocker detail is always appended to the
  // summary via `buildAnchorFallbackSummarySupplement`, exactly the
  // contract that function documents for `anchorFallbackNeeded: true`.
  let body = buildSpecGroundingSummaryCommentBody(
    joined,
    spine.unreviewedClosingIssues,
    { truncated: spine.truncated, diffTruncated: spine.diffTruncated },
    false,
  );
  if (totalBlockerCount > 0) {
    body += "\n" + buildAnchorFallbackSummarySupplement(
      criterionBlockers,
      spine.unreviewedClosingIssues,
      diffTruncationBlocksClosingClaim,
    );
  }

  await upsertSummaryComment(token, owner, repo, prNumber, body);
  console.log(
    `Published spec-grounded review summary for PR #${prNumber}: ${totalBlockerCount} blocking ` +
      `finding(s), ${joined.length} criterion(a) reviewed.`,
  );

  if (totalBlockerCount > 0) {
    // Same "the entrypoint is responsible for exiting nonzero" contract
    // `buildAnchorFallbackSummarySupplement`'s own docstring documents for
    // the anchor-fallback case — every blocker-bearing run in slice d3 is
    // exactly that case (see this module's own top-level docstring).
    process.exitCode = 1;
  }
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
    console.error("publish-spec-grounding-verdict failed:", err);
    process.exitCode = 1;
  });
}
/* v8 ignore stop */
