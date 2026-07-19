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
 * The patch-path guard is APPLIER-AUTHORITATIVE, not a re-parse — and it
 * took THREE rounds of finding a new diff-text-encoding variant to reach
 * the current, CATEGORICALLY complete design, all documented here because
 * the lesson (don't re-derive what git will do; ask it) applies to any
 * future change to this guard:
 *
 * 1. Parsing a `diff --git a/X b/Y` header directly and stripping a
 *    literal `a/`/`b/` prefix is exploitable: `git apply`'s default `-p1`
 *    strips whatever the header's first path segment actually IS, not
 *    specifically `a`/`b` — so `diff --git zz/.github/workflows/evil.yml
 *    zz/.github/workflows/evil.yml` parses as the harmless
 *    `zz/.github/workflows/evil.yml` under that logic, while the SAME
 *    `git apply` strips `zz/` and writes to the *actually protected*
 *    `.github/workflows/evil.yml`. Fixed by asking `git apply --numstat`
 *    what it would actually touch, with the identical invocation used to
 *    apply it for real.
 * 2. `--numstat` only reports a rename/copy's DESTINATION, not its
 *    source, so a rename/copy OUT of a protected path was invisible to
 *    it. The first fix for THAT scanned `git apply --summary`'s text for
 *    a protected-path substring — itself exploitable, since `--summary`
 *    brace-compacts a shared prefix (`rename scripts/{factory/x.mts =>
 *    other/y.mts} (100%)`) so the literal substring `scripts/factory/`
 *    is never present for exactly the case being checked. Fixed by
 *    reading the raw patch text's `rename from`/`rename to`/`copy from`/
 *    `copy to` lines directly instead.
 * 3. Those lines are themselves C-style-quotable (Codex round-4 finding):
 *    a `copy from "scripts/factory/publish-implement-patch.mts"` line's
 *    naive `.slice(prefix.length)` keeps the leading `"`, so the
 *    resulting string never matches a protected-path prefix — the
 *    checker was reading the raw byte sequence git WROTE into the diff,
 *    not the PATH git meant, and every one of these three fixes was
 *    trying to re-implement a piece of git's own diff-serialization
 *    format from the outside.
 *
 * The categorical fix (this version): rather than parse diff TEXT in any
 * form, apply the patch to a THROWAWAY scratch git index and ask git
 * `diff-index` what actually changed — see
 * {@link getAuthoritativePatchAnalysis}'s docstring. This is definitionally
 * complete: it's git's own tree comparison, not a re-implementation of
 * git's diff-serialization or quoting rules, so there is no fourth
 * text-encoding variant to eventually find.
 *
 * 4. F1-S9 slice 1 (issue #12), round 3 — the SAME lesson, applied to the
 *    anti-gaming content classifier: an earlier version scanned the
 *    AGENT'S OWN raw patch bytes for coverage-suppression comments, which
 *    is exactly the "re-parse attacker-controlled text" mistake fixes 1-3
 *    above already closed for path detection. A `.gitattributes` change
 *    (part of the same patch) marking a source file binary, combined
 *    with delivering the real change via a `GIT binary patch` block
 *    instead of textual `+`/`-` lines, hides a suppression comment from a
 *    scan of the RAW patch entirely, even though the file's actual
 *    content (once applied) is ordinary readable source. Fixed the same
 *    way: {@link getAuthoritativePatchAnalysis} additionally asks git to
 *    REGENERATE the diff from the scratch index (`git diff --cached
 *    --text`, forcing textual output regardless of any attribute/
 *    heuristic-driven binary classification) rather than trusting the
 *    patch's own bytes for content scanning either.
 *
 * Exactly one outcome, always: either the patch is valid and a PR is
 * opened/refreshed, or it isn't and a single explanatory comment is posted
 * on the issue. Every git/API operation happens inside one `main()` so
 * there is exactly one place a comment gets posted, instead of
 * coordinating comment-avoidance across several workflow steps and their
 * `if:` conditions.
 *
 * Required environment variables:
 * - `GH_TOKEN` — the identity that pushes the branch and opens/comments on
 *   the PR/issue. Defaults to the job's own `permissions: contents: write,
 *   pull-requests: write, issues: write` `GITHUB_TOKEN`, but the workflow
 *   may instead pass a short-lived token minted for a dedicated GitHub App
 *   (factory.md §13's publisher-identity switch, operator decision 18 Jul
 *   2026 — a minted App installation token, not a standing PAT) —
 *   GitHub suppresses downstream workflow triggers (CI, Codex, Claude Code
 *   Review) for `GITHUB_TOKEN`-authored PR events, so a factory PR needs a
 *   real, workflow-triggering identity to actually get reviewed. This
 *   script itself is identity-agnostic: it just uses whatever token the
 *   workflow hands it.
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
 *
 * Optional environment variables:
 * - `IMPLEMENT_AGENT_ACTION_REF` — the pinned `claude-code-action@<sha>`
 *   the implement job ran, for the PR body's minimal provenance section.
 *   Soft-defaulted (not `requireEnv`'d) if unset — provenance metadata
 *   only, never grounds to reject an otherwise-valid publish.
 * - `IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN` — the exact login
 *   {@link findExistingImplementFailureCommentId} treats as "our own prior
 *   comment" when deciding whether to PATCH or POST a failure comment.
 *   Soft-defaulted to `IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN` (the
 *   built-in `github-actions[bot]` identity) if unset. Must match whatever
 *   identity `GH_TOKEN` actually authenticates as — if `GH_TOKEN` is a
 *   minted App token and this is left at the GITHUB_TOKEN default, a
 *   re-dispatch's failure comment won't find its own prior one and will
 *   post a duplicate rather than editing it (a functional annoyance, not
 *   a security issue — the spoofing guard this login check exists for
 *   still holds either way). The workflow derives this automatically from
 *   the App token mint step's own `app-slug` output when a token was
 *   minted, so this rarely needs manual attention in practice.
 * - `PUBLISHED_VIA_FALLBACK` — `"true"` when `GH_TOKEN` above is the
 *   `GITHUB_TOKEN` fallback rather than a minted factory App token. Drives
 *   the PR body's bold fallback warning and the `no-review-automation`
 *   label (adjudicated F2, #40 rework) — soft-defaulted to `false` if
 *   unset, which only means the warning is skipped, never that an
 *   otherwise-valid publish is blocked.
 * - `FALLBACK_REASON` — human-readable, best-effort explanation of WHY
 *   `PUBLISHED_VIA_FALLBACK` is true (e.g. "FACTORY_PUBLISHER_APP_ID is
 *   not configured" vs "the mint step failed"), for the
 *   `$GITHUB_STEP_SUMMARY` block (observability fix, 18 Jul 2026 —
 *   see {@link writeStepSummary}). Soft-defaulted to `undefined`
 *   (omitted from the summary) if unset; purely informational.
 * - `IMPLEMENT_TRANSCRIPT_PATH` — path to the downloaded implement-agent
 *   transcript artifact (F1-S10 slice 3, factory.md §13.12's provenance
 *   trailer). May legitimately not exist (best-effort artifact download,
 *   same as `PATCH_PATH`) — a missing/unreadable/unparseable transcript
 *   degrades the trailer's model-ID field to "unavailable", never blocks
 *   an otherwise-valid publish. Soft-defaulted to
 *   `transcript-output/claude-execution-output.json` if unset.
 * - `IMPLEMENT_PROMPT_VERSION` — stands in for a prompt/skill version;
 *   see {@link ProvenanceContext.promptVersion}'s doc for why this is the
 *   repository commit SHA rather than a named skill version. Soft-
 *   defaulted to a clearly-labeled "unknown" if unset.
 * - `DISPATCH_ACTOR` — the human who authorized THIS attempt
 *   (`github.triggering_actor`, not `github.actor` — see
 *   {@link ProvenanceContext.dispatchActor}'s doc). Soft-defaulted to a
 *   clearly-labeled placeholder if unset.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { appendFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubRequest, requireEnv } from "./github-api.mts";
import {
  assertLabelDescriptionWithinLimit,
  buildCommitTrailer,
  buildFallbackRefreshCommentBody,
  buildGamingFlagAnnotation,
  buildImplementFailureCommentBody,
  buildImplementPrBody,
  buildPublishRejectedStepSummary,
  buildPublishSuccessStepSummary,
  deriveBranchName,
  extractModelIdFromTranscript,
  FACTORY_PR_BASE_REF,
  findAddedCoverageSuppressions,
  findExistingImplementFailureCommentId,
  findForbiddenPatchPaths,
  findPrForIssueNumber,
  findTestFileEdits,
  GITHUB_LABEL_DESCRIPTION_MAX_LENGTH,
  IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN,
  isLabelAlreadyExistsError,
  NO_AUTO_CHAIN_LABEL,
  NO_AUTO_CHAIN_LABEL_DESCRIPTION,
  NO_REVIEW_AUTOMATION_LABEL,
  NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION,
  parseNameStatusZ,
  type ExistingComment,
  type GamingFlag,
  type ProvenanceContext,
  type PublishStepSummaryContext,
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

interface GitHubComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly type: string; readonly login: string } | null;
}

interface GitHubPullRequestApi {
  readonly html_url: string;
  readonly number: number;
  readonly head: {
    readonly ref: string;
    // `null` when the source repo (e.g. a fork) has since been deleted —
    // the GitHub API's own documented shape for that case.
    readonly repo: { readonly full_name: string } | null;
  };
  readonly base: { readonly ref: string };
}

/** Page size for listing open PRs — GitHub's own per-page maximum. */
const PR_PAGE_SIZE = 100;
/**
 * Upper bound on how many pages of open PRs to scan looking for this
 * issue's existing PR (~5,000 open PRs) — pathologically high for this
 * repo, but a sane cap against an unbounded loop rather than trusting the
 * API to always terminate cleanly. Same shape as
 * `apply-triage-verdict.mts`'s `MAX_COMMENT_PAGES`.
 */
const MAX_PR_PAGES = 50;

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

/** What {@link getAuthoritativePatchAnalysis} reports about a patch. */
interface AuthoritativePatchAnalysis {
  /** Every path git itself reports as touched, both sides of every rename/copy. */
  readonly changedPaths: string[];
  /**
   * A git-REGENERATED, `--text`-forced diff of the same scratch tree —
   * authoritative content for the anti-gaming classifier
   * ({@link findAddedCoverageSuppressions}) to scan, never the agent's
   * own raw patch bytes. See this function's own docstring, point 3.
   */
  readonly diffText: string;
}

/**
 * Asks git itself what a patch touches and contains, via a THROWAWAY
 * scratch git index — never the repo's real index or working tree, and
 * never a re-parse of the diff TEXT git DIDN'T generate itself (see the
 * file-top comment for the three-plus-one rounds of diff-text-parsing
 * exploits this categorically replaces).
 *
 * Mechanism, each step run with `GIT_INDEX_FILE` pointed at a fresh
 * temp-file index (never the real `.git/index`, so none of this touches
 * the repo's actual staged state):
 * 1. `git read-tree HEAD` — seeds the scratch index with the CURRENT
 *    HEAD's tree, so a patch that MODIFIES an existing tracked file has
 *    a base to apply against (an empty index can only accept brand-new
 *    files).
 * 2. `git apply --cached <patch>` — applies the patch to that scratch
 *    index only. `--cached` never touches the working tree. If this
 *    fails, the patch is malformed/inapplicable — same fail-closed
 *    outcome the old `--numstat` failure produced.
 * 3. `git diff-index --cached --name-status -z -M -C --find-copies-harder
 *    HEAD` — asks git which PATHS differ between HEAD and the
 *    now-patched scratch index. This is git's own TREE comparison, not a
 *    diff-format re-serialization the patch's own text could ever
 *    influence the wording of — there is no quoting, no prefix-stripping
 *    interpretation, and no brace-compaction to get right or wrong,
 *    because nothing here is parsing text git wrote for human/patch
 *    consumption; it's git comparing two trees it already holds and
 *    reporting the result in its own `-z` (NUL-delimited, unquoted)
 *    machine format. {@link parseNameStatusZ} parses that format.
 * 4. `git diff --cached --text -M -C --find-copies-harder HEAD` — asks
 *    git for the same tree comparison's CONTENT, git-regenerated rather
 *    than the agent's own patch bytes (F1-S9 slice 1, issue #12, round 3
 *    — independent Codex + claude-review finding: the agent's raw patch
 *    could mark a file binary via `.gitattributes` and deliver a real
 *    text change through a `GIT binary patch` block, hiding it from any
 *    scan of the agent's own bytes). `--text` forces git to render every
 *    file's diff as ordinary `+`/`-` lines regardless of any attribute-
 *    or heuristic-driven binary classification, so a coverage-suppression
 *    comment delivered via that trick still appears as scannable content
 *    in THIS regenerated diff even though it never did in the raw patch.
 *
 * `-M` (rename detection) and `-C --find-copies-harder` (copy detection,
 * including against files the patch left otherwise UNTOUCHED — the exact
 * shape of Codex's round-4 quoted-`copy from` exploit, where the copy's
 * SOURCE file has zero other changes in the patch) together guarantee
 * BOTH sides of every rename/copy are reported. Empirically verified
 * (scratch repo): `-C` alone, without `--find-copies-harder`, misses a
 * copy whose source is otherwise unmodified — `--find-copies-harder`
 * closes that. Verified negligible cost at this repo's current size
 * (~49 tracked files, ~10ms) — `--find-copies-harder`'s cost scales with
 * repo size, not patch size, so revisit if the repo grows enormously.
 *
 * Even WITHOUT rename/copy detection at all, a rename's two sides would
 * still both be reported here (as a plain delete + add, rather than an
 * `R<score>` pair) — `-M`/`-C` change the STATUS LABEL, not whether both
 * paths appear, since both `diff-index`/`diff` are comparing trees
 * regardless.
 *
 * @param patchPath - Path to the patch file.
 * @returns Every path git itself reports as touched (both sides of every
 *   rename/copy), plus the git-regenerated, text-forced diff content.
 * @throws {PublishRejection} If the patch can't be applied to the scratch
 *   index at all (malformed, unreadable, or genuinely empty), or if
 *   either authoritative query against the applied scratch index fails.
 */
async function getAuthoritativePatchAnalysis(
  patchPath: string,
): Promise<AuthoritativePatchAnalysis> {
  const scratchDir = await mkdtemp(join(tmpdir(), "publish-guard-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratchDir, "index") };
    try {
      execFileSync("git", ["read-tree", "HEAD"], { env, stdio: "pipe" });
    } catch (err) {
      // Not independently exercised by a unit test: every test fixture in
      // this repo's suite runs against a checkout with a real commit
      // (`writeInitialCommit`), matching the publish job's real
      // precondition — its own checkout always has HEAD resolvable. Kept
      // as a defensive fail-closed branch (an unexpected, broken
      // repository state must never proceed to apply a patch) rather
      // than assumed unreachable.
      throw new PublishRejection(
        `could not seed a scratch index from HEAD (unexpected repository ` +
          `state): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      execFileSync("git", ["apply", "--cached", patchPath], {
        env,
        stdio: "pipe",
      });
    } catch (err) {
      throw new PublishRejection(
        `patch could not be applied to a scratch index (malformed or ` +
          `unreadable patch): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let nameStatusOutput: string;
    try {
      nameStatusOutput = execFileSync(
        "git",
        [
          "diff-index",
          "--cached",
          "--name-status",
          "-z",
          "-M",
          "-C",
          "--find-copies-harder",
          "HEAD",
        ],
        { env, encoding: "utf8" },
      );
    } catch (err) {
      // Not independently exercised by a unit test: if the preceding
      // read-tree and apply steps both succeeded, HEAD and the scratch
      // index are both in a state where this diff-index call has never
      // been observed to fail. Kept defensively regardless — same
      // reasoning as the read-tree catch above.
      throw new PublishRejection(
        `could not read the scratch index's changed paths: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let diffText: string;
    try {
      diffText = execFileSync(
        "git",
        [
          "diff",
          "--cached",
          "--text",
          "--no-color",
          "-M",
          "-C",
          "--find-copies-harder",
          "HEAD",
        ],
        { env, encoding: "utf8" },
      );
    } catch (err) {
      // Not independently exercised by a unit test: same reasoning as the
      // diff-index catch above — this queries the identical, already-
      // proven-valid scratch index, just asking for content instead of
      // names.
      throw new PublishRejection(
        `could not read the scratch index's authoritative diff content: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { changedPaths: parseNameStatusZ(nameStatusOutput), diffText };
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
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
 * `-p` override) as `getAuthoritativePatchAnalysis` used to check it.
 *
 * The commit message carries the F1-S10 slice-3 provenance trailer (see
 * {@link buildCommitTrailer}) on EVERY commit this function makes —
 * including a re-dispatch's force-pushed refresh, unlike the PR body's
 * own Provenance section (creation-time only).
 */
function applyPatchAndPush(
  branchName: string,
  patchPath: string,
  issueNumber: number,
  issueTitle: string,
  agentActionRef: string,
  provenance: ProvenanceContext,
): void {
  runGit(["config", "user.name", "github-actions[bot]"]);
  runGit([
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
  runGit(["checkout", "-B", branchName]);
  runGit(["apply", patchPath]);
  // FIX (Codex round 3, P2, corrected by a live-dispatch-test finding —
  // fix-forward off main): this job's own checkout has
  // `patch-output/patch.diff` sitting on disk right now (the "Download
  // patch artifact" step wrote it there before this ever runs) — an
  // ordinary `git add -A` with nothing done about it would stage that
  // raw patch-diff artifact if a patch ALSO edited .gitignore to
  // un-ignore /patch-output (nothing stops a patch from touching
  // .gitignore; it isn't a protected path), committing it into the
  // factory PR.
  //
  // The original fix here used the SAME pathspec-exclude form as the
  // implement job's capture step (`git add -A -- ':!issue-context'
  // ':!patch-output'`) — that form FAILED on the real runner for the
  // identical reason documented at the capture step in
  // implement-ready-issues.yml: `git add` refuses (exit 1) when a
  // pathspec NAMES a path this repo's own committed `.gitignore` already
  // ignores, even as an EXCLUDE. Fixed the same way: physically remove
  // the scratch directories from disk before staging, rather than
  // naming them in a pathspec. `patch-output/` is removed AFTER `apply`
  // above (nothing past this point needs the on-disk patch file
  // anymore) and BEFORE the `git add -A` below. `issue-context/` never
  // actually exists in THIS job's checkout (the implement and publish
  // jobs run in separate workspaces) — removing it here is harmless
  // defense-in-depth, not the applicable half of this fix, exactly as
  // before.
  rmSync("patch-output", { recursive: true, force: true });
  rmSync("issue-context", { recursive: true, force: true });
  // Same reasoning as patch-output/issue-context above: the "Download
  // implement agent transcript artifact" step (best-effort, for the
  // provenance trailer's model-ID field) writes into this job's checkout
  // too, before this ever runs, and nothing stops a patch from touching
  // .gitignore to un-ignore it.
  rmSync("transcript-output", { recursive: true, force: true });
  runGit(["add", "-A"]);
  const commitTitle = `Implement #${issueNumber}: ${issueTitle}`.slice(
    0,
    120,
  );
  const trailer = buildCommitTrailer({
    issueNumber,
    agentActionRef,
    ...provenance,
  });
  runGit([
    "commit",
    "-m",
    commitTitle,
    "-m",
    `Closes #${issueNumber}`,
    "-m",
    trailer,
  ]);
  runGit(["push", "--force", "origin", branchName]);
}

/**
 * Finds the existing open PR for this issue, if any — see
 * `findPrForIssueNumber`'s docstring for why this keys off the issue
 * number (a stable `feature/{issueNumber}-` branch prefix) rather than
 * the exact branch name a fresh `deriveBranchName` call would produce
 * from today's title, AND why it's additionally scoped to PRs whose head
 * branch lives in this repo (never a fork's, which `headRepoFullName`
 * lets it reject even when the branch name coincidentally matches).
 *
 * Paginates through every page of open PRs (Codex round-7 finding) rather
 * than only the first 100 — a repo with more open PRs than that could
 * otherwise have this issue's existing PR missed on a later page, causing
 * a duplicate PR (or a force-push to a freshly-derived branch name that
 * collides with nothing, orphaning the real existing PR).
 */
async function findExistingPrForIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<PullRequestSummary | null> {
  const expectedHeadRepoFullName = `${owner}/${repo}`;
  const summaries: PullRequestSummary[] = [];
  for (let page = 1; page <= MAX_PR_PAGES; page++) {
    const results = await githubRequest<GitHubPullRequestApi[]>(
      token,
      "GET",
      `/repos/${owner}/${repo}/pulls?state=open&per_page=${PR_PAGE_SIZE}&page=${page}`,
    );
    for (const pr of results) {
      summaries.push({
        number: pr.number,
        headRef: pr.head.ref,
        headRepoFullName: pr.head.repo?.full_name ?? null,
        baseRef: pr.base.ref,
      });
    }
    if (results.length < PR_PAGE_SIZE) {
      break; // Last page.
    }
    if (page === MAX_PR_PAGES) {
      console.warn(
        `Scanned ${MAX_PR_PAGES} pages of open PRs without exhausting the ` +
          `list; searching only what was fetched rather than looping ` +
          `unboundedly.`,
      );
    }
  }
  return findPrForIssueNumber(summaries, issueNumber, expectedHeadRepoFullName);
}

/** Page size for listing issue comments — GitHub's own per-page maximum. */
const COMMENT_PAGE_SIZE = 100;
/**
 * Upper bound on how many comment pages to scan looking for a prior
 * implement-failure comment (~5,000 comments) — pathologically high for a
 * factory issue, but a sane cap against an unbounded loop rather than
 * trusting the API to always terminate cleanly. Same shape as
 * `apply-triage-verdict.mts`'s `MAX_COMMENT_PAGES`.
 */
const MAX_COMMENT_PAGES = 50;

/**
 * Finds this job's own prior implement-failure comment on this issue, if
 * any, paginating through every page of comments rather than only the
 * first.
 */
async function findExistingImplementFailureComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  authorLogin: string,
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
    const found = findExistingImplementFailureCommentId(existing, authorLogin);
    if (found !== null) {
      return found;
    }
    if (comments.length < COMMENT_PAGE_SIZE) {
      return null; // Last page: no more comments to check.
    }
  }
  console.warn(
    `Scanned ${MAX_COMMENT_PAGES} pages of comments on #${issueNumber} ` +
      `without finding a prior implement-failure comment; posting a new ` +
      `one rather than risking missing a marker beyond this page limit.`,
  );
  return null;
}

/**
 * Posts (or, on a re-dispatch, edits) the implement-failure comment.
 *
 * FIX (Codex round 3, P2, factory.md §13.8): previously always POSTed a
 * fresh comment, so a re-dispatch that fails again for the same issue
 * stacked a new duplicate comment every time instead of updating the
 * existing one — exactly the idempotency gap `apply-triage-verdict.mts`'s
 * `upsertComment` already closed for the triage pipeline's own comment.
 * Same upsert shape here: find by marker (paginated), PATCH if found,
 * POST otherwise.
 */
async function postFailureComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  reasons: readonly string[],
  runUrl: string,
  branchPushed: boolean,
  failureCommentAuthorLogin: string,
): Promise<void> {
  const body = buildImplementFailureCommentBody(reasons, runUrl, branchPushed);
  const existingId = await findExistingImplementFailureComment(
    token,
    owner,
    repo,
    issueNumber,
    failureCommentAuthorLogin,
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
 * Applies {@link NO_REVIEW_AUTOMATION_LABEL} to a newly-opened PR
 * (adjudicated F2, #40 rework) — the second, always-visible-in-list-view
 * half of the fallback signal `buildImplementPrBody`'s warning banner
 * provides in the PR body.
 *
 * The GitHub REST API's "Add labels to an issue" endpoint requires the
 * label to already exist on the repo (unlike some label-taxonomy tools,
 * it does NOT auto-create an unknown label name) — so this first
 * idempotently ensures the label exists (`POST .../labels`, tolerating
 * ONLY the specific "already exists" 422 as success — see
 * {@link isLabelAlreadyExistsError}), then applies it to the PR.
 *
 * Scope note: only ever called on the PR-CREATION path, not on a
 * re-dispatch that refreshes an existing PR — matching
 * `buildImplementPrBody`'s own scope (the body is likewise only built at
 * creation time, never re-PATCHed on refresh). A PR whose fallback status
 * *changes* between the create and a later refresh (e.g. the operator
 * finishes provisioning the factory App mid-flight) can end up with a
 * stale label/body — an accepted, narrow gap for this thin fold, not a
 * claim that refresh keeps this in sync.
 *
 * @param token - The publish job's own bearer token.
 * @param owner - The repo owner.
 * @param repo - The repo name.
 * @param prNumber - The newly-created PR's number (PRs share the Issues
 *   API's label endpoints).
 */
async function applyNoReviewAutomationLabel(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  // Defensive, not expected to ever fire in practice against the fixed
  // NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION literal — but if a future edit
  // ever lengthened it past GitHub's limit, this fails here with a clear
  // message instead of a cryptic 422 from GitHub two lines down.
  assertLabelDescriptionWithinLimit(
    NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION,
    GITHUB_LABEL_DESCRIPTION_MAX_LENGTH,
  );
  try {
    await githubRequest(token, "POST", `/repos/${owner}/${repo}/labels`, {
      name: NO_REVIEW_AUTOMATION_LABEL,
      color: "b60205",
      description: NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION,
    });
  } catch (err) {
    if (!isLabelAlreadyExistsError(err)) {
      throw err; // A real validation error must surface, not be swallowed.
    }
  }
  await githubRequest(token, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
    labels: [NO_REVIEW_AUTOMATION_LABEL],
  });
}

/**
 * Applies {@link NO_REVIEW_AUTOMATION_LABEL} to `prNumber`, never
 * throwing — a failure is logged, not propagated, since by the time this
 * runs the PR/branch itself is already the load-bearing artifact (its
 * body warning, on the creation path, or the fallback-refresh comment
 * `postFallbackRefreshComment` posts alongside this on the refresh path).
 * Shared by both the PR-creation and existing-PR-refresh publish paths
 * (Codex round-3 P2, #40 rework) so the label logic — and its "never
 * fail the publish over a label" tolerance — isn't duplicated between
 * them.
 *
 * @param token - The publish job's own bearer token.
 * @param owner - The repo owner.
 * @param repo - The repo name.
 * @param prNumber - The PR to label (newly-created or pre-existing).
 * @param context - Human-readable context for the log line if this fails
 *   — which publish path called it.
 * @returns `true` if the label was actually applied, `false` if it
 *   failed (logged either way). Adjudicated fix (Codex P2, #46 reshape):
 *   this is best-effort and CAN fail, so a caller that reports "the label
 *   was applied" in a PR-visible or human-facing surface (e.g.
 *   `$GITHUB_STEP_SUMMARY`) must check this rather than assuming success
 *   — a swallowed failure here must never silently become an overstated
 *   claim elsewhere.
 */
async function applyNoReviewAutomationLabelBestEffort(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  context: "opened" | "refreshed",
): Promise<boolean> {
  return applyNoReviewAutomationLabel(token, owner, repo, prNumber).then(
    () => true,
    (err: unknown) => {
      console.error(
        `Failed to apply the ${NO_REVIEW_AUTOMATION_LABEL} label to PR #${prNumber} ` +
          `(${context} via the GITHUB_TOKEN fallback; the PR/branch itself is unaffected): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    },
  );
}

/**
 * Posts a fresh comment on `prNumber` noting this refresh went out via the
 * `GITHUB_TOKEN` fallback (Codex round-3 P2, #40 rework — see
 * {@link buildFallbackRefreshCommentBody}'s docstring for why this is the
 * REFRESH path's counterpart to the PR-creation path's body warning, and
 * why it's a fresh POST rather than an upsert). Never throws — a failure
 * is logged, not propagated; the label
 * (`applyNoReviewAutomationLabelBestEffort`) is the persistent signal that
 * survives even if this specific comment fails to post.
 *
 * @param token - The publish job's own bearer token.
 * @param owner - The repo owner.
 * @param repo - The repo name.
 * @param prNumber - The existing PR being refreshed.
 * @param runUrl - Link to this implement run, for the comment body.
 */
async function postFallbackRefreshComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  runUrl: string,
): Promise<void> {
  await githubRequest(token, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    body: buildFallbackRefreshCommentBody(runUrl),
  }).catch((err: unknown) => {
    console.error(
      `Failed to post the fallback-refresh comment on PR #${prNumber} (the branch was ` +
        `still refreshed successfully): ${err instanceof Error ? err.message : String(err)}`,
    );
  });
}

/**
 * Ensures {@link NO_AUTO_CHAIN_LABEL} exists (idempotently, same
 * tolerate-only-the-genuine-already-exists-422 pattern as
 * `applyNoReviewAutomationLabel`) and applies it to `prNumber` — F1-S9
 * slice 1 (issue #12): the durable, always-visible signal that this
 * diff's own content (not the publisher identity) tripped the
 * deterministic anti-gaming classifier.
 *
 * @param token - The publish job's own bearer token.
 * @param owner - The repo owner.
 * @param repo - The repo name.
 * @param prNumber - The PR to label (newly-created or pre-existing).
 */
async function applyNoAutoChainLabel(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  assertLabelDescriptionWithinLimit(
    NO_AUTO_CHAIN_LABEL_DESCRIPTION,
    GITHUB_LABEL_DESCRIPTION_MAX_LENGTH,
  );
  try {
    await githubRequest(token, "POST", `/repos/${owner}/${repo}/labels`, {
      name: NO_AUTO_CHAIN_LABEL,
      color: "d93f0b",
      description: NO_AUTO_CHAIN_LABEL_DESCRIPTION,
    });
  } catch (err) {
    if (!isLabelAlreadyExistsError(err)) {
      throw err; // A real validation error must surface, not be swallowed.
    }
  }
  await githubRequest(token, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
    labels: [NO_AUTO_CHAIN_LABEL],
  });
}

/**
 * Applies {@link NO_AUTO_CHAIN_LABEL} to `prNumber`, never throwing — same
 * best-effort shape as `applyNoReviewAutomationLabelBestEffort`: by the
 * time this runs the PR/branch itself is already the load-bearing
 * artifact, and the annotation comment (`postGamingFlagAnnotation`) is a
 * second, independent signal that survives even if the label call fails.
 *
 * @param token - The publish job's own bearer token.
 * @param owner - The repo owner.
 * @param repo - The repo name.
 * @param prNumber - The PR to label (newly-created or pre-existing).
 * @param context - Human-readable context for the log line if this fails.
 * @returns `true` if the label was actually applied, `false` if it failed
 *   (logged either way) — the caller must reflect this in the step
 *   summary, never overstate success (same discipline as
 *   `applyNoReviewAutomationLabelBestEffort`).
 */
async function applyNoAutoChainLabelBestEffort(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  context: "opened" | "refreshed",
): Promise<boolean> {
  return applyNoAutoChainLabel(token, owner, repo, prNumber).then(
    () => true,
    (err: unknown) => {
      console.error(
        `Failed to apply the ${NO_AUTO_CHAIN_LABEL} label to PR #${prNumber} ` +
          `(${context}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    },
  );
}

/**
 * Posts the deterministic, templated annotation naming exactly what
 * tripped the anti-gaming classifier (F1-S9 slice 1, issue #12) — see
 * {@link buildGamingFlagAnnotation}'s docstring for why this is always a
 * FRESH comment, never an upsert, on both the PR-creation and PR-refresh
 * paths alike. Never throws — a failure is logged, not propagated; the
 * label ({@link applyNoAutoChainLabelBestEffort}) is a SEPARATE, best-effort
 * signal, not a fallback for this one — both are tracked and reported
 * independently (Codex + claude-review finding, F1-S9 slice 1, issue #12,
 * round 3): an earlier version's step-summary line unconditionally
 * pointed the operator at "the PR's annotation comment" even when THIS
 * call had failed and no such comment existed to look at.
 *
 * @param token - The publish job's own bearer token.
 * @param owner - The repo owner.
 * @param repo - The repo name.
 * @param prNumber - The PR (newly-created or pre-existing) to comment on.
 * @param flag - What the classifier found.
 * @param labelApplied - Whether the label call succeeded, threaded into
 *   the annotation body's own wording — see
 *   {@link buildGamingFlagAnnotation}.
 * @returns `true` if the comment was actually posted, `false` if it
 *   failed (logged either way) — the caller must reflect this in the
 *   step summary, never overstate success.
 */
async function postGamingFlagAnnotation(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  flag: GamingFlag,
  labelApplied: boolean,
): Promise<boolean> {
  return githubRequest(token, "POST", `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    body: buildGamingFlagAnnotation(flag, labelApplied),
  }).then(
    () => true,
    (err: unknown) => {
      console.error(
        `Failed to post the anti-gaming annotation comment on PR #${prNumber} (the ` +
          `${NO_AUTO_CHAIN_LABEL} label was still applied if that call succeeded): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    },
  );
}

/**
 * Appends `markdown` to `$GITHUB_STEP_SUMMARY` (observability fix, 18 Jul
 * 2026, live App-identity commissioning: a mint failure shows
 * `conclusion=success` in the job view — `continue-on-error` masks it —
 * so a human had to pull raw job logs to find the real outcome; this puts
 * mint-vs-fallback, the PR, and whether review automation triggered
 * directly in the run's own summary instead).
 *
 * Never throws: `GITHUB_STEP_SUMMARY` is unset outside a real GitHub
 * Actions run (every unit/integration test in this repo, and a local
 * `node publish-implement-patch.mts` invocation), and even inside one, a
 * write failure here is observability-only — it must never take down an
 * otherwise-successful (or otherwise-correctly-rejected) publish.
 *
 * @param markdown - The summary block to append.
 */
function writeStepSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  try {
    appendFileSync(summaryPath, markdown);
  } catch (err) {
    console.error(
      `Failed to write $GITHUB_STEP_SUMMARY (observability only, publish itself is ` +
        `unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reads and parses the implement job's execution-transcript artifact for
 * its model ID (F1-S10 slice 3, factory.md §13.12), via
 * {@link extractModelIdFromTranscript}. Best-effort, same shape as the
 * patch artifact's own "may legitimately not exist" handling: the
 * transcript is uploaded with `if: always()` but its download step is
 * `continue-on-error: true` (a missing/failed implement run may never
 * have produced one at all), so a read failure here degrades the
 * provenance trailer's model-ID field to "unavailable" — logged, never
 * thrown, and never a reason to reject an otherwise-valid publish.
 *
 * @param transcriptPath - Path to the downloaded transcript artifact.
 * @returns The model ID, or `null` if the file is missing, unreadable, or
 *   {@link extractModelIdFromTranscript} couldn't find the field.
 */
async function readModelIdFromTranscript(transcriptPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(transcriptPath, "utf8");
  } catch (err) {
    console.warn(
      `Could not read the implement transcript artifact at ${transcriptPath} ` +
        `(provenance trailer's model ID will read "unavailable"): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  return extractModelIdFromTranscript(raw);
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
  // Provenance metadata only (Codex round-3 finding) — soft-defaulted,
  // not `requireEnv`'d, since a missing value here should degrade the PR
  // body's "Provenance" section, never block an otherwise-valid publish.
  // The workflow sets this to a literal copy of the implement job's
  // `claude-code-action@<sha>` pin; see that step's env var for the
  // "keep these two in sync" note.
  const agentActionRef =
    process.env.IMPLEMENT_AGENT_ACTION_REF ?? "unknown (IMPLEMENT_AGENT_ACTION_REF not set)";
  // F1-S10 slice 3 (factory.md §13.12) — the fuller provenance trailer.
  // Every field here is soft-defaulted, same reasoning as agentActionRef
  // above: a missing/degraded value here can only ever weaken the
  // PROVENANCE RECORD, never block an otherwise-valid publish.
  const promptVersion =
    process.env.IMPLEMENT_PROMPT_VERSION ?? "unknown (IMPLEMENT_PROMPT_VERSION not set)";
  const dispatchActor = process.env.DISPATCH_ACTOR ?? "unknown-dispatcher";
  const transcriptPath =
    process.env.IMPLEMENT_TRANSCRIPT_PATH ?? "transcript-output/claude-execution-output.json";
  const modelId = await readModelIdFromTranscript(transcriptPath);
  const provenance: ProvenanceContext = { modelId, promptVersion, dispatchActor };
  // Which login `postFailureComment` treats as "our own prior comment"
  // (factory.md §13's publisher-identity switch). Soft-defaulted to the
  // built-in GITHUB_TOKEN identity, same reasoning as agentActionRef above:
  // a missing/wrong value here degrades to "post a duplicate comment on a
  // re-dispatch" rather than blocking an otherwise-valid publish. The
  // workflow derives this automatically from the App-token mint step's
  // `app-slug` output once a factory App token is minted — see that env
  // var's comment in the workflow for the fallback chain.
  const failureCommentAuthorLogin =
    process.env.IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN ?? IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN;
  // Adjudicated F2 (#40 rework): whether GH_TOKEN above is the
  // GITHUB_TOKEN fallback (no factory App token minted), computed by the
  // workflow from a step output this job never sees directly — this
  // script only ever receives a bearer token string, which carries no
  // self-describing "which identity am I" signal, so the caller has to
  // tell it. Drives both the PR body's fallback warning and the
  // `no-review-automation` label, so the human merging a fallback-opened
  // PR sees the gap ON THE PR, not just in the Actions log the
  // `::warning::` annotation (implement-ready-issues.yml) only reaches.
  // Soft-defaulted to `false` (not `requireEnv`'d) — a missing value here
  // degrades to "no warning shown", never blocks an otherwise-valid
  // publish; that fail-open direction matches this whole fallback path's
  // own "publish rather than silently stop shipping" judgement call.
  const publishedViaFallback = process.env.PUBLISHED_VIA_FALLBACK === "true";
  // Best-effort, purely for $GITHUB_STEP_SUMMARY (see writeStepSummary) —
  // soft-defaulted to undefined (simply omitted from the summary) when
  // unset, never blocks anything.
  const fallbackReason = process.env.FALLBACK_REASON || undefined;
  const summaryContext: PublishStepSummaryContext = {
    issueNumber,
    publisherLogin: failureCommentAuthorLogin,
    publishedViaFallback,
    fallbackReason,
  };

  // Tracked outside the try so the catch block can tell an unpushed
  // rejection apart from a post-push failure (FIX 5) — a branch that WAS
  // successfully pushed before something later failed must never be
  // reported as "no branch was created".
  let branchName: string | undefined;
  let branchPushed = false;
  // Adjudicated fix (Codex P2, #46 reshape): the label application is
  // best-effort (applyNoReviewAutomationLabelBestEffort tolerates
  // failure) — `undefined` here means "not on the fallback path, this
  // doesn't apply"; only set to true/false once actually attempted, so
  // the $GITHUB_STEP_SUMMARY write below can never overstate "the label
  // was applied" when it might have silently failed.
  let labelApplied: boolean | undefined;
  // Same discipline, for F1-S9 slice 1's anti-gaming label: `undefined`
  // until the PR exists and the label is actually attempted.
  let gamingLabelApplied: boolean | undefined;
  // Same discipline again, for the SEPARATE annotation-comment post
  // (Codex + claude-review finding, round 3): the label and the comment
  // are two independent best-effort calls, so the step summary must
  // reflect each of their REAL outcomes, not assume one implies the other.
  let gamingAnnotationPosted: boolean | undefined;

  try {
    if (implementJobResult !== "success") {
      throw new PublishRejection(
        `implement job result was "${implementJobResult}", not "success" — ` +
          `the patch artifact (even if present and well-formed) is not ` +
          `trusted; only a successful implement run's patch is ever applied`,
      );
    }

    await assertPatchArtifactSize(patchPath);

    const { changedPaths, diffText } = await getAuthoritativePatchAnalysis(patchPath);
    if (changedPaths.length === 0) {
      // Not independently exercised by a unit test: every real-patch
      // shape tried empirically (including a mode-change-only diff,
      // which has zero added/removed lines) still reports at least one
      // path once the scratch-index apply succeeds at all — a totally
      // empty diff instead fails to apply at all and is caught above, in
      // getAuthoritativePatchAnalysis. Kept as a defensive fail-closed
      // check rather than assumed away.
      throw new PublishRejection(
        "the implement run produced no changes (empty patch)",
      );
    }

    // No complementary rename/copy-source check needed here (unlike
    // earlier rounds of this guard) — getAuthoritativePatchAnalysis
    // already returns BOTH sides of every rename/copy, since it's asking
    // git for a tree comparison, not a diff-text parse that only ever
    // saw one side. See that function's docstring.
    const forbidden = findForbiddenPatchPaths(changedPaths);
    if (forbidden.length > 0) {
      throw new PublishRejection(
        `patch touches pipeline-protected path(s), refusing to apply it: ` +
          forbidden.join(", "),
      );
    }

    // F1-S9 slice 1 (issue #12): the deterministic anti-gaming diff
    // classifier. Unlike the forbidden-path check above, a flagged diff
    // does NOT reject the publish — the PR still needs to exist for a
    // human to review (that's the whole point of "routed to human
    // review") — it's labelled (NO_AUTO_CHAIN_LABEL) and annotated
    // (buildGamingFlagAnnotation) once the PR exists, further below.
    // Computed from the SAME authoritative changedPaths the forbidden-
    // path check just used, plus the git-REGENERATED diffText
    // getAuthoritativePatchAnalysis also returns — NOT the agent's own
    // raw patch bytes (round 3 fix, issue #12: scanning the raw patch was
    // itself bypassable via a .gitattributes + GIT-binary-patch trick;
    // see that function's own docstring point 4).
    const gamingFlag: GamingFlag = {
      testFileEdits: findTestFileEdits(changedPaths),
      suppressions: findAddedCoverageSuppressions(diffText),
    };
    const gamingFlagged =
      gamingFlag.testFileEdits.length > 0 || gamingFlag.suppressions.length > 0;

    // DEFERRED (Codex round 3, P1, factory.md §13.4) — secret scanning
    // (gitleaks/trufflehog-style) of the patch content belongs right
    // here, alongside the forbidden-path check above, but is explicitly
    // OUT of this story's scope: it's F1-S7's (issue #10) coherent,
    // dedicated deliverable, not a fragment bolted on here. Interim
    // rationale for why that gap is acceptable until F1-S7 lands:
    // dispatch-first means every run is human-triggered AND every
    // resulting PR is human-merged (no auto-merge), on a public repo
    // where a leaked secret in a PR is visible immediately, not silently
    // shipped; and this job's own token has nothing left TO leak in
    // practice — FIX B eliminates the git credential at the source,
    // CLAUDE_CODE_SUBPROCESS_ENV_SCRUB strips the implement job's
    // subprocess environment, and the "assert no Snowflake/Vercel
    // secrets" step confirms no other secret was ever injected into that
    // job to begin with. Secret-scanning is still a HARD gate before any
    // stage-2 (auto-merge/no-human-review) autonomy — F1-S7 owns it.

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

    applyPatchAndPush(
      branchName,
      patchPath,
      issueNumber,
      issue.title,
      agentActionRef,
      provenance,
    );
    branchPushed = true;

    if (existingPr) {
      console.log(
        `PR #${existingPr.number} already exists for issue #${issueNumber} ` +
          `(branch ${branchName}); refreshed, not opening a duplicate.`,
      );
      if (publishedViaFallback) {
        // Adjudicated fix (Codex round-3 P2, #40 rework): the ORIGINAL F2
        // fold only ever signaled a fallback publish on PR CREATION — its
        // own docstring explicitly scoped out this refresh path as "an
        // accepted, narrow gap". That gap turned out to be a real one: a
        // re-dispatch that force-pushes a new head onto an already-open
        // PR was returning right here with NO signal at all, leaving a
        // genuinely unreviewed new commit indistinguishable from a
        // normally-reviewed one. Closed: apply the same persistent label
        // (idempotent — a no-op if already applied from an earlier
        // publish of this same PR) AND post a fresh comment pointing at
        // this specific refresh (never an upsert — see
        // buildFallbackRefreshCommentBody's docstring for why an
        // edited-in-place comment would be the wrong signal here). Both
        // are best-effort: this branch still returns normally either way,
        // since the branch push itself already succeeded.
        labelApplied = await applyNoReviewAutomationLabelBestEffort(
          token,
          owner,
          repo,
          existingPr.number,
          "refreshed",
        );
        await postFallbackRefreshComment(token, owner, repo, existingPr.number, runUrl);
      }
      if (gamingFlagged) {
        // F1-S9 slice 1 (issue #12): orthogonal to the fallback-identity
        // signal above — a re-dispatch's refreshed commit(s) may
        // introduce a DIFFERENT flagged line than an earlier push, so
        // this applies (idempotently) and annotates (freshly, never an
        // upsert) on every flagged refresh, not just the first one.
        gamingLabelApplied = await applyNoAutoChainLabelBestEffort(
          token,
          owner,
          repo,
          existingPr.number,
          "refreshed",
        );
        gamingAnnotationPosted = await postGamingFlagAnnotation(
          token,
          owner,
          repo,
          existingPr.number,
          gamingFlag,
          gamingLabelApplied,
        );
      }
      writeStepSummary(
        buildPublishSuccessStepSummary({
          ...summaryContext,
          labelApplied,
          gamingFlagged,
          gamingLabelApplied,
          gamingAnnotationPosted,
          prNumber: existingPr.number,
          // findExistingPrForIssue's underlying query doesn't fetch
          // html_url (PullRequestSummary has no such field) — a GitHub PR
          // URL has a fixed, well-known shape, so it's constructed here
          // rather than adding an unused-elsewhere API field just for
          // this summary line.
          prUrl: `https://github.com/${owner}/${repo}/pull/${existingPr.number}`,
          wasRefresh: true,
        }),
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
        base: FACTORY_PR_BASE_REF,
        body: buildImplementPrBody({
          issueNumber,
          runUrl,
          agentActionRef,
          publishedViaFallback,
          ...provenance,
        }),
      },
    );
    console.log(`Opened PR #${created.number}: ${created.html_url}`);

    if (publishedViaFallback) {
      // Adjudicated F2 (#40 rework): the body warning above is easy to
      // miss in a long PR; the label is the always-visible-in-list-view
      // half of the same signal. No separate comment needed on THIS path
      // (unlike the existingPr-refresh path above) — the body warning
      // just built into this brand-new PR already carries the signal.
      labelApplied = await applyNoReviewAutomationLabelBestEffort(
        token,
        owner,
        repo,
        created.number,
        "opened",
      );
    }
    if (gamingFlagged) {
      // F1-S9 slice 1 (issue #12): orthogonal to the fallback-identity
      // label above — always applied on a flagged diff, regardless of
      // which identity published it. Comment posted here too (unlike
      // no-review-automation's own creation path, which relies on the PR
      // BODY warning already carrying its signal) because this is about
      // THIS diff's content, not the publisher identity — the annotation
      // names exactly which file/line tripped it, which the PR body has
      // no room to anticipate at creation time.
      gamingLabelApplied = await applyNoAutoChainLabelBestEffort(
        token,
        owner,
        repo,
        created.number,
        "opened",
      );
      gamingAnnotationPosted = await postGamingFlagAnnotation(
        token,
        owner,
        repo,
        created.number,
        gamingFlag,
        gamingLabelApplied,
      );
    }
    writeStepSummary(
      buildPublishSuccessStepSummary({
        ...summaryContext,
        labelApplied,
        gamingFlagged,
        gamingLabelApplied,
        gamingAnnotationPosted,
        prNumber: created.number,
        prUrl: created.html_url,
        wasRefresh: false,
      }),
    );
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

    // Adjudicated fix (Codex P2, post-#46-merge fix-forward): written
    // BEFORE postFailureComment, not after. postFailureComment makes its
    // own GitHub API calls and has no internal try/catch — a genuine
    // failure there (rate-limit, outage, permissions) throws OUT of this
    // catch block entirely, so anything placed after it never runs. The
    // rejected-publish path is exactly the one where the mint-vs-fallback
    // diagnostic matters most (no PR, no other visible signal), so this
    // write must not be contingent on the comment call also succeeding.
    writeStepSummary(buildPublishRejectedStepSummary({ ...summaryContext, reasons }));

    await postFailureComment(
      token,
      owner,
      repo,
      issueNumber,
      reasons,
      runUrl,
      branchPushed,
      failureCommentAuthorLogin,
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
