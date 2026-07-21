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
 * - `GITHUB_RUN_NUMBER` — from `github.run_number` (F1-S9 slice 90.3);
 *   validated and canonicalized ONCE, at the very top of `publishSummary`,
 *   before any posting or reconciliation (F1-S9 slice 90.4). Embedded as
 *   this run's own generation key in every inline blocker comment's body,
 *   alongside (never replacing) that comment's own identity marker — see
 *   `publish-spec-grounding-blocker-logic.mts`'s own
 *   `inlineBlockerGenerationMarker` for the full design reasoning — and
 *   consumed by the de-reference reconcile's own generation guard (F1-S9
 *   slice 90.4, `deleteDeReferencedInlineBlockerComments`).
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
import { parseLinkedIssueReferences } from "./spec-grounding-logic.mts";
import { fetchPrDiff } from "./spec-grounding-runner.mts";
import {
  MAX_CRITERIA_SPINE_ARTIFACT_BYTES,
  parseCriteriaSpineArtifact,
  type ParsedCriteriaSpine,
} from "./spec-grounding-runner-logic.mts";
import {
  buildSpecGroundingSummaryCommentBody,
  buildStaleBlockerSkippedNote,
  deriveSeverity,
  isDiffTruncationUnverifiableForClosing,
  joinFindingsToSpine,
  type JoinedCriterionResult,
  type NoCriteriaReason,
} from "./publish-spec-grounding-verdict-logic.mts";
import {
  buildAnchorFallbackSummarySupplement,
  planBlockerInlineComments,
  type InlinePostingDegradeReason,
} from "./publish-spec-grounding-blocker-logic.mts";
import {
  clearStaleSpecGroundingSummary,
  neutralizeReasonForLog,
  publishFallback,
  upsertSummaryComment,
} from "./publish-spec-grounding-comment-io.mts";
import {
  clearStaleInlineBlockerComments,
  deleteDeReferencedInlineBlockerComments,
  postInlineCommentPlan,
} from "./publish-spec-grounding-inline-comment-io.mts";

interface GitHubPullRequestShas {
  readonly head: { readonly sha: string };
  readonly base: { readonly sha: string };
  /**
   * The PR's own current body — added alongside the SHAs (PR #87 review
   * round 3, Codex, P1, gate-integrity TOCTOU) so {@link
   * isStillSafeToDeleteInlineBlockerThreads} can re-parse it without a
   * second GET. Unused by {@link fetchAndVerifyPrShas}'s own existing
   * caller (`tryPostBlockersInline`), which only ever needed the SHAs.
   */
  readonly body: string | null;
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

/**
 * Re-validates, immediately before the DESTRUCTIVE inline-blocker-thread
 * deletion in {@link clearStaleSpecGroundingStateOnDisappearedCriteria}'s
 * own `"no-references"` branch, that the "no linked-issue reference at
 * all" signal `spec-grounding-runner.mts` reported is STILL true right
 * now — not just at the moment that read-only run happened to check (PR
 * #87 review round 3, Codex, P1 — a genuine gate-integrity TOCTOU): a
 * body-only edit does NOT bump the PR's own head SHA, so a PR whose body
 * is edited to ADD a closing reference (or that gets a superseding run
 * posting new blockers for that reference) AFTER the read-only runner
 * finished but BEFORE this publish run reaches the delete would
 * otherwise have an OLDER publish run delete valid, currently-gating
 * inline blocker thread(s) for a claim the runner never actually saw —
 * an anti-gaming hole distinct from (but the same root class as) the
 * self-attested-criteria one PR #87's own earlier round already closed.
 *
 * Re-checks TWO independent things against the PR's CURRENT state,
 * fetched fresh here (never reused from any earlier call in this same
 * run):
 * 1. The PR's current head SHA still matches `trustedHeadSha` — the SAME
 *    check {@link fetchAndVerifyPrShas} makes, but surfaced as a plain
 *    boolean here, never a throw: a mismatch is an EXPECTED race outcome
 *    this function's caller degrades from gracefully, not a genuine
 *    error worth failing the whole run over.
 * 2. The PR's CURRENT body, re-parsed with the SAME {@link
 *    parseLinkedIssueReferences} the runner itself uses, still yields
 *    ZERO linked-issue references.
 *
 * Only when BOTH still hold is it actually safe to delete. A genuine
 * network/API failure while re-fetching still propagates uncaught (this
 * function only absorbs the two SPECIFIC, expected-race conditions
 * above — never a real error, which the caller's own existing "never
 * silent" fallback handling already covers).
 *
 * RESIDUAL, documented honestly rather than understated (PR #87 review
 * round 4, Codex, P1 — an earlier version of this docstring called this
 * gap "sub-second", which undersold it): this closes the window between
 * the READ-ONLY runner's own execution and THIS revalidation, but not
 * the window from here through the actual destructive work that
 * follows — which spans the summary comment's own GET+PATCH, the inline
 * comments' own GET, AND the delete calls themselves (each matched by a
 * GENERIC marker, not a specific run's own plan), none of which is a
 * single atomic operation. A run superseding THIS one (e.g. a body edit
 * landing between this revalidation and the delete) can genuinely land
 * inside that window; true atomicity across several separate REST calls
 * isn't achievable via GitHub's API regardless of how tightly this
 * function's own two checks are drawn.
 *
 * What actually closes the remaining risk — an OLDER publish run's own
 * delete removing inline blocker threads a NEWER, superseding run just
 * posted for a newly-added reference — is OPERATIONAL, not a property
 * of this function: slice e's own dedicated per-PR concurrency group
 * (`cancel-in-progress: false`, serializing every publish run for a
 * given PR to completion before the next one starts) means two publish
 * runs for the same PR never execute concurrently at all, so this
 * window can only ever be crossed by a run that is ALREADY committed to
 * running before the newer one starts — the same config-dependent-
 * safety class the checkout's own `base.sha` pin belongs to (correct
 * given the workflow is configured as designed, not self-enforcing
 * independent of that configuration). GENERATION-AWARE ownership (each
 * run stamping and checking a run-identity marker on what it deletes,
 * self-safe independent of any concurrency configuration) is tracked as
 * defense-in-depth in issue #88, ahead of the gate-enable decision
 * (#47) — not fixed here.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param trustedHeadSha - `TRUSTED_HEAD_SHA`, from the workflow's own
 *   event context — the value this run's OWN read-only pass was
 *   reviewed against, never re-derived.
 * @returns `true` only if the PR's CURRENT head SHA still matches AND
 *   its CURRENT body still yields zero linked-issue references.
 */
async function isStillSafeToDeleteInlineBlockerThreads(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  trustedHeadSha: string,
): Promise<boolean> {
  const pr = await githubRequest<GitHubPullRequestShas>(token, "GET", `/repos/${owner}/${repo}/pulls/${prNumber}`);
  if (pr.head.sha !== trustedHeadSha) {
    return false;
  }
  const references = parseLinkedIssueReferences(pr.body ?? "", `${owner}/${repo}`);
  return references.length === 0;
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
 * Upper bound on `outcome.json`'s own raw size — this file is a tiny,
 * fixed-shape marker (`spec-grounding-runner.mts`'s own workflow step
 * writes it via `jq`), so a generous-but-tiny ceiling is enough; anything
 * meaningfully larger than this is already a corrupted or unexpected
 * artifact.
 */
const MAX_OUTCOME_ARTIFACT_BYTES = 4096;

/** The set of `noCriteriaReason` values `spec-grounding-runner.mts` can legitimately emit. */
const NO_CRITERIA_REASONS: ReadonlySet<string> = new Set<NoCriteriaReason>(["no-references", "no-unmet-criteria"]);

/**
 * `outcome.json`'s own shape, post-validation — a discriminated union so
 * `noCriteriaReason` is only ever accessible (and only ever populated)
 * when `hasCriteria` is `false` (PR #87 review, Codex, P1/medium fold).
 */
type OutcomeArtifact =
  | { readonly hasCriteria: true }
  | { readonly hasCriteria: false; readonly noCriteriaReason: NoCriteriaReason };

/**
 * Reads and shape-validates `outcome.json` — kept private and inline
 * (not extracted to a `*-logic.mts` module), matching `apply-triage-
 * verdict.mts`'s own precedent for trivial, entrypoint-specific
 * file-reading glue with no other consumer (`readVerdictArtifact` there
 * is equally private).
 *
 * `hasCriteria: false` now carries a `noCriteriaReason` (PR #87 review,
 * Codex, P1/medium fold — a real gap the original version missed):
 * `spec-grounding-runner.mts` emits `hasCriteria: false` from TWO
 * DIFFERENT branches with materially different trust — no closing-
 * keyword reference at all (`"no-references"`, no obligation ever
 * existed) versus a linked issue whose acceptance criteria are all
 * SELF-ATTESTED complete (`"no-unmet-criteria"`, never diff-verified).
 * Without this field, the privileged publisher's own clear-on-disappear
 * logic could not tell the two apart, and would delete a
 * `required_conversation_resolution`-gating inline blocker thread in
 * BOTH cases — an anti-gaming hole in the self-attested case.
 *
 * FAILS CLOSED (never destructively) when `noCriteriaReason` is missing
 * or not one of the known values on the `hasCriteria: false` path: a
 * malformed, stale-runner, or tampered artifact is coerced to
 * `"no-unmet-criteria"` — the NON-destructive treatment — rather than
 * throwing (which would itself be a visible-fallback case) or defaulting
 * to `"no-references"` (which would delete inline threads on a signal
 * this function could not actually confirm). Never too permissive, only
 * ever too cautious.
 *
 * @param path - `outcome.json`'s path on disk.
 * @returns `null` if the file is absent; the parsed, shape-validated
 *   artifact if present.
 * @throws If the file is present but oversized, unreadable, not valid
 *   JSON, missing `hasCriteria`, or carrying an unexpected extra field.
 */
async function readOutcomeArtifact(path: string): Promise<OutcomeArtifact | null> {
  const raw = await readArtifactFile(path, MAX_OUTCOME_ARTIFACT_BYTES);
  if (raw === null) {
    return null;
  }
  // Unlike the verdict/criteria-spine artifacts (fed straight to parsers
  // with their own Buffer-only fatal isUtf8 check), outcome.json has no
  // such parser — it's a trivial, our-own-runner-written marker with no
  // adversarial-content risk, so a plain UTF-8 decode (Node's usual
  // lenient U+FFFD replacement on malformed bytes) is unchanged from this
  // function's prior behavior.
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
    typeof (parsed as Record<string, unknown>).hasCriteria !== "boolean"
  ) {
    throw new Error(`outcome.json at ${path} must be shaped {"hasCriteria": boolean, ...}, got ${rawText}`);
  }
  const record = parsed as Record<string, unknown>;
  const hasCriteria = record.hasCriteria as boolean;

  if (hasCriteria) {
    if (Object.keys(record).length !== 1) {
      throw new Error(
        `outcome.json at ${path} must be exactly {"hasCriteria": true} when hasCriteria is true ` +
          `(no noCriteriaReason expected), got ${rawText}`,
      );
    }
    return { hasCriteria: true };
  }

  const extraKeys = Object.keys(record).filter((key) => key !== "hasCriteria" && key !== "noCriteriaReason");
  if (extraKeys.length > 0) {
    throw new Error(`outcome.json at ${path} carries unexpected field(s) (${extraKeys.join(", ")}), got ${rawText}`);
  }
  const rawReason = record.noCriteriaReason;
  const noCriteriaReason: NoCriteriaReason =
    typeof rawReason === "string" && NO_CRITERIA_REASONS.has(rawReason)
      ? (rawReason as NoCriteriaReason)
      : "no-unmet-criteria";
  return { hasCriteria: false, noCriteriaReason };
}

/**
 * Clears any stale spec-grounded review state on a PR whose linked-issue
 * criteria have disappeared or gone unmet (`hasCriteria: false`) — a P2
 * fix (PR #86 review, Codex): a PR that PREVIOUSLY got a summary/
 * fallback comment or inline blocker threads, then had a later change
 * make `hasCriteria: false` true, used to leave that stale state (still
 * claiming blockers, or a failed pipeline) visible and gating forever —
 * this entrypoint's own `hasCriteria: false` path was a pure silent
 * no-op with no upsert or deletion at all.
 *
 * BRANCHES ON `reason` (PR #87 review, Codex, P1/medium fold — the
 * original version of this function treated every `hasCriteria: false`
 * run identically, an anti-gaming hole):
 * - `"no-references"` — no closing-keyword reference exists at all, so
 *   there was never any obligation. RE-VALIDATES this is STILL true right
 *   now, immediately before deleting, via {@link
 *   isStillSafeToDeleteInlineBlockerThreads} (PR #87 review round 3,
 *   Codex, P1 — a genuine gate-integrity TOCTOU: a body-only edit does
 *   NOT bump the trusted head SHA, so a PR body edited to ADD a closing
 *   reference AFTER the read-only runner finished but BEFORE this delete
 *   would otherwise have this run delete a currently-gating thread for a
 *   claim the runner never saw). If STILL safe: clears BOTH channels —
 *   the summary comment (via {@link clearStaleSpecGroundingSummary}, a
 *   no-op if none exists) AND deletes any prior inline blocker comments
 *   (via {@link clearStaleInlineBlockerComments}, matched generically
 *   since there is no run plan at all once criteria are gone). If NOT
 *   still safe (an expected race outcome, never treated as an error):
 *   degrades to the SAME non-destructive treatment `"no-unmet-criteria"`
 *   gets below — accurate summary, inline threads left untouched.
 * - `"no-unmet-criteria"` (or any reason this run could not positively
 *   confirm as `"no-references"`, per {@link readOutcomeArtifact}'s own
 *   fail-closed coercion) — a closing claim STILL exists; the linked
 *   issue's own criteria are merely SELF-ATTESTED complete, never
 *   diff-verified. Upserts an ACCURATE summary explaining this, but
 *   deliberately does NOT delete inline blocker threads — deleting a
 *   `required_conversation_resolution`-gating thread here, on an
 *   unverified self-attestation, would be exactly the anti-gaming hole
 *   this branch exists to close. A human still triages and resolves any
 *   remaining thread.
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
 * VERIFIED "no unmet criteria remain" (with `reason` further narrowing
 * exactly what was verified).
 *
 * A genuine failure while clearing (anything other than the benign
 * "nothing to clear"/"already gone" cases, or the expected-race
 * degrade above, none of which throw) is surfaced as a visible
 * fallback, the same "never silent" policy every other network failure
 * in this entrypoint follows.
 *
 * @param token - The job's own `pull-requests: write` token.
 * @param owner - The repository owner.
 * @param repo - The repository name.
 * @param prNumber - The trusted PR number this run is publishing for.
 * @param reason - Why this run found `hasCriteria: false`.
 * @param trustedHeadSha - `TRUSTED_HEAD_SHA`, from the workflow's own
 *   event context — needed for the `"no-references"` branch's own
 *   pre-delete revalidation.
 */
async function clearStaleSpecGroundingStateOnDisappearedCriteria(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  reason: NoCriteriaReason,
  trustedHeadSha: string,
): Promise<void> {
  try {
    if (reason === "no-references") {
      const stillSafeToDelete = await isStillSafeToDeleteInlineBlockerThreads(
        token,
        owner,
        repo,
        prNumber,
        trustedHeadSha,
      );
      if (stillSafeToDelete) {
        const summaryCleared = await clearStaleSpecGroundingSummary(token, owner, repo, prNumber, "no-references");
        const clearedInlineCount = await clearStaleInlineBlockerComments(token, owner, repo, prNumber);
        console.log(
          `PR #${prNumber} has no linked-issue reference at all (hasCriteria: false, ` +
            `reason=no-references, revalidated) — cleared stale prior state (summary comment cleared=` +
            `${summaryCleared}, ${clearedInlineCount} inline comment(s) removed).`,
        );
        return;
      }
      // Expected race, NOT an error: the PR's head moved, or its current
      // body now yields a closing reference the read-only runner never
      // saw. Degrade to the non-destructive treatment -- never delete a
      // thread this run could not actually re-verify is obligation-free.
      const summaryCleared = await clearStaleSpecGroundingSummary(
        token,
        owner,
        repo,
        prNumber,
        "race-detected-before-delete",
      );
      console.log(
        `PR #${prNumber}'s state changed since the spec-grounded review ran (head moved, or a new ` +
          `closing reference now exists) — degrading to the non-destructive path: summary comment ` +
          `updated (cleared=${summaryCleared}); any prior inline blocker thread(s) were deliberately ` +
          `LEFT UNTOUCHED for a fresh run to re-evaluate.`,
      );
      return;
    }
    // "no-unmet-criteria" (or a coerced-to-safe unknown/missing reason):
    // a closing claim STILL exists, self-attested only -- inline blocker
    // threads are deliberately left untouched for a human to triage.
    const summaryCleared = await clearStaleSpecGroundingSummary(token, owner, repo, prNumber, reason);
    console.log(
      `PR #${prNumber}'s linked issue(s) show every acceptance criterion self-attested complete ` +
        `(hasCriteria: false, reason=${reason}) — summary comment updated (cleared=${summaryCleared}); ` +
        `any prior inline blocker thread(s) were deliberately LEFT UNTOUCHED, not cleared.`,
    );
  } catch (err) {
    await publishFallback(token, owner, repo, prNumber, [
      `PR #${prNumber} has no unmet linked-issue criteria left to review, but clearing its prior ` +
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
  // F1-S9 slice 90.3 (the #90 PR-plan's own generation-key item, #88):
  // `github.run_number`, not `run_id` -- see `publish-spec-grounding-
  // blocker-logic.mts`'s own `inlineBlockerGenerationMarker` docstring
  // for why `run_number`'s documented per-workflow monotonicity is the
  // property a future generation-aware delete comparison (slice 90.4)
  // needs, which `run_id` does not guarantee.
  const runNumber = requireEnv("GITHUB_RUN_NUMBER");
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

  let outcome: OutcomeArtifact | null;
  try {
    outcome = await readOutcomeArtifact(paths.outcomePath);
  } catch (err) {
    await publishFallback(token, owner, repo, prNumber, [
      err instanceof Error ? err.message : String(err),
    ]);
    process.exitCode = 1;
    return;
  }
  if (outcome === null) {
    await publishFallback(token, owner, repo, prNumber, [
      `outcome.json not found at ${paths.outcomePath} — the spec-grounded-review job result was ` +
        `"success", but its own self-describing marker artifact is missing; the pipeline may have ` +
        `crashed between writing it and this run reading it, or the artifact download failed.`,
    ]);
    process.exitCode = 1;
    return;
  }
  if (!outcome.hasCriteria) {
    await clearStaleSpecGroundingStateOnDisappearedCriteria(
      token,
      owner,
      repo,
      prNumber,
      outcome.noCriteriaReason,
      trustedHeadSha,
    );
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

  await publishSummary(
    token,
    owner,
    repo,
    prNumber,
    trustedHeadSha,
    runNumber,
    spineResult.spine,
    verdictResult.verdict,
  );
}

/** {@link tryPostBlockersInline}'s own richer result — see its docstring. */
interface TryPostBlockersInlineResult {
  readonly postedInline: boolean;
  readonly degradeReason: InlinePostingDegradeReason | null;
  readonly staleBlockerIssueNumbers: readonly number[];
}

/**
 * Attempts to post this run's blockers (if any) as real, resolvable
 * inline comments — the diff fetch, deterministic-anchor selection, and
 * the 422 probe-then-degrade, all delegated to already-reviewed pure/
 * network-wiring code (`publish-spec-grounding-blocker-logic.mts`'s own
 * `planBlockerInlineComments`, `publish-spec-grounding-inline-comment-io
 * .mts`'s own `postInlineCommentPlan`).
 *
 * RE-CHECKS the CURRENT PR body before planning anything (PR #87 review
 * round 4, Codex, P1 — symmetric to the delete-path TOCTOU fold already
 * closed for the `hasCriteria: false` path): `criterionBlockers` and
 * `spine.unreviewedClosingIssues` are both computed from the RUNNER-TIME
 * body, but a body-only edit never bumps the trusted head SHA — a PR
 * whose body is edited to REMOVE a reference to some issue #N (between
 * the read-only run and this publish run) would otherwise have this
 * function post an inline comment reasserting an obligation for #N that
 * this PR no longer even claims to reference at all. Re-parses `pr.body`
 * with the SAME {@link parseLinkedIssueReferences} the runner itself
 * uses, and filters BOTH `criterionBlockers` and
 * `spine.unreviewedClosingIssues` down to entries whose own `issueNumber`
 * is still in that current set — the STALE ones are reported back to the
 * caller (never silently dropped) so the summary can say so, never
 * posted inline.
 *
 * KIND-AWARE, not merely presence-aware (F1-S9 slice 90.4, PR #95 review
 * round 2 — Codex AND claude-review independently converged on the
 * identical finding: this filter and `publishSummary`'s own
 * `currentClosingIssueNumbers`, computed from the SAME body for the
 * reconcile call, MUST agree on what "still live" means, or the two
 * mechanisms disagree on a downgraded issue). Every entry in
 * `criterionBlockers`/`spine.unreviewedClosingIssues` is `closing`-kind
 * by construction — `deriveSeverity` never escalates a `non-closing`
 * entry, and `computeCriteriaSpineTruncation` only ever adds `closing`-kind
 * issues to `unreviewedClosingIssues`. So the filter below now checks
 * "referenced as CLOSING right now", not merely "referenced at all": a
 * body edit that downgrades `Closes #N` to a plain `Refs #N` (still
 * mentions the issue, no longer claims to close it) is now treated the
 * SAME way an outright removal is — folded into `staleBlockerIssueNumbers`
 * (this function makes no attempt to distinguish "removed entirely" from
 * "downgraded to non-closing" in that one bucket; both get the identical
 * "not posted inline, no longer a live closing obligation" treatment).
 * BEFORE this fix, a downgraded issue's own `criterionId`/`issueNumber`
 * stayed in `currentlyReferencedIssueNumbers` (a presence-only set), so
 * this function POSTED/PATCHED its inline comment THIS run and reported
 * `postedInline: true` — only for `publishSummary`'s own
 * `deleteDeReferencedInlineBlockerComments` call to immediately delete
 * that SAME comment (since it correctly excludes non-closing references)
 * — a deterministic body-edit bypass: the summary and exit code both
 * claimed a healthy, gated state (`blockersPostedInline: true`) for a
 * finding whose only inline thread had already been deleted in the same
 * run, with no explanatory note at all (since `staleBlockerIssueNumbers`
 * never saw it either).
 *
 * TAKES `pr` ALREADY FETCHED AND HEAD-VERIFIED (PR #87 review round 7,
 * Codex, medium, fail-open close): {@link publishSummary}'s own caller
 * now fetches and verifies the PR's current SHAs/body ONCE, before
 * deciding whether there are any blockers at all — an earlier version had
 * this function do that fetch+verify itself, which meant the
 * zero-blocker "no blocking findings" path NEVER verified the trusted
 * head SHA at all, so a push moving the PR after review could yield a
 * stale all-clear for a head this run never actually reviewed. This
 * function no longer fetches or verifies anything itself; it trusts its
 * caller already did.
 *
 * DELIBERATE DESIGN (team-lead's ruling, PR #87 review round 4b): the
 * caller's own {@link buildSpecGroundingSummaryCommentBody} still counts
 * `criterionBlockers.length + unreviewedClosingIssues.length` from the
 * UNFILTERED (review-time) sets for its own "N blocking finding(s)"
 * wording and exit-code decision — it does NOT recompute that count from
 * the staleness filtering this function does internally. This is
 * intentionally FAIL-SAFE, not a bug: it can only ever OVER-gate (exit
 * nonzero, or keep counting a stale finding) never UNDER-gate (erase a
 * real one), and `buildSpecGroundingSummaryCommentBody` (round 4b, this
 * same fold) now labels the count explicitly as review-time and
 * reconciles it against `staleBlockerIssueNumbers` whenever any exist —
 * so the headline stays ACCURATE, not misleading, without needing to
 * restructure the count itself. The DEEPER design question — should the
 * count/exit-code instead reflect only the still-referenced subset, and
 * should non-blocking findings get the same staleness treatment — is
 * tracked in issue #89, ahead of the gate-enable decision (#47); not
 * folded into this one, since it would require passing
 * `buildSpecGroundingSummaryCommentBody` FILTERED `joined`/
 * `unreviewedClosingIssues` arrays, which also carry non-blocking
 * findings that should NOT be filtered by this same staleness logic — a
 * real restructuring, not a cheap fold.
 *
 * @param runNumber - This run's own VALIDATED, canonicalized
 *   `github.run_number` (F1-S9 slice 90.4, Codex finding #798 — validated
 *   ONCE by the caller, `publishSummary`, before this function or any
 *   other posting is ever attempted; see that function's own top-of-body
 *   validation), as a plain digit string — threaded straight through to
 *   {@link planBlockerInlineComments}, which embeds it in every planned
 *   comment's own body via `inlineBlockerGenerationMarker`
 *   (`publish-spec-grounding-blocker-logic.mts`).
 * @returns `{ postedInline: true }` if every STILL-CLOSING-REFERENCED
 *   blocker was successfully posted as a real inline comment; `{
 *   postedInline: false, degradeReason }` if there was no addable anchor
 *   at all (`"no-addable-anchor"`) or the first inline POST was rejected
 *   with a 422 (`"anchor-rejected-422"`) — the anchor-fallback case,
 *   either structurally or via the probe-then-degrade, the caller
 *   renders the full (still-closing-referenced) blocker detail in the
 *   summary instead either way. `staleBlockerIssueNumbers` is
 *   independent of both — the issue numbers filtered out because the
 *   PR's CURRENT body no longer references them with a closing keyword
 *   at all (removed entirely, or downgraded to a plain reference).
 * @throws Any OTHER failure (a diff-fetch error, a non-first or non-422
 *   inline-posting failure) — a genuine error, not a case this function
 *   degrades from; the caller converts it into a visible fallback, same
 *   as every other artifact/network failure in this entrypoint.
 */
async function tryPostBlockersInline(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  pr: GitHubPullRequestShas,
  criterionBlockers: readonly JoinedCriterionResult[],
  spine: ParsedCriteriaSpine,
  diffTruncationBlocksClosingClaim: boolean,
  runNumber: string,
): Promise<TryPostBlockersInlineResult> {
  const currentReferences = parseLinkedIssueReferences(pr.body ?? "", `${owner}/${repo}`);
  // KIND-AWARE (F1-S9 slice 90.4, PR #95 review round 2): closing-kind
  // only, matching `publishSummary`'s own `currentClosingIssueNumbers` --
  // see this function's own docstring for the downgraded-reference gate
  // bypass this filter (previously presence-only) allowed.
  const currentlyClosingIssueNumbers = new Set(
    currentReferences.filter((reference) => reference.kind === "closing").map((reference) => reference.issueNumber),
  );
  const stillReferencedCriterionBlockers = criterionBlockers.filter((blocker) =>
    currentlyClosingIssueNumbers.has(blocker.issueNumber),
  );
  const stillReferencedUnreviewedClosingIssues = spine.unreviewedClosingIssues.filter((entry) =>
    currentlyClosingIssueNumbers.has(entry.issueNumber),
  );
  const staleBlockerIssueNumbers = [
    ...new Set(
      [...criterionBlockers, ...spine.unreviewedClosingIssues]
        .map((entry) => entry.issueNumber)
        .filter((issueNumber) => !currentlyClosingIssueNumbers.has(issueNumber)),
    ),
  ].sort((a, b) => a - b);

  const diff = await fetchPrDiff(token, owner, repo, pr.base.sha, pr.head.sha);
  const plan = planBlockerInlineComments(
    stillReferencedCriterionBlockers,
    stillReferencedUnreviewedClosingIssues,
    diff,
    diffTruncationBlocksClosingClaim,
    runNumber,
  );
  if (plan.anchorFallbackNeeded) {
    return { postedInline: false, degradeReason: "no-addable-anchor", staleBlockerIssueNumbers };
  }
  const postResult = await postInlineCommentPlan(token, owner, repo, prNumber, pr.head.sha, plan.comments);
  if (!postResult.ok) {
    return { postedInline: false, degradeReason: postResult.reason, staleBlockerIssueNumbers };
  }
  return { postedInline: true, degradeReason: null, staleBlockerIssueNumbers };
}

async function publishSummary(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  trustedHeadSha: string,
  runNumber: string,
  spine: ParsedCriteriaSpine,
  verdict: SpecGroundingVerdict,
): Promise<void> {
  // Validated and canonicalized ONCE, at the very top of this function --
  // BEFORE any posting, patching, or reconciliation is ever attempted
  // (F1-S9 slice 90.4, Codex finding #798: an earlier version of this
  // validation ran only immediately before the reconcile call, AFTER
  // tryPostBlockersInline had already embedded the RAW, unvalidated
  // runNumber into every newly-posted/patched comment's own generation
  // marker -- so a malformed GITHUB_RUN_NUMBER could reach a real write
  // before ever being checked). Explicitly validated here, NOT the bare
  // `Number(requireEnv(...))` this entrypoint uses elsewhere (e.g.
  // `TRUSTED_PR_NUMBER`) without a further check: those callers' own
  // downstream use (an API path segment) turns a corrupted, non-numeric
  // value into `NaN`, which naturally 404s or malformed-URLs into a loud,
  // visible exception -- a safe failure mode this codebase already relies
  // on. THIS numeric conversion is different in a way that matters: a
  // corrupted `GITHUB_RUN_NUMBER` becoming `NaN` would make EVERY
  // `generation > currentGeneration` comparison in
  // `deleteDeReferencedInlineBlockerComments` evaluate to `false` (any
  // comparison against `NaN` is `false`), silently defeating the entire
  // generation-safety guard with NO visible error at all -- the worst
  // possible failure mode for the one check that exists specifically to
  // stop an older run from deleting a newer run's own valid thread.
  // Failing closed here, loudly, before that guard -- or any posting --
  // could ever be reached with an unvalidated value.
  const currentGeneration = Number(runNumber);
  if (!Number.isSafeInteger(currentGeneration) || currentGeneration <= 0) {
    await publishFallback(token, owner, repo, prNumber, [
      `GITHUB_RUN_NUMBER ("${runNumber}") is not a valid positive integer -- refusing to post any ` +
        `generation-marked inline comment or reconcile this run's own de-referenced ones without a ` +
        `trustworthy generation to compare against.`,
    ]);
    process.exitCode = 1;
    return;
  }
  // The CANONICAL form (F1-S9 slice 90.4, Codex finding #798's own
  // "canonicalize" half): used for BOTH posting (embedded in every new
  // comment's own generation marker, via tryPostBlockersInline) and the
  // reconcile call below, so the two can never disagree on what "this
  // run's own generation" means even if the raw env value were somehow
  // non-canonical (e.g. zero-padded) -- GitHub's own `github.run_number`
  // never legitimately is, so this is defense-in-depth, not a functional
  // change in practice.
  const canonicalRunNumber = String(currentGeneration);

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

  // Verified UNCONDITIONALLY, before the blocker-count branch (PR #87
  // review round 7, Codex, medium, fail-open close): an earlier version
  // only fetched/verified the PR's current head SHA INSIDE
  // tryPostBlockersInline, which only ran when totalBlockerCount > 0 --
  // meaning the zero-blocker "no blocking findings" all-clear path never
  // verified anything at all, so a push moving the PR after the read-only
  // review ran could still get a stale all-clear posted for a head this
  // run never actually reviewed. Fetched ONCE here and passed down to
  // `tryPostBlockersInline` (which no longer fetches/verifies itself) so
  // every `hasCriteria: true` publish -- blockers or not -- verifies the
  // trusted head before posting anything.
  let pr: GitHubPullRequestShas;
  try {
    pr = await fetchAndVerifyPrShas(token, owner, repo, prNumber, trustedHeadSha);
  } catch (err) {
    // A genuine SHA mismatch (the PR moved) or a fetch failure -- degrade
    // to the SAME visible fallback every other artifact/network failure
    // in this entrypoint uses, never a stale all-clear or a blocker post
    // for a head this run could not actually verify.
    await publishFallback(token, owner, repo, prNumber, [
      `failed to verify this PR's current head SHA before publishing: ${err instanceof Error ? err.message : String(err)}`,
    ]);
    process.exitCode = 1;
    return;
  }

  // Base-SHA verification, sourced from the SPINE's own reviewedBaseSha,
  // never a workflow-event value (F1-S9 slice 90.2, reordered per the #90
  // PR-plan revision -- corrects a real design bug in the original,
  // standalone 90.1, closed as #92 on Codex cid 3624140965 before it ever
  // merged): the review agent's diff was fetched against
  // `spine.reviewedBaseSha` (the runner's own `pr.base.sha` at the time it
  // called `fetchPrDiff`), which can legitimately differ from `github
  // .event.pull_request.base.sha` if the target branch advanced in the
  // window between the event firing and the runner's own fetch -- an
  // event-sourced comparison would spuriously degrade a verdict validly
  // produced against a base the event never captured. Comparing against
  // the runner-observed value instead means this check only ever fires
  // when the base ACTUALLY advanced between the review and this publish,
  // never on a merely-late-arriving event. Same fail-closed treatment as
  // the head-SHA check just above: this run has no legitimate business
  // publishing (an all-clear OR a blocker) against a base different from
  // the one the verdict was actually produced against.
  if (pr.base.sha !== spine.reviewedBaseSha) {
    await publishFallback(token, owner, repo, prNumber, [
      `this PR's current base SHA (${pr.base.sha}) does not match the base this run's own review actually ` +
        `diffed against (${spine.reviewedBaseSha}) -- the target branch advanced since the review ran; ` +
        `failing closed rather than publishing a verdict produced against a different base.`,
    ]);
    process.exitCode = 1;
    return;
  }

  // This PR's CURRENT closing-kind references, from the SAME
  // already-verified `pr.body` (F1-S9 slice 90.4, redesigned reconcile):
  // computed ONCE here, independent of `tryPostBlockersInline`'s own
  // separate internal re-parse (which needs ALL references, closing or
  // not, for its own unrelated staleness filter) -- a deliberate, cheap
  // second parse of the same body per run, traded for keeping
  // `tryPostBlockersInline` and the reconcile call below fully
  // independent and independently reviewable, rather than threading a
  // shared computation between two otherwise-unrelated mechanisms.
  const currentClosingIssueNumbers = new Set(
    parseLinkedIssueReferences(pr.body ?? "", `${owner}/${repo}`)
      .filter((reference) => reference.kind === "closing")
      .map((reference) => reference.issueNumber),
  );

  let blockersPostedInline = false;
  let degradeReason: InlinePostingDegradeReason | null = null;
  let staleBlockerIssueNumbers: readonly number[] = [];
  if (totalBlockerCount > 0) {
    try {
      const result = await tryPostBlockersInline(
        token,
        owner,
        repo,
        prNumber,
        pr,
        criterionBlockers,
        spine,
        diffTruncationBlocksClosingClaim,
        canonicalRunNumber,
      );
      blockersPostedInline = result.postedInline;
      degradeReason = result.degradeReason;
      staleBlockerIssueNumbers = result.staleBlockerIssueNumbers;
    } catch (err) {
      // A genuine error (a diff-fetch failure, a non-first or non-422
      // inline-posting failure) — NOT the anchor-fallback or 422-degrade
      // case, both of which `tryPostBlockersInline` already resolves to a
      // plain result, never a throw. Same "visible fallback, never a
      // silent or bare-CI-red failure" treatment as every other
      // artifact/network failure in this entrypoint.
      await publishFallback(token, owner, repo, prNumber, [
        `failed to post this run's blocking findings as inline comments: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ]);
      process.exitCode = 1;
      return;
    }
  }

  // Reconciliation (F1-S9 slice 90.4, redesigned per the operator's #801
  // resolution): deletes any bot-owned inline blocker comment whose OWN
  // issue is no longer among `currentClosingIssueNumbers` -- covers both
  // a de-referenced issue (not mentioned at all anymore) and a
  // DOWNGRADED one (still mentioned, but no longer with a closing
  // keyword) -- never a verdict-satisfied one still closing-referenced
  // (a human resolves that class; see `deleteDeReferencedInlineBlockerComments`'s
  // own docstring for the full reasoning). Runs UNCONDITIONALLY, on
  // every `hasCriteria: true` publish (team-lead's Fork-1 ruling, this
  // slice): unlike the prior, reverted verdict-keep-set design, this
  // mechanism's own membership test depends ONLY on
  // `currentClosingIssueNumbers` (the CURRENT, already-verified body) and
  // each comment's own generation -- NEITHER of which is affected by
  // whether THIS run's own new blockers happened to post inline
  // successfully, so there is nothing left to gate on.
  //
  // FAIL CLOSED on a snapshot mismatch, not merely a non-destructive skip
  // (F1-S9 slice 90.4, PR #95 review round 4, Codex, P1, cid 3625635480 --
  // round 3's own fix only skipped THIS delete and logged, then fell
  // through to build and post the summary anyway. That summary's own
  // `blockersPostedInline`/`staleBlockerIssueNumbers` were computed by
  // `tryPostBlockersInline` against the SAME now-stale
  // `currentClosingIssueNumbers` snapshot -- so a `Refs #N` upgraded to
  // `Closes #N` mid-run would have this job exit 0 with a clean-looking
  // summary while #N's own blocker was never actually posted inline at
  // all (the posting-time filter still saw it as non-closing). The
  // mismatch means BOTH this run's own posting decisions AND this
  // delete are stale, so the caller now treats it as a single fail-closed
  // signal covering both -- no stale delete AND no stale summary --
  // rather than trying to partially salvage a summary this run can no
  // longer vouch for. `deleteDeReferencedInlineBlockerComments`'s own
  // re-verify (after its own comment pagination, immediately before its
  // first DELETE call -- see that function's own docstring, cid
  // 3625635476) is what actually detects the mismatch; this is purely
  // the caller's own response to that signal.
  try {
    const reconcileResult = await deleteDeReferencedInlineBlockerComments(
      token,
      owner,
      repo,
      prNumber,
      currentClosingIssueNumbers,
      currentGeneration,
    );
    if (!reconcileResult.ok) {
      await publishFallback(token, owner, repo, prNumber, [
        `this PR's linked-issue closing references changed since this run's own earlier snapshot was ` +
          `taken -- the blocker posting/skip decisions computed against that snapshot may now be ` +
          `stale; failing closed rather than publishing a summary this run can no longer vouch for. A ` +
          `fresh spec-grounded review run will re-evaluate against the PR's current state.`,
      ]);
      process.exitCode = 1;
      return;
    }
  } catch (err) {
    // Same "visible fallback, never silent" treatment as every other
    // artifact/network failure in this entrypoint.
    await publishFallback(token, owner, repo, prNumber, [
      `failed to reconcile this run's own de-referenced inline blocker comments: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    ]);
    process.exitCode = 1;
    return;
  }

  let body = buildSpecGroundingSummaryCommentBody(
    joined,
    spine.unreviewedClosingIssues,
    { truncated: spine.truncated, diffTruncated: spine.diffTruncated },
    blockersPostedInline,
    degradeReason,
    staleBlockerIssueNumbers,
  );
  if (totalBlockerCount > 0 && !blockersPostedInline) {
    body += "\n" + buildAnchorFallbackSummarySupplement(
      criterionBlockers,
      spine.unreviewedClosingIssues,
      diffTruncationBlocksClosingClaim,
      // Always non-null here by tryPostBlockersInline's own contract
      // (populated on every `postedInline: false` result) -- the
      // fallback is defensive only, never expected to actually apply.
      degradeReason ?? "no-addable-anchor",
    );
  }
  if (staleBlockerIssueNumbers.length > 0) {
    body += "\n" + buildStaleBlockerSkippedNote(staleBlockerIssueNumbers);
  }

  await upsertSummaryComment(token, owner, repo, prNumber, body);
  console.log(
    `Published spec-grounded review summary for PR #${prNumber}: ${totalBlockerCount} blocking ` +
      `finding(s) (postedInline=${blockersPostedInline}), ${joined.length} criterion(a) reviewed, ` +
      `${staleBlockerIssueNumbers.length} stale blocker(s) skipped.`,
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
