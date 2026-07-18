/**
 * Pure logic for the privileged `publish` job in
 * `.github/workflows/implement-ready-issues.yml`. Nothing here touches the
 * network or the filesystem — the network-facing entrypoint
 * (`publish-implement-patch.mts`) computes inputs, calls these functions,
 * and issues the resulting `git`/GitHub API calls. Kept separate so the
 * security-relevant decisions (patch-path guard, branch/PR shape) are
 * unit-testable without mocking `fetch` or shelling out to `git`.
 */

/**
 * Path prefixes/exact matches an implementing agent's patch must never
 * touch (AGENTS.md "Pipeline self-modification", factory.md §13 point 3):
 * the factory's own workflow files, CODEOWNERS, and the privileged
 * glue/publisher scripts themselves (which live outside `.github/**` by
 * design — factory.md's read-only-agent/privileged-publisher split). The
 * invariant is "an implementing agent can't grant itself more pipeline
 * power", not "these paths are frozen" — human-directed changes to them
 * are conventional, human-reviewed work and go through a normal PR, not
 * through this guard.
 *
 * Branch-protection config has no file-level guard here — it's a GitHub
 * API/settings-level control, not a repo path, so a file-diff guard
 * cannot see it either way.
 */
const PROTECTED_PATH_PREFIXES = [".github/", "scripts/factory/"] as const;
const PROTECTED_EXACT_PATHS = ["CODEOWNERS", "docs/CODEOWNERS"] as const;

/**
 * Normalizes a diff-reported path for comparison: strips a leading `a/`
 * or `b/` (git diff's own path prefixes), collapses `./` segments,
 * resolves `..` segments, and strips a leading `/`. A path that still
 * resolves outside the repo root after normalization (starts with `..`)
 * or remains absolute is treated as suspicious and reported verbatim —
 * never silently dropped — so {@link findForbiddenPatchPaths} can flag it
 * rather than let a traversal attempt evade the prefix check by being
 * un-normalizable into something that matches a protected prefix.
 *
 * @param rawPath - A path as it appears in a unified diff header.
 * @returns The normalized, repo-relative path.
 */
export function normalizePatchPath(rawPath: string): string {
  let path = rawPath.trim();
  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }
  const segments = path.split("/");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== "..") {
        resolved.pop();
      } else {
        resolved.push(segment);
      }
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join("/");
}

/**
 * Checks whether a normalized path falls under a protected prefix/exact
 * match. Exported separately from {@link findForbiddenPatchPaths} so a
 * single-path check can be unit-tested directly, independent of diff
 * parsing.
 *
 * @param normalizedPath - A path already run through
 *   {@link normalizePatchPath}.
 * @returns `true` if the path is pipeline-protected.
 */
export function isProtectedPath(normalizedPath: string): boolean {
  if (normalizedPath.startsWith("..") || normalizedPath.startsWith("/")) {
    // Couldn't be normalized into a clean repo-relative path (traversal
    // attempt, or an absolute path some diff tooling shouldn't produce).
    // Fail closed: treat as protected rather than let it slip through
    // because it doesn't literally match a known prefix.
    return true;
  }
  if (
    (PROTECTED_EXACT_PATHS as readonly string[]).includes(normalizedPath)
  ) {
    return true;
  }
  return PROTECTED_PATH_PREFIXES.some((prefix) =>
    normalizedPath.startsWith(prefix),
  );
}

/**
 * Scans a list of paths and returns every one that resolves to a
 * pipeline-protected location.
 *
 * @param rawPaths - Paths git itself reports the patch will touch (see
 *   `getAuthoritativeChangedPaths` in `publish-implement-patch.mts`, which
 *   asks `git apply --numstat` rather than re-parsing the diff — the
 *   caller MUST be the applier's own report, not an independent parse of
 *   the diff text; see that function's docstring for why this replaced an
 *   earlier, exploitable diff-header regex parser). Still run through
 *   {@link normalizePatchPath} here regardless of source, since a
 *   `..`-segment or similar can appear in an authoritative path too.
 * @returns The subset that are protected, normalized. Empty if the patch
 *   is clean.
 */
export function findForbiddenPatchPaths(
  rawPaths: readonly string[],
): string[] {
  const forbidden = new Set<string>();
  for (const raw of rawPaths) {
    const normalized = normalizePatchPath(raw);
    if (isProtectedPath(normalized)) {
      forbidden.add(normalized);
    }
  }
  return Array.from(forbidden).sort();
}

/**
 * Parses `git diff-index --cached --name-status -z -M -C --find-copies-harder
 * HEAD`'s output (run against a throwaway scratch index — see
 * `getAuthoritativeChangedPaths` in `publish-implement-patch.mts` for the
 * full oracle this feeds and WHY it replaced three successive rounds of
 * diff-text parsing).
 *
 * `-z` NUL-terminates every record (not merely separates them), so a
 * trailing empty string after the final record is expected and dropped.
 * Each record is either:
 * - a single-path status (`A`, `M`, `D`, ...): `<status>\0<path>\0`, or
 * - a rename/copy status (`R<score>`, `C<score>`): `<status>\0<oldpath>
 *   \0<newpath>\0` — BOTH paths are pushed for these, since either side
 *   touching a protected path matters to {@link findForbiddenPatchPaths}.
 *
 * @param nameStatusZOutput - Raw stdout from the `git diff-index` oracle
 *   invocation above.
 * @returns Every path git itself reports as touched — both sides of every
 *   rename/copy, already unquoted (git's `-z` output form never uses
 *   C-style quoting, unlike its human-readable default).
 */
export function parseNameStatusZ(nameStatusZOutput: string): string[] {
  const fields = nameStatusZOutput.split("\0");
  // `String.split()` always returns at least one element (even for "" —
  // `"".split("\0")` is `[""]`), so `fields` is never empty here; no
  // length check needed before this trailing-empty-record pop.
  if (fields[fields.length - 1] === "") {
    fields.pop(); // Trailing empty string from the final record's NUL terminator.
  }
  const paths: string[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i];
    if (status === undefined || status.length === 0) {
      break; // Malformed — shouldn't happen from a real git invocation.
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      if (oldPath !== undefined) {
        paths.push(oldPath);
      }
      if (newPath !== undefined) {
        paths.push(newPath);
      }
      i += 3;
    } else {
      const path = fields[i + 1];
      if (path !== undefined) {
        paths.push(path);
      }
      i += 2;
    }
  }
  return paths;
}

/** Upper bound on how long a derived branch slug's title portion may be. */
const MAX_SLUG_TITLE_LENGTH = 40;

/**
 * Derives the house-convention branch name `feature/{issue}-{slug}`
 * (AGENTS.md) from an issue number and title: strips a leading `[Cx-Sx]`-
 * style bracket tag, lowercases, replaces runs of non-alphanumeric
 * characters with a single hyphen, and truncates.
 *
 * @param issueNumber - The issue number, e.g. `6`.
 * @param issueTitle - The issue's title, e.g.
 *   `"[F1-S3] Implement workflow (read-only agent + privileged publisher)"`.
 * @returns A branch name, e.g. `"feature/6-implement-workflow-read-only"`.
 */
export function deriveBranchName(
  issueNumber: number,
  issueTitle: string,
): string {
  const withoutBracketTag = issueTitle.replace(/^\s*\[[^\]]*\]\s*/, "");
  const slug = withoutBracketTag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_TITLE_LENGTH)
    .replace(/-+$/g, "");
  const safeSlug = slug || "issue";
  return `feature/${issueNumber}-${safeSlug}`;
}

/**
 * The base branch every factory-opened PR targets — matches the
 * PR-creation call's own `base: "main"` (`publish-implement-patch.mts`)
 * and the Codex round-7 dispatch-ref guard (`github.ref ==
 * 'refs/heads/main'` in the workflow) that already restricts this whole
 * pipeline to main-only runs. A single named constant rather than a
 * parameter: there is exactly one correct value, never a caller-supplied
 * one, so a typo'd literal at a call site can't silently widen it.
 */
export const FACTORY_PR_BASE_REF = "main";

/**
 * The subset of a GitHub pull request's fields the idempotency check
 * needs. `headRepoFullName` is the head branch's OWNING repo (GitHub API's
 * `pull.head.repo.full_name`), `null` when that repo has since been
 * deleted (e.g. a fork removed after opening a PR from it) — never treated
 * as a match in that case; see {@link findPrForIssueNumber}. `baseRef` is
 * the PR's target branch (GitHub API's `pull.base.ref`).
 */
export interface PullRequestSummary {
  readonly number: number;
  readonly headRef: string;
  readonly headRepoFullName: string | null;
  readonly baseRef: string;
}

/**
 * Finds, among a list of open PRs, the one that was opened for this
 * issue — matched by the STABLE `feature/{issueNumber}-` branch prefix,
 * never by re-deriving the current title's slug; scoped to PRs whose head
 * branch lives in THIS repo (`headRepoFullName === expectedHeadRepoFullName`);
 * and scoped to PRs whose BASE is {@link FACTORY_PR_BASE_REF} (Codex
 * round-4 finding).
 *
 * The base-ref scope closes a second idempotency-matching gap: a
 * same-repo, correctly-prefixed PR whose base is something OTHER than
 * `main` (e.g. a human opened `feature/6-foo` against a long-lived
 * feature branch for unrelated reasons, or a stale PR from before a base
 * was ever enforced) is not a real factory PR for this issue and must
 * never be "reused" — `applyPatchAndPush` would force-push onto its
 * branch and this job would report success while no PR into `main` for
 * this issue's changes actually exists.
 *
 * The repo scope closes a fork-PR confusion (Codex round-7 finding): this
 * is a public repo, so anyone can open a PR from a fork whose branch
 * happens to be named `feature/{issueNumber}-anything` — matching on
 * `headRef` alone would let an attacker-controlled fork PR be mistaken for
 * this factory's own PR for that issue. `applyPatchAndPush` would then
 * force-push OUR patch onto what it believes is that existing PR's
 * branch, but `git push` targets `origin` (this repo) regardless of what
 * PR the caller THOUGHT it was refreshing — so the practical failure mode
 * of the bug is pushing to a branch name that collides with a fork's PR,
 * silently reusing/misattributing that PR's number, rather than writing
 * into the fork itself. Either way, matching is wrong, so it must not be
 * used as "the existing PR for this issue".
 *
 * Idempotency must key off the issue number, not the branch name
 * `deriveBranchName` would produce from today's title: if the issue's
 * title is edited between dispatches, re-deriving the branch name from
 * the (now different) title would miss the existing PR entirely and open
 * a duplicate targeting a never-before-seen branch. Once a branch exists
 * for an issue, every later run must reuse its actual name — found here —
 * rather than deriving a fresh one.
 *
 * @param openPrs - Open pull requests on the repo.
 * @param issueNumber - The issue number to match.
 * @param expectedHeadRepoFullName - This repo's `owner/repo`, e.g.
 *   `"syamaner/roastpilot-cloud"` — a PR whose head repo doesn't match
 *   this exactly (a fork, or a since-deleted source repo) is never
 *   returned, even if its branch name matches.
 * @returns The matching PR, or `null` if none exists yet (first dispatch
 *   for this issue, or every branch-name match was a fork/foreign PR or a
 *   non-main-base PR).
 */
export function findPrForIssueNumber(
  openPrs: readonly PullRequestSummary[],
  issueNumber: number,
  expectedHeadRepoFullName: string,
): PullRequestSummary | null {
  const prefix = `feature/${issueNumber}-`;
  return (
    openPrs.find(
      (pr) =>
        pr.headRef.startsWith(prefix) &&
        pr.headRepoFullName === expectedHeadRepoFullName &&
        pr.baseRef === FACTORY_PR_BASE_REF,
    ) ?? null
  );
}

/**
 * A validated set of inputs for building the implement PR's body.
 * `agentActionRef` is the pinned `owner/repo@sha` the implement job's
 * `claude-code-action` step actually ran (see `main()`'s
 * `IMPLEMENT_AGENT_ACTION_REF` read) — passed through from the workflow
 * rather than hardcoded here, so this module has no literal SHA of its own
 * to drift out of sync with the `uses:` pin.
 *
 * `publishedViaFallback` — true when this PR was opened using the built-in
 * `GITHUB_TOKEN` because no factory App token was minted (factory.md
 * §13's publisher-identity switch). GitHub suppresses downstream workflow
 * triggers for `GITHUB_TOKEN`-authored PR events, so a PR opened this way
 * got NO review-automation coverage at all (CodeQL, Codex, Claude Code
 * Review never ran) — a fact the workflow's own `::warning::` annotation
 * (adjudicated F2, #40 rework) only surfaced in the Actions log, which the
 * human merging the PR doesn't read. This field makes
 * {@link buildImplementPrBody} put that same signal ON the PR itself.
 */
export interface ImplementPrContext {
  readonly issueNumber: number;
  readonly runUrl: string;
  readonly agentActionRef: string;
  readonly publishedViaFallback: boolean;
}

/**
 * The label {@link buildImplementPrBody}'s caller applies to a PR opened
 * via the `GITHUB_TOKEN` fallback (adjudicated F2, #40 rework) — a second,
 * always-visible (PR list / board view, not just the PR body) signal that
 * this PR got no review-automation coverage and needs a manual pass before
 * merging.
 */
export const NO_REVIEW_AUTOMATION_LABEL = "no-review-automation";

/**
 * GitHub caps a label's `description` at 100 characters (REST: "Create a
 * label") and returns 422 if it's exceeded — the same status code as the
 * "label already exists" case {@link isLabelAlreadyExistsError} tolerates,
 * which is exactly why that function checks the error's `code`, not just
 * the status. Kept under a named constant, with a unit test asserting
 * {@link NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION} stays within it, so a
 * future edit that lengthens the text can't silently regress into the
 * same 422-swallowed-as-success bug (Codex round-3 P2, #40 rework) this
 * module's `isLabelAlreadyExistsError` fix closes.
 */
export const GITHUB_LABEL_DESCRIPTION_MAX_LENGTH = 100;

/**
 * Throws if `description` exceeds `maxLength`. A pure, directly-testable
 * guard so `applyNoReviewAutomationLabel` (in `publish-implement-patch.mts`)
 * fails with a clear message here rather than a cryptic 422 from GitHub —
 * extracted as its own function specifically so BOTH branches (within
 * limit / over limit) are exercisable by a unit test without needing to
 * mutate the fixed {@link NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION} export at
 * runtime.
 *
 * @param description - The label description to check.
 * @param maxLength - The limit, in characters. Defaults to
 *   {@link GITHUB_LABEL_DESCRIPTION_MAX_LENGTH}.
 * @throws If `description.length` exceeds `maxLength`.
 */
export function assertLabelDescriptionWithinLimit(
  description: string,
  maxLength: number = GITHUB_LABEL_DESCRIPTION_MAX_LENGTH,
): void {
  if (description.length > maxLength) {
    throw new Error(
      `label description is ${description.length} chars, exceeds GitHub's ` +
        `${maxLength}-char limit`,
    );
  }
}

/**
 * Builds the comment posted on an EXISTING factory PR's issue thread when
 * a re-dispatch refreshes it via the `GITHUB_TOKEN` fallback (Codex
 * round-3 P2, #40 rework, closing a gap the original F2 fold's own
 * docstring had explicitly scoped out).
 *
 * The gap this closes: {@link buildImplementPrBody}'s warning banner and
 * `applyNoReviewAutomationLabel`'s label only ever fired on PR
 * *creation* — a re-dispatch that force-pushes a new head onto an
 * ALREADY-OPEN PR returns before either fires. Unlike the failure-comment
 * upsert elsewhere in this module (which PATCHes its prior comment in
 * place, because a repeated identical failure genuinely IS the same
 * event), this is deliberately a fresh POST every time, never an upsert:
 * each fallback refresh pushes a NEW, not-yet-reviewed commit, so an
 * upserted/edited-in-place comment could read as "already seen" to a
 * human who reviewed an earlier version of it. The label
 * (`no-review-automation`) stays the persistent, always-visible signal;
 * this comment is the per-event one pointing at what specifically
 * changed.
 *
 * @param runUrl - Link to the implement run, for diagnosis.
 * @returns The Markdown comment body.
 */
export function buildFallbackRefreshCommentBody(runUrl: string): string {
  return [
    "> ⚠️ **This PR was just refreshed via the GITHUB_TOKEN fallback — review-automation " +
      "workflows did NOT run against the new commit(s).**",
    "",
    "No factory App token was minted for this run (the App wasn't configured, or minting " +
      "failed), so CodeQL, Codex, and Claude Code Review never triggered on the refreshed " +
      "branch (GitHub suppresses downstream workflow triggers for GITHUB_TOKEN-authored " +
      `events — factory.md §13). **Do not merge without a manual review pass on the latest ` +
      `commit(s).** (Labelled \`${NO_REVIEW_AUTOMATION_LABEL}\`.)`,
    "",
    `[Run output](${runUrl}).`,
  ].join("\n");
}

/**
 * {@link NO_REVIEW_AUTOMATION_LABEL}'s description, applied when the
 * publish job creates the label (idempotently — see
 * `applyNoReviewAutomationLabel` in `publish-implement-patch.mts`).
 * Deliberately short: an earlier draft's 119-character description
 * exceeded {@link GITHUB_LABEL_DESCRIPTION_MAX_LENGTH} and triggered the
 * exact bug `isLabelAlreadyExistsError` now guards against (a genuine
 * validation 422 misread as "label already exists").
 */
export const NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION =
  "Opened via GITHUB_TOKEN fallback — no review automation ran; needs a manual review before merging.";

/**
 * True only when `err` represents GitHub's specific "label already
 * exists" validation error (422, with an `errors[]` entry whose `code` is
 * `"already_exists"`) — NOT any 422 from a label-create call.
 *
 * Adjudicated fix (Codex round-3 P2, #40 rework): an earlier version of
 * this check treated EVERY 422 from `POST .../labels` as "already
 * exists" and silently swallowed it. That also swallowed a genuine
 * validation error — e.g. an over-length `description` (see
 * {@link GITHUB_LABEL_DESCRIPTION_MAX_LENGTH}) returns 422 too — so the
 * label was never actually created, the follow-up "add label to PR" call
 * then failed for real, and the label silently never applied (the PR
 * body warning still fired, so this was a degradation, not a total loss
 * of signal, but a real one). Parsing the response body's `errors[].code`
 * distinguishes the two: only the genuine duplicate case is tolerated, so
 * a future validation error (e.g. this description growing past 100
 * chars again) surfaces loudly instead of no-op'ing.
 *
 * @param err - The error a `githubRequest` `POST .../labels` call threw
 *   (its message has the shape `GitHub API <method> <path> failed:
 *   <status> <raw response body>` — see `github-api.mts`).
 * @returns Whether this is specifically GitHub's "already exists" case.
 */
export function isLabelAlreadyExistsError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const match = err.message.match(/^GitHub API \S+ \S+ failed: (\d+) ([\s\S]*)$/);
  if (!match || match[1] !== "422") {
    return false;
  }
  let body: { errors?: Array<{ code?: string }> };
  try {
    body = JSON.parse(match[2]) as { errors?: Array<{ code?: string }> };
  } catch {
    return false; // Unparsable body: never assume it's the benign case.
  }
  return Boolean(body.errors?.some((e) => e.code === "already_exists"));
}

/**
 * Builds the PR body for a successful implement run, following
 * `.github/PULL_REQUEST_TEMPLATE.md`'s structure so the factory's PRs read
 * the same as a human's.
 *
 * Includes a minimal "Provenance" section (Codex round-3, partial
 * factory.md §13.12): the issue reference and the pinned
 * `claude-code-action` SHA that generated this PR — the two facts already
 * available right here at PR-body-build time. The FULL provenance trailer
 * §13.12 actually calls for (model ID, prompt/skill version, and similar)
 * is F1-S10's deliverable, not this story's; said so explicitly in the
 * body so this partial version is never mistaken for that one.
 *
 * When {@link ImplementPrContext.publishedViaFallback} is true, prepends a
 * bold warning line (adjudicated F2, #40 rework) so the human merging this
 * PR sees, on the PR itself, that no review-automation workflow ran on it
 * — the `::warning::` annotation this mirrors only ever landed in the
 * Actions log, which isn't part of a normal merge review.
 *
 * @param context - The issue number, a link to the implement run's gate
 *   output, the pinned agent action ref that ran, and whether this PR was
 *   opened via the `GITHUB_TOKEN` fallback.
 * @returns The Markdown PR body.
 */
export function buildImplementPrBody(context: ImplementPrContext): string {
  const fallbackWarning = context.publishedViaFallback
    ? [
        "> ⚠️ **Opened via GITHUB_TOKEN fallback — review-automation workflows did " +
          "NOT run on this PR.** No factory App token was minted when this PR was " +
          "published (the App wasn't configured, or minting failed), so CodeQL, " +
          "Codex, and Claude Code Review never triggered (GitHub suppresses " +
          "downstream workflow triggers for GITHUB_TOKEN-authored PR events — " +
          "factory.md §13). **Do not merge without a manual review pass.** " +
          `(Labelled \`${NO_REVIEW_AUTOMATION_LABEL}\`.)`,
        "",
      ]
    : [];
  return [
    ...fallbackWarning,
    "## Story",
    "",
    `Closes #${context.issueNumber}`,
    "",
    "## What changed",
    "",
    "- See the commit(s) on this branch — authored by the F1-S3 implement agent " +
      "from the linked issue's acceptance criteria.",
    "",
    "## How it was verified",
    "",
    `Local gates (lint, typecheck, unit tests) ran in the implement job and passed ` +
      `before this PR was opened — [gate output](${context.runUrl}). CI re-runs the ` +
      `same gates against this branch.`,
    "",
    "## Provenance",
    "",
    `Generated by the F1-S3 implement agent (\`${context.agentActionRef}\`), from ` +
      `issue #${context.issueNumber}, on a manually-dispatched run — ` +
      `[run output](${context.runUrl}).`,
    "",
    "_This is a minimal provenance record (issue ref + pinned agent action SHA). " +
      "The full provenance trailer (model ID, prompt/skill version, and similar — " +
      "factory.md §13.12) is F1-S10's deliverable, not this one's._",
    "",
    "## Review routing",
    "",
    "_Factory-authored PR (F1-S3, dispatch-first) — read the diff before assuming the " +
      "routing notes below the fold in the template apply; this section is intentionally " +
      "left for a human or the review roster to fill in based on the actual diff._",
    "",
  ].join("\n");
}

/**
 * Hidden marker embedded in every implement-failure comment this job
 * posts. Used to find "our" comment on a re-dispatch (idempotency,
 * factory.md §13.8 — Codex round-3 finding: without this, every failed
 * re-dispatch for the same issue POSTed a fresh comment, stacking
 * duplicates) without duplicate-posting. Mirrors
 * `apply-triage-verdict-logic.mts`'s `TRIAGE_COMMENT_MARKER` exactly —
 * same fixed, verdict/reason-independent string so a failure reason's own
 * text can never spoof it.
 */
export const IMPLEMENT_FAILURE_COMMENT_MARKER =
  "<!-- roastpilot-factory:implement-failure:do-not-edit -->";

/**
 * The default GitHub identity that posts on behalf of this workflow's
 * `secrets.GITHUB_TOKEN` — the fallback comment author
 * {@link findExistingImplementFailureCommentId} treats as "our own prior
 * comment" when no publisher identity is configured. Same value and same
 * reasoning as `apply-triage-verdict-logic.mts`'s
 * `TRIAGE_COMMENT_AUTHOR_LOGIN`.
 *
 * The publish job's actual identity is configurable (factory.md §13's
 * publisher-identity switch — see the workflow's
 * `IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN` env var): once a factory App
 * token is minted, comments post as THAT identity's `<app-slug>[bot]`
 * login, not this one, and the workflow must pass the real login through
 * so a re-dispatch still finds its own prior comment. This constant stays
 * the correct default for the "no App token minted, still on
 * GITHUB_TOKEN" case.
 */
export const IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN = "github-actions[bot]";

/** A comment as returned by the GitHub REST API, narrowed to the fields we use. */
export interface ExistingComment {
  readonly id: number;
  readonly body: string;
  /** GitHub's `user.type`, e.g. `"Bot"` for the Actions token's identity. */
  readonly authorType: string | null;
  /** GitHub's `user.login`, e.g. `"github-actions[bot]"`. */
  readonly authorLogin: string | null;
}

/**
 * Finds the previous implement-failure comment this job posted on an
 * earlier run for the same issue, if any, so a re-dispatch edits it
 * instead of posting a duplicate.
 *
 * Scoped to comments authored by exactly `authorLogin` AND carrying the
 * marker — matching on bot-type alone would let a different bot's comment
 * (containing the marker string coincidentally, or by an untrusted echo)
 * be mistaken for this job's own and silently overwritten. Same reasoning
 * as `findExistingTriageCommentId`. The expected `authorType` is derived
 * from `authorLogin`'s own shape (a `[bot]`-suffixed login is always type
 * `"Bot"` on GitHub; anything else is type `"User"`) rather than assumed —
 * this keeps the check correct whether the publisher identity is the
 * built-in Actions bot, a GitHub App's bot identity, or a human-owned PAT.
 *
 * @param comments - Comments currently on the issue.
 * @param authorLogin - The exact login expected to have posted our own
 *   prior comment. Defaults to
 *   {@link IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN} (the built-in
 *   `GITHUB_TOKEN` identity); pass the actual publisher identity's login
 *   once a factory App token is minted, or idempotency breaks (every
 *   re-dispatch posts a fresh comment instead of editing the prior one).
 * @returns The existing comment's id, or `null` if none found.
 */
export function findExistingImplementFailureCommentId(
  comments: readonly ExistingComment[],
  authorLogin: string = IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN,
): number | null {
  const expectedType = authorLogin.endsWith("[bot]") ? "Bot" : "User";
  const match = comments.find(
    (c) =>
      c.authorType === expectedType &&
      c.authorLogin === authorLogin &&
      c.body.includes(IMPLEMENT_FAILURE_COMMENT_MARKER),
  );
  return match ? match.id : null;
}

/**
 * Builds the issue comment posted when an implement run does NOT produce
 * a publishable PR — empty/failed patch, a forbidden-path violation, or
 * the implement job itself not succeeding. Mirrors the triage skill's
 * fallback comment in spirit: explain what happened, change nothing else.
 * Ends with {@link IMPLEMENT_FAILURE_COMMENT_MARKER} so a re-dispatch's
 * failure comment can find and edit this one instead of stacking a
 * duplicate.
 *
 * @param reasons - Human-readable reasons implementation did not proceed.
 * @param runUrl - Link to the implement run, for diagnosis.
 * @returns The Markdown comment body.
 */
export function buildImplementFailureCommentBody(
  reasons: readonly string[],
  runUrl: string,
  branchPushed = false,
): string {
  // FIX 5: the preamble must not claim "no branch was created" when one
  // actually was — that's exactly the false statement a post-push,
  // pre-PR-create failure would otherwise produce, and a false "nothing
  // happened" claim is worse than no claim at all: it hides that a branch
  // needs manual follow-up.
  const preamble = branchPushed
    ? "**Automated implementation did not produce a PR**, even though a " +
      "branch was pushed — see the reasons below for what needs manual " +
      "follow-up."
    : "**Automated implementation did not produce a PR.** No branch was " +
      "created and nothing was pushed.";
  const lines = [
    preamble,
    "",
    "Reasons:",
    ...reasons.map((r) => `- ${r}`),
    "",
    `[Run output](${runUrl})`,
    "",
    IMPLEMENT_FAILURE_COMMENT_MARKER,
  ];
  return lines.join("\n");
}

/**
 * Shared fields for both `$GITHUB_STEP_SUMMARY` builders below (operator
 * finding, 18 Jul 2026, live App-identity commissioning): a mint failure
 * shows `conclusion=success` in the job view (masked by `continue-on-error`
 * on the mint step), so a human had to pull raw job logs to find the real
 * outcome. Writing mint-vs-fallback into the run's own summary — success
 * or rejection alike — closes that gap without needing GitHub's own UI to
 * change.
 */
export interface PublishStepSummaryContext {
  /** The issue this publish run is for. */
  readonly issueNumber: number;
  /**
   * The identity `GH_TOKEN` actually authenticated as — `<app-slug>[bot]`
   * when a factory App token was minted, or the `GITHUB_TOKEN` fallback's
   * known login otherwise. Same value the workflow derives for
   * `IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN`; passed straight through
   * rather than re-derived here.
   */
  readonly publisherLogin: string;
  /** Whether this run published via the `GITHUB_TOKEN` fallback. */
  readonly publishedViaFallback: boolean;
  /**
   * Why the fallback happened, if capturable by the workflow (e.g. "App
   * ID not configured" vs "the mint step failed") — soft, best-effort;
   * `undefined` when not fallback, or when the workflow couldn't
   * determine a specific reason.
   */
  readonly fallbackReason?: string;
}

/**
 * Upper bound applied by both step-summary sanitizers below — generous
 * enough for any legitimate value (a login, a URL, a short reason phrase)
 * while still bounding how much of a giant/adversarial string could reach
 * the summary.
 */
const MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH = 200;

/**
 * Sanitizes a plain-text field (a login, a fallback reason, a rejection
 * reason) before it reaches `$GITHUB_STEP_SUMMARY`'s rendered Markdown.
 * Fixes a CodeQL alert (#46 reshape): "network data written to file" —
 * `publisherLogin` (from the mint step's `app-slug` API output) and the
 * rejection `reasons` (which can indirectly embed a
 * `deriveBranchName`-derived slug of an issue's title) originate from a
 * GitHub API response or an attacker-writable issue/PR field, not purely
 * this workflow's own literals.
 *
 * Deliberately narrower than a blanket "strip every Markdown-special
 * character" pass: an earlier draft of this fix also stripped `[`/`]`/`(`/
 * `)`, which corrupted entirely legitimate content — every bot login is
 * `<slug>[bot]`, and a rejection reason routinely carries a useful
 * parenthetical like `(empty patch)`. Neither is a real Markdown-structure
 * risk in body text (unlike a `[text](url)` LINK slot — see
 * {@link sanitizeStepSummaryUrl} for that case): a stray `[`/`(` sitting in
 * a plain sentence renders as a literal bracket, not a link, unless
 * followed by a matching `](url)`, which none of this module's own
 * template strings ever place immediately after an interpolated field.
 * Only newlines (could smuggle extra summary lines/headings) and
 * backticks (`publisherLogin` specifically is wrapped in a backtick code
 * span in the output; a login containing one would break out of it) are
 * unsafe here.
 *
 * @param value - The field value to sanitize.
 * @returns The sanitized value: newlines collapsed to a space, backticks
 *   stripped, clamped to
 *   {@link MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH} characters.
 */
export function sanitizeStepSummaryText(value: string): string {
  const collapsed = value.replace(/[\r\n]+/g, " ").replace(/`/g, "");
  return collapsed.length > MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH
    ? `${collapsed.slice(0, MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH)}…`
    : collapsed;
}

/**
 * Sanitizes a field placed in a Markdown LINK's URL slot —
 * `[text](${sanitized})` — before it reaches `$GITHUB_STEP_SUMMARY`.
 * `prUrl` is network-derived (a PR-create/-list API response); unlike
 * {@link sanitizeStepSummaryText}'s plain-body-text case, a bracket or
 * paren HERE genuinely can corrupt the link's structure (close the URL
 * slot early, or open a second link), so this strips them in addition to
 * newlines/backticks. A well-formed GitHub URL never legitimately
 * contains any of these characters, so stripping them is never lossy for
 * real input.
 *
 * @param value - The URL value to sanitize.
 * @returns The sanitized value, clamped to
 *   {@link MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH} characters.
 */
export function sanitizeStepSummaryUrl(value: string): string {
  const collapsed = value.replace(/[\r\n]+/g, " ").replace(/[`[\]()]/g, "");
  return collapsed.length > MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH
    ? `${collapsed.slice(0, MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH)}…`
    : collapsed;
}

function publisherIdentityLine(context: PublishStepSummaryContext): string {
  const login = sanitizeStepSummaryText(context.publisherLogin);
  if (!context.publishedViaFallback) {
    return `✅ Minted as \`${login}\``;
  }
  const reasonSuffix = context.fallbackReason
    ? ` — ${sanitizeStepSummaryText(context.fallbackReason)}`
    : "";
  return `⚠️ Fell back to \`GITHUB_TOKEN\` (identity: \`${login}\`)${reasonSuffix}`;
}

/**
 * Builds the `$GITHUB_STEP_SUMMARY` markdown for a successful publish (a
 * PR was opened or an existing one refreshed).
 *
 * @param context - Shared publisher-identity fields, plus the PR this run
 *   produced or refreshed, and whether the fallback label was actually
 *   applied.
 * @returns The Markdown summary block.
 */
export function buildPublishSuccessStepSummary(
  context: PublishStepSummaryContext & {
    readonly prNumber: number;
    readonly prUrl: string;
    readonly wasRefresh: boolean;
    /**
     * Whether `applyNoReviewAutomationLabelBestEffort` actually succeeded
     * — `undefined` when not on the fallback path (the label is never
     * attempted). Adjudicated fix (Codex P2, #46 reshape): that function
     * is best-effort and CAN fail, so this must reflect the REAL outcome
     * rather than the summary unconditionally claiming "the label was
     * applied" regardless of what actually happened.
     */
    readonly labelApplied?: boolean;
  },
): string {
  const labelLine =
    context.labelApplied === false
      ? `⚠️ attempted but FAILED to apply — check the run's logs`
      : `the \`${NO_REVIEW_AUTOMATION_LABEL}\` label was applied`;
  // Adjudicated fix (Codex P2, #46 reshape): Codex's real behavior is
  // narrower than "triggered normally" implied. It auto-reviews at PR
  // creation for an App-token/human-authored PR, but per AGENTS.md's
  // merge policy the operator must still MANUALLY `@codex review` the
  // FINAL commit and wait for that verdict before merging — this summary
  // must never read as if the Codex-wait is already satisfied just
  // because CI/CodeQL/etc. triggered. For a GITHUB_TOKEN-fallback PR,
  // Codex does not auto-trigger at all (same GITHUB_TOKEN-authored-event
  // suppression as every other gate).
  const reviewAutomationLine = context.publishedViaFallback
    ? "⚠️ **Suppressed** — GitHub does not trigger downstream workflows (CI, CodeQL, " +
      "dependency review, Claude Code Review) for `GITHUB_TOKEN`-authored PR events " +
      `(factory.md §13); Codex does NOT auto-trigger either. ${labelLine} — ` +
      "a manual review pass is required before merging."
    : "✅ CI, CodeQL, dependency review, and Claude Code Review triggered normally. " +
      "Codex auto-reviewed at creation, but the operator must still manually " +
      "`@codex review` the FINAL commit and wait for its verdict before merging " +
      "(AGENTS.md's Codex-wait rule) — this is NOT satisfied automatically.";
  return [
    "## Factory publish summary",
    "",
    `- **Issue:** #${context.issueNumber}`,
    `- **Publisher identity:** ${publisherIdentityLine(context)}`,
    `- **PR:** [#${context.prNumber}](${sanitizeStepSummaryUrl(context.prUrl)})${context.wasRefresh ? " (refreshed, not newly opened)" : ""}`,
    `- **Review automation:** ${reviewAutomationLine}`,
    "",
  ].join("\n");
}

/**
 * Builds the `$GITHUB_STEP_SUMMARY` markdown for a REJECTED publish (no
 * PR was opened or refreshed) — see
 * {@link buildPublishSuccessStepSummary}'s docstring for why this exists
 * even on the failure path.
 *
 * @param context - Shared publisher-identity fields, plus the rejection
 *   reasons already used to build the failure comment
 *   ({@link buildImplementFailureCommentBody}).
 * @returns The Markdown summary block.
 */
export function buildPublishRejectedStepSummary(
  context: PublishStepSummaryContext & { readonly reasons: readonly string[] },
): string {
  return [
    "## Factory publish summary",
    "",
    `- **Issue:** #${context.issueNumber}`,
    `- **Publisher identity:** ${publisherIdentityLine(context)}`,
    "- **PR:** none — publish rejected. Reasons:",
    ...context.reasons.map((r) => `  - ${sanitizeStepSummaryText(r)}`),
    "",
  ].join("\n");
}
