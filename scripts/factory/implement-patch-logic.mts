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
 * Parses `git apply --numstat -z`'s output into the list of destination
 * paths it reports. NUL-separated records, each `<added>\t<deleted>\t
 * <path>` — `-z` (rather than plain `--numstat`) is used specifically so a
 * path containing a literal tab or newline can't be misparsed; NUL is the
 * one byte no filesystem allows in a path, making it a safe delimiter.
 *
 * For a rename or copy, `--numstat` reports only the DESTINATION path, not
 * the source — {@link extractRenameCopySourcePaths} is the complementary
 * check that also catches a rename/copy OUT of a protected path, which
 * this alone would miss.
 *
 * @param numstatZOutput - Raw stdout from `git apply --numstat -z <patch>`.
 * @returns The destination path of every file the patch touches.
 */
export function parseNumstatZ(numstatZOutput: string): string[] {
  const paths: string[] = [];
  for (const record of numstatZOutput.split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) {
      continue; // Malformed record — shouldn't happen from a real git invocation.
    }
    paths.push(record.slice(secondTab + 1));
  }
  return paths;
}

const RENAME_COPY_LINE_PREFIXES = [
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
] as const;

/**
 * Extracts every path named on a `rename from `/`rename to `/`copy from
 * `/`copy to ` line, read directly from the RAW patch text — not from
 * `--numstat` (destination-only for these) or `git apply --summary`
 * (round-6 finding: --summary brace-COMPACTS a shared path prefix, e.g.
 * `rename scripts/{factory/x.mts => other/y.mts} (100%)` — the literal
 * substring `scripts/factory/` is not even present in that string, so a
 * substring scan on --summary output silently misses exactly the case it
 * exists to catch; that approach was replaced with this one, not layered
 * alongside it).
 *
 * These lines are safe to parse directly (unlike a `diff --git a/X b/Y`
 * header, which needs `-p`-stripping interpretation `git apply` itself
 * must be asked about — see `getAuthoritativeChangedPaths`'s docstring):
 * empirically confirmed that `git apply` uses `rename from`/`rename to`
 * paths LITERALLY, regardless of whatever prefix scheme the diff header
 * on the same file entry uses — a patch with a mismatched/fake
 * `diff --git zz/X zz/Y` header alongside correct, unprefixed `rename
 * from X` / `rename to Y` lines still renames exactly `X` to `Y`. There is
 * no `-p`-interpretation gap for these lines to diverge on.
 *
 * @param patchText - The full raw patch text (not `--numstat`/`--summary`
 *   output — the actual patch file content).
 * @returns Every path named on a rename/copy from/to line, in patch order
 *   (both sides of every rename/copy the patch contains).
 */
export function extractRenameCopySourcePaths(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split("\n")) {
    for (const prefix of RENAME_COPY_LINE_PREFIXES) {
      if (line.startsWith(prefix)) {
        paths.push(line.slice(prefix.length));
        break;
      }
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
 * The subset of a GitHub pull request's fields the idempotency check
 * needs. `headRepoFullName` is the head branch's OWNING repo (GitHub API's
 * `pull.head.repo.full_name`), `null` when that repo has since been
 * deleted (e.g. a fork removed after opening a PR from it) — never treated
 * as a match in that case; see {@link findPrForIssueNumber}.
 */
export interface PullRequestSummary {
  readonly number: number;
  readonly headRef: string;
  readonly headRepoFullName: string | null;
}

/**
 * Finds, among a list of open PRs, the one that was opened for this
 * issue — matched by the STABLE `feature/{issueNumber}-` branch prefix,
 * never by re-deriving the current title's slug, AND scoped to PRs whose
 * head branch lives in THIS repo (`headRepoFullName === expectedHeadRepoFullName`).
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
 *   for this issue, or every branch-name match was a fork/foreign PR).
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
        pr.headRepoFullName === expectedHeadRepoFullName,
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
 */
export interface ImplementPrContext {
  readonly issueNumber: number;
  readonly runUrl: string;
  readonly agentActionRef: string;
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
 * @param context - The issue number, a link to the implement run's gate
 *   output, and the pinned agent action ref that ran.
 * @returns The Markdown PR body.
 */
export function buildImplementPrBody(context: ImplementPrContext): string {
  return [
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
 * The exact GitHub identity that posts on behalf of this workflow's
 * `secrets.GITHUB_TOKEN` — the only comment author
 * {@link findExistingImplementFailureCommentId} will ever treat as "our own
 * prior comment". Same value and same reasoning as
 * `apply-triage-verdict-logic.mts`'s `TRIAGE_COMMENT_AUTHOR_LOGIN`.
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
 * Scoped to comments authored by exactly
 * {@link IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN} AND carrying the marker —
 * matching on bot-type alone would let a different bot's comment
 * (containing the marker string coincidentally, or by an untrusted echo)
 * be mistaken for this job's own and silently overwritten. Same reasoning
 * as `findExistingTriageCommentId`.
 *
 * @param comments - Comments currently on the issue.
 * @returns The existing comment's id, or `null` if none found.
 */
export function findExistingImplementFailureCommentId(
  comments: readonly ExistingComment[],
): number | null {
  const match = comments.find(
    (c) =>
      c.authorType === "Bot" &&
      c.authorLogin === IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN &&
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
