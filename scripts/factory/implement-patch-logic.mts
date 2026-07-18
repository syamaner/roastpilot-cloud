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
 * For a rename, `--numstat` reports only the DESTINATION path, not the
 * source — {@link findProtectedPathMentionsInSummaryText} is the
 * complementary check that also catches a rename OUT of a protected path,
 * which this alone would miss.
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

/**
 * Coarse, defense-in-depth complement to {@link findForbiddenPatchPaths}:
 * scans `git apply --summary`'s raw text output (which, unlike
 * `--numstat`, DOES print both sides of a rename — e.g. `rename
 * .github/workflows/ci.yml => lib/ci.yml (100%)`) for any literal mention
 * of a protected path. This is NOT a structural parse (the rename-summary
 * format itself varies — a shared-prefix `{old => new}` form vs a
 * no-shared-prefix `old => new` form — which is exactly why this checks
 * for a plain substring instead of trying to parse either shape
 * correctly): it exists to catch a rename OUT of a protected path (which
 * moves/effectively deletes protected content — a different attack shape
 * than writing malicious content INTO one, but still pipeline
 * self-modification) that a destination-only path list cannot see, as a
 * second, cruder layer alongside the authoritative numstat-based check —
 * not a replacement for it.
 *
 * @param summaryText - Raw stdout from `git apply --summary <patch>`.
 * @returns Every protected prefix/exact path that appears anywhere in the
 *   text, sorted. Empty if none do.
 */
export function findProtectedPathMentionsInSummaryText(
  summaryText: string,
): string[] {
  const mentions = new Set<string>();
  for (const prefix of PROTECTED_PATH_PREFIXES) {
    if (summaryText.includes(prefix)) {
      mentions.add(prefix);
    }
  }
  for (const exact of PROTECTED_EXACT_PATHS) {
    if (summaryText.includes(exact)) {
      mentions.add(exact);
    }
  }
  return Array.from(mentions).sort();
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

/** The subset of a GitHub pull request's fields the idempotency check needs. */
export interface PullRequestSummary {
  readonly number: number;
  readonly headRef: string;
}

/**
 * Finds, among a list of open PRs, the one that was opened for this
 * issue — matched by the STABLE `feature/{issueNumber}-` branch prefix,
 * never by re-deriving the current title's slug. Idempotency must key off
 * the issue number, not the branch name `deriveBranchName` would produce
 * from today's title: if the issue's title is edited between dispatches,
 * re-deriving the branch name from the (now different) title would miss
 * the existing PR entirely and open a duplicate targeting a
 * never-before-seen branch. Once a branch exists for an issue, every
 * later run must reuse its actual name — found here — rather than
 * deriving a fresh one.
 *
 * @param openPrs - Open pull requests on the repo.
 * @param issueNumber - The issue number to match.
 * @returns The matching PR, or `null` if none exists yet (first dispatch
 *   for this issue).
 */
export function findPrForIssueNumber(
  openPrs: readonly PullRequestSummary[],
  issueNumber: number,
): PullRequestSummary | null {
  const prefix = `feature/${issueNumber}-`;
  return openPrs.find((pr) => pr.headRef.startsWith(prefix)) ?? null;
}

/** A validated set of inputs for building the implement PR's body. */
export interface ImplementPrContext {
  readonly issueNumber: number;
  readonly runUrl: string;
}

/**
 * Builds the PR body for a successful implement run, following
 * `.github/PULL_REQUEST_TEMPLATE.md`'s structure so the factory's PRs read
 * the same as a human's.
 *
 * @param context - The issue number and a link to the implement run's gate
 *   output.
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
    "## Review routing",
    "",
    "_Factory-authored PR (F1-S3, dispatch-first) — read the diff before assuming the " +
      "routing notes below the fold in the template apply; this section is intentionally " +
      "left for a human or the review roster to fill in based on the actual diff._",
    "",
  ].join("\n");
}

/**
 * Builds the issue comment posted when an implement run does NOT produce
 * a publishable PR — empty/failed patch, a forbidden-path violation, or
 * the implement job itself not succeeding. Mirrors the triage skill's
 * fallback comment in spirit: explain what happened, change nothing else.
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
  ];
  return lines.join("\n");
}
