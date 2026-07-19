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
 * Directory prefixes this repo's own test runners actually use for
 * discovery (F1-S9 slice 1, issue #12 — the deterministic anti-gaming
 * diff classifier) — verified against each tool's own config, not
 * guessed: `vitest.config.ts`'s `include: ["tests/**\/*.test.ts"]`,
 * `playwright.config.ts`'s `testDir: "./e2e"`, and pytest's default
 * `test_*.py`/`*_test.py` discovery under `snowflake/tests/` (no
 * `pytest.ini`/`pyproject.toml` overriding that convention in this repo).
 */
const TEST_PATH_PREFIXES = ["tests/", "e2e/", "snowflake/tests/"] as const;

/**
 * Filename-suffix patterns treated as a test file independent of
 * directory — defense in depth against a test file someday landing
 * outside {@link TEST_PATH_PREFIXES}, not a claim that either check alone
 * is complete.
 */
const TEST_FILENAME_PATTERNS = [
  /\.test\.tsx?$/,
  /\.spec\.tsx?$/,
  /^test_.*\.py$/,
  /.*_test\.py$/,
] as const;

/**
 * True when a normalized path is a test file by this repo's own
 * conventions (directory OR filename-suffix match — see
 * {@link TEST_PATH_PREFIXES}/{@link TEST_FILENAME_PATTERNS}).
 *
 * Deliberately conservative in one direction only: this is used to FLAG a
 * diff for human review, never to silently permit anything, so a false
 * positive (an ordinary file that happens to match a suffix pattern) costs
 * a human a few seconds of "yes, this is fine"; a false negative would
 * mean a real test-file edit sails through unflagged. Over-matching is the
 * sound choice for this class (see the module's `NO_AUTO_CHAIN_LABEL`
 * docstring for why "assertion weakening" itself isn't attempted — it's
 * semantic and can't be reliably detected, so the whole class is flagged).
 *
 * @param normalizedPath - A path already run through
 *   {@link normalizePatchPath}.
 * @returns Whether this path is a test file.
 */
export function isTestFilePath(normalizedPath: string): boolean {
  if (TEST_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))) {
    return true;
  }
  // No `?? fallback` needed here (unlike a `.split("/").pop()` form would
  // require): `lastIndexOf` returns -1 for a path with no "/" at all, and
  // `.slice(0)` on that is simply the whole string — every input has a
  // well-defined result, no branch is ever unreachable.
  const filename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  return TEST_FILENAME_PATTERNS.some((pattern) => pattern.test(filename));
}

/**
 * Scans a list of changed paths and returns every one that's a test file.
 *
 * @param rawPaths - Paths git itself reports the patch will touch (same
 *   authoritative source as {@link findForbiddenPatchPaths} — see that
 *   function's docstring for why this must be the applier's own report,
 *   not an independent diff-text parse).
 * @returns The subset that are test files, normalized and sorted. Empty
 *   if none.
 */
export function findTestFileEdits(rawPaths: readonly string[]): string[] {
  const edits = new Set<string>();
  for (const raw of rawPaths) {
    const normalized = normalizePatchPath(raw);
    if (isTestFilePath(normalized)) {
      edits.add(normalized);
    }
  }
  return Array.from(edits).sort();
}

/** A single ADDED coverage-suppression line {@link findAddedCoverageSuppressions} found. */
export interface CoverageSuppressionMatch {
  /** The file the suppression comment was added in (normalized). */
  readonly path: string;
  /** The added line's content, trimmed. */
  readonly line: string;
}

/**
 * Matches a coverage-suppression comment: Python's `# pragma: no cover`
 * or `# pragma: no branch` (both real `coverage.py` pragmas), or a JS/TS
 * coverage-provider ignore comment — in EITHER its block-comment
 * (`/* v8/c8/istanbul ignore ... *\/`) or line-comment
 * (`// v8/c8/istanbul ignore ...`) form. `v8 ignore` (block form) is this
 * repo's LIVE syntax (`vitest.config.ts`'s `coverage: { provider: "v8" }`);
 * `c8`/`istanbul`, and the line-comment form for all three, are matched
 * defensively even though unused here today — over-matching a syntax
 * this repo doesn't currently use is harmless, and a future provider
 * switch (or a diff copy-pasted from elsewhere) shouldn't need this
 * pattern updated to still catch it. This exact set (independent
 * factory-security-reviewer finding, F1-S9 slice 1, issue #12 — an
 * earlier version's docstring claimed "c8/istanbul" broadly while the
 * regex only matched their BLOCK-comment form, missing istanbul's
 * documented line-comment form) is what the pattern below actually
 * matches — kept in sync deliberately, not narrowed to a stale claim.
 */
const COVERAGE_SUPPRESSION_PATTERN =
  /#\s*pragma:\s*no\s*(?:cover|branch)|(?:\/\*|\/\/)\s*(?:v8|c8|istanbul)\s+ignore\b/i;

/**
 * Scans raw unified-diff text for coverage-suppression comments on
 * ADDED lines only — an existing suppression this diff doesn't touch is
 * not this diff's problem to flag.
 *
 * A line is only ever considered "added content" while inside a hunk
 * (after a `@@ ... @@` marker for the current file, reset at each
 * `diff --git` header). This is what excludes the `+++ b/path` FILE
 * HEADER line (which always precedes any hunk marker) from being
 * misread as added content — a real added line's own code could itself
 * start with `++`, e.g. `++i;`, so a naive `+++`-prefix check ALONE is
 * ambiguous: it can't tell that shape apart from the genuine header.
 * `@@` markers have no such ambiguity (unique to hunk headers), so the
 * `+++`-header branch below is gated on `!inHunk` — the header can only
 * be genuine BEFORE the first `@@` for its file.
 *
 * CLOSED BUG (independent Codex + claude-review finding, F1-S9 slice 1,
 * issue #12): an earlier version checked the `+++ ` prefix
 * UNCONDITIONALLY, without the `!inHunk` gate this docstring already
 * claimed existed — so an ADDED line whose code happened to start with
 * `++` (serializing as the raw diff line `+++counter;`) was misread as a
 * (fake) file header REGARDLESS of hunk state, resetting `currentPath`
 * and `inHunk` mid-hunk and causing every subsequent added line for that
 * file — including a real suppression comment right after the decoy
 * line — to be silently skipped. A trivially craftable, complete bypass
 * of this whole classifier. The gate below is the actual fix; the
 * disambiguation this docstring describes was always the INTENDED
 * mechanism, just not, before this fix, the IMPLEMENTED one.
 *
 * `+++ b/path` (or `+++ /dev/null` for a deletion) is additionally used
 * to track which file the CURRENT hunk belongs to, so a match can be
 * attributed to a path.
 *
 * @param patchText - The raw contents of a unified diff (same file
 *   `main()` already validates the size of before ever reading it — see
 *   `assertPatchArtifactSize`).
 * @returns Every added-line match, in file order. Empty if none.
 */
export function findAddedCoverageSuppressions(
  patchText: string,
): CoverageSuppressionMatch[] {
  const matches: CoverageSuppressionMatch[] = [];
  let currentPath = "";
  let inHunk = false;
  for (const rawLine of patchText.split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    // Gated on `!inHunk` (independent Codex + claude-review finding, F1-S9
    // slice 1, issue #12 — a real bypass in an earlier version, which
    // checked this UNCONDITIONALLY): a real "+++ b/path" file header only
    // ever appears BEFORE the first `@@` for its file (`inHunk` is false
    // there). Without this gate, an ADDED line whose own CODE happens to
    // start with `++` (e.g. `++counter;`) serializes as the raw diff line
    // `+++counter;` — a trivial, craftable string for an attacker to
    // prepend immediately before a real added suppression line, since it
    // was being misread as a (fake) file header, resetting `inHunk` to
    // false and making the classifier skip every following added line
    // for that file, INCLUDING the real suppression right after it.
    if (!inHunk && rawLine.startsWith("+++ ")) {
      currentPath = normalizePatchPath(rawLine.slice("+++ ".length).trim());
      continue;
    }
    if (rawLine.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk || !rawLine.startsWith("+")) {
      continue;
    }
    const content = rawLine.slice(1);
    if (COVERAGE_SUPPRESSION_PATTERN.test(content)) {
      matches.push({ path: currentPath, line: content.trim() });
    }
  }
  return matches;
}

/**
 * Applied to a PR whose diff trips the deterministic anti-gaming
 * classifier ({@link findTestFileEdits} / {@link findAddedCoverageSuppressions},
 * F1-S9 slice 1, issue #12): any edit to a test file, OR any ADDED
 * coverage-suppression comment. Both are treated as a SINGLE, conservative
 * class — "assertion weakening" itself is semantic and can't be reliably
 * detected (no LLM is used here; this whole classifier is deterministic
 * string/path matching), so the entire vector is flagged rather than
 * attempting to distinguish a legitimate test-file edit (e.g. a genuine
 * strengthening) from a gamed one. A human confirms which it is — see
 * {@link buildGamingFlagAnnotation} for the deterministic, templated
 * pointer to exactly what tripped it.
 *
 * ENFORCEMENT CONTRACT (be honest about scope, not aspirational): this
 * label is the durable hook every current and future auto-chain consumer
 * MUST check and refuse to advance a PR carrying it — specifically the
 * dormant §10-ratchet stage-2 trigger (triage's `ready-to-implement`
 * label auto-firing `implement`, NOT wired yet — see
 * `implement-ready-issues.yml`'s own top comment) once that's eventually
 * enabled, and F1-S9 slice 3's spec-grounded review. It is
 * FORWARD-ENFORCING, not a hard block on a chain that doesn't exist
 * today: today's ACTUAL enforcement is this label (a durable, always-
 * visible signal — PR list/board view, not just the PR body) plus the
 * explanatory annotation naming exactly what tripped it plus
 * factory.md §2's permanent human-merge requirement, which already means
 * nothing merges without a human looking at it regardless of this
 * label's presence. Applied at the ONE point in today's pipeline that
 * actually auto-chains with no human step in between — `implement`'s
 * patch flowing straight into `publish`'s auto-opened/refreshed PR,
 * both within a single dispatched run.
 *
 * LABEL-AFTER-EVENT RACE (Codex finding, F1-S9 slice 1, issue #12 —
 * doc-only, no code fix exists): this label is applied AFTER
 * `POST /pulls` succeeds (or after the refresh force-push), so a PR's
 * own `opened`/`synchronize` webhook event necessarily fires BEFORE the
 * label lands — there is no way to label a PR before GitHub emits the
 * event for its creation. Not exploitable today (nothing consumes this
 * label yet), but binding on whatever DOES eventually consume it: a
 * future auto-chain consumer MUST re-read this label from the API at
 * decision time (e.g. `GET /issues/{n}/labels` or the PR's own current
 * label list), NEVER trust a `labels` array captured from the
 * triggering event's payload — that payload is a snapshot from BEFORE
 * this label could have been applied, so trusting it would silently
 * treat every flagged PR as clean.
 */
export const NO_AUTO_CHAIN_LABEL = "no-auto-chain";

/**
 * {@link NO_AUTO_CHAIN_LABEL}'s description, applied when the publish job
 * creates the label (idempotently — see `applyNoAutoChainLabel` in
 * `publish-implement-patch.mts`). Kept under
 * {@link GITHUB_LABEL_DESCRIPTION_MAX_LENGTH}, same reasoning as
 * {@link NO_REVIEW_AUTOMATION_LABEL_DESCRIPTION} — a unit test asserts
 * this stays within it.
 */
export const NO_AUTO_CHAIN_LABEL_DESCRIPTION =
  "Diff edits a test file or adds a coverage-suppression comment — needs human review first.";

/** What the anti-gaming classifier found on one publish run — passed to {@link buildGamingFlagAnnotation}. */
export interface GamingFlag {
  /** Test files the diff edits, normalized, sorted. */
  readonly testFileEdits: readonly string[];
  /** Coverage-suppression comments the diff adds. */
  readonly suppressions: readonly CoverageSuppressionMatch[];
}

/**
 * Builds the deterministic, TEMPLATED (no LLM — this whole classifier is
 * string/path matching) annotation naming exactly what tripped the
 * anti-gaming classifier, so "routed to human review" carries a concrete,
 * actionable pointer rather than an opaque label. Posted as a fresh PR
 * comment on every flagged publish run (creation or refresh alike) — see
 * `postGamingFlagAnnotation` in `publish-implement-patch.mts` — never an
 * upsert: a later refresh may introduce a DIFFERENT flagged line than an
 * earlier one, and an edited-in-place comment could read as "already
 * seen" to a human who reviewed an earlier version.
 *
 * Every field here is ATTACKER-CONTROLLED (a test-file path, or an added
 * line's own content) and is rendered through {@link sanitizeStepSummaryText}
 * before being interpolated — never raw (independent factory-security-
 * reviewer finding, F1-S9 slice 1, issue #12): an added line containing a
 * literal backtick could otherwise break out of its code span and inject
 * live Markdown (a link, an `@mention`) into the factory bot's own
 * comment — the identical injection class `sanitizeStepSummaryText` was
 * already built to close for `$GITHUB_STEP_SUMMARY`. The harm isn't
 * secret exfiltration (nothing sensitive is adjacent); it's that the
 * injection could spoof or bury the very human-review signal this
 * annotation exists to provide (e.g. append a fake "looks clean" or hide
 * the real flagged line under an unrelated link). Sanitizing closes that
 * regardless of which field carries the payload.
 *
 * @param flag - What the classifier found; at least one field is
 *   expected to be non-empty (the caller only invokes this when flagged).
 * @param labelApplied - Whether `applyNoAutoChainLabelBestEffort` actually
 *   succeeded (independent Codex + claude-review finding, F1-S9 slice 1,
 *   issue #12, round 3): an earlier version unconditionally claimed
 *   "labelled `no-auto-chain`" even when the label call failed — the same
 *   never-overstate-success discipline `buildPublishSuccessStepSummary`'s
 *   own `labelApplied`/`gamingLabelApplied` fields already follow.
 * @returns The Markdown comment body.
 */
export function buildGamingFlagAnnotation(flag: GamingFlag, labelApplied: boolean): string {
  const labelLine = labelApplied
    ? `labelled \`${NO_AUTO_CHAIN_LABEL}\`.`
    : `the \`${NO_AUTO_CHAIN_LABEL}\` label FAILED to apply — flagged for manual review anyway.`;
  const lines: string[] = [
    "> 🚩 **This diff was flagged by the deterministic anti-gaming classifier (F1-S9) — " +
      `${labelLine} A human must review this before it advances any further.**`,
    "",
  ];
  if (flag.testFileEdits.length > 0) {
    lines.push("**Test file(s) edited:**");
    for (const path of flag.testFileEdits) {
      lines.push(`- ${sanitizeStepSummaryText(path)}`);
    }
    lines.push("");
  }
  if (flag.suppressions.length > 0) {
    lines.push("**Coverage-suppression comment(s) added:**");
    for (const match of flag.suppressions) {
      lines.push(
        `- ${sanitizeStepSummaryText(match.path)}: ${sanitizeStepSummaryText(match.line)}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "This is a conservative, deterministic flag — it does not judge whether the edit is " +
      "legitimate, only that it falls in a class the factory can't safely auto-verify. " +
      "Confirm it's intentional and correct before merging.",
  );
  return lines.join("\n");
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
 * Inputs the F1-S10 slice-3 provenance trailer needs (factory.md §13.12)
 * — gathered once by `main()` and shared by both
 * {@link buildImplementPrBody} (PR-body rendering) and
 * {@link buildCommitTrailer} (the git commit trailer), rather than
 * threading the same three fields through two separate parameter lists.
 */
export interface ProvenanceContext {
  /**
   * The model Claude Code actually ran with, extracted from the implement
   * job's own execution-transcript artifact (see
   * {@link extractModelIdFromTranscript}) — `null` when that artifact was
   * missing, unparseable, or lacked the field. NEVER fabricated: a caller
   * rendering this must show "unavailable" for `null`, not guess a value.
   */
  readonly modelId: string | null;
  /**
   * Stands in for a prompt/skill version. This workflow embeds the
   * implement prompt directly in `implement-ready-issues.yml` rather than
   * invoking a named `.claude/skills/` file, so there is no separate
   * skill version to report — the repository commit this run checked out
   * (the exact commit the embedded prompt text lived in, unchanged, for
   * this run) is the honest, always-available stand-in.
   */
  readonly promptVersion: string;
  /**
   * The GitHub login of the human who authorized THIS attempt
   * (`github.triggering_actor` — deliberately NOT `github.actor`, which
   * stays the ORIGINAL `workflow_dispatch` initiator across a `gh run
   * rerun`; `triggering_actor` is whoever initiated the current attempt,
   * Codex P2, #55) — the `Signed-off-by` identity, per factory.md's
   * dispatch-first authorization-seam framing: a human explicitly chose
   * to run this, so they're the one certifying it.
   */
  readonly dispatchActor: string;
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
export interface ImplementPrContext extends ProvenanceContext {
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
 * Includes the FULL "Provenance" section (F1-S10 slice 3, factory.md
 * §13.12) — model ID, prompt/skill version, pinned `claude-code-action`
 * SHA, issue ref, and the dispatching human, extending the minimal
 * issue-ref + action-SHA record #34/Codex-round-3 originally shipped
 * (that version explicitly deferred the fuller trailer to this story —
 * see this function's own git history for that earlier docstring).
 *
 * This section is rendered ONLY at PR-creation time, not re-rendered on a
 * later re-dispatch refresh (an accepted, narrow scope matching the
 * fallback-warning banner below, which has the identical limitation for
 * the identical reason — the PR body isn't re-PATCHed on refresh at all).
 * The git commit itself does not share this limitation: {@link
 * buildCommitTrailer} runs on EVERY commit `applyPatchAndPush` makes,
 * including a refresh's force-pushed commit, so the commit trailer always
 * reflects the run that actually produced the code currently on the
 * branch even when this PR-body section still shows the original
 * creation's values.
 *
 * When {@link ImplementPrContext.publishedViaFallback} is true, prepends a
 * bold warning line (adjudicated F2, #40 rework) so the human merging this
 * PR sees, on the PR itself, that no review-automation workflow ran on it
 * — the `::warning::` annotation this mirrors only ever landed in the
 * Actions log, which isn't part of a normal merge review.
 *
 * @param context - The issue number, a link to the implement run's gate
 *   output, the pinned agent action ref that ran, whether this PR was
 *   opened via the `GITHUB_TOKEN` fallback, and the gathered
 *   {@link ProvenanceContext} fields.
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
  const modelLine =
    context.modelId ??
    "unavailable (the implement job's transcript artifact was missing or unparseable)";
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
    `- **Model:** ${modelLine}`,
    `- **Prompt/skill version:** \`${context.promptVersion}\` — this workflow embeds ` +
      "the implement prompt directly in `.github/workflows/implement-ready-issues.yml` " +
      "rather than invoking a named skill file, so this is the repository commit that " +
      "prompt text lived in, unchanged, for this run.",
    `- **Agent action:** \`${context.agentActionRef}\``,
    `- **Issue:** #${context.issueNumber}`,
    `- **Dispatched by:** @${context.dispatchActor}`,
    "",
    `On a manually-dispatched run — [run output](${context.runUrl}).`,
    "",
    "_The commit(s) on this branch carry the same facts as git trailers " +
      "(`Co-Authored-By`, `Signed-off-by`, `Provenance-*`) — refreshed on every " +
      "commit `applyPatchAndPush` makes, unlike this section, which is only " +
      "rendered at PR-creation time (same accepted scope as the fallback-warning " +
      "banner above)._",
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
 * Renders an untrusted plain-text field (a login, a fallback reason, a
 * rejection reason) as an INERT inline code span before it reaches
 * `$GITHUB_STEP_SUMMARY`'s rendered Markdown, closing a CodeQL alert
 * (#46 reshape) — "network data written to file": `publisherLogin` (from
 * the mint step's `app-slug` API output) and the rejection `reasons`
 * (which can indirectly embed a `deriveBranchName`-derived slug of an
 * issue's title, or a forbidden-path guard's report of an
 * agent-controlled patch path) originate from a GitHub API response or
 * an attacker-writable issue/PR field, not purely this workflow's own
 * literals.
 *
 * **This function's history is why it's a code span, not an escaper**
 * (post-#46-merge fix-forward, 3 rounds against the same class of bug):
 * round 1 escaped `[`/`]`/`(`/`)`/`<`/`>` — closed the `[text](url)`
 * link-injection case. Round 2 (CodeQL `js/incomplete-sanitization`)
 * found that escaping without first escaping a PRE-EXISTING backslash in
 * the input let an attacker-supplied `\` combine with the sanitizer's own
 * inserted `\` to form CommonMark's `\\` (literal-backslash) escape,
 * which consumes itself and un-escapes the next character — fixed by
 * doubling existing backslashes first. Round 3 (Codex) found that even
 * fully-correct escaping doesn't stop GFM's **autolinking**: a bare
 * `www.attacker.example` (no brackets, no parens, nothing to escape) or
 * even the fully-escaped `\[x\]\(https://attacker.example\)` STILL
 * renders as a live, clickable link — GFM autolinks a recognized URL
 * shape regardless of surrounding escape characters. Per-metacharacter
 * escaping is a losing, indefinitely-extendable game against a renderer
 * with more Markdown-active constructs than any escaper enumerates.
 *
 * **The categorical fix: don't escape Markdown, remove the field from
 * Markdown context entirely.** A GitHub-Flavored-Markdown inline CODE
 * SPAN (`` `text` ``) renders its contents as **literal text** — no
 * emphasis, no links, no autolinks, no HTML — by construction, not by
 * enumeration; this is the one Markdown construct whose entire purpose is
 * "stop parsing Markdown here." The ONLY thing that can break a value out
 * of the code span it's wrapped in is a literal backtick or a newline
 * inside it (both would end the span early or add unintended lines), so
 * those two are still stripped before wrapping — everything else
 * (brackets, parens, angle brackets, backslashes, bare URLs, anything
 * else GFM might ever autolink or otherwise interpret) needs no
 * escaping at all once it's inside the span. This also fixes the
 * `<slug>[bot]`-login-mangling tension the earlier escaping rounds fought
 * with "for free": a code span shows `[bot]` exactly as typed.
 *
 * **Trusted vs. untrusted, not "escape everything":** this function is
 * for AGENT/ISSUE-DERIVED fields only. `prUrl` (this workflow's own
 * constructed `github.com/.../pull/N` link, never attacker-influenced)
 * deliberately stays a real, clickable `[text](url)` Markdown link via
 * {@link sanitizeStepSummaryUrl} — code-wrapping the one link the summary
 * WANTS clickable would be a readability regression for zero security
 * benefit.
 *
 * @param value - The field value to render.
 * @returns The value with newlines collapsed to a space and backticks
 *   stripped, clamped to {@link MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH}
 *   characters, then wrapped in a single-backtick inline code span. The
 *   returned string already includes its own surrounding backticks — a
 *   caller must NOT additionally wrap it in `` ` ``/`` ` `` (that would
 *   double-wrap).
 */
export function sanitizeStepSummaryText(value: string): string {
  const collapsed = value.replace(/[\r\n]+/g, " ").replace(/`/g, "");
  const clamped =
    collapsed.length > MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH
      ? `${collapsed.slice(0, MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH)}…`
      : collapsed;
  return `\`${clamped}\``;
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
  // sanitizeStepSummaryText already returns its value wrapped in its own
  // code span — do NOT add another layer of backticks around `login`
  // here, that would double-wrap it.
  const login = sanitizeStepSummaryText(context.publisherLogin);
  if (!context.publishedViaFallback) {
    return `✅ Minted as ${login}`;
  }
  const reasonSuffix = context.fallbackReason
    ? ` — ${sanitizeStepSummaryText(context.fallbackReason)}`
    : "";
  return `⚠️ Fell back to \`GITHUB_TOKEN\` (identity: ${login})${reasonSuffix}`;
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
    /**
     * Whether the deterministic anti-gaming classifier (F1-S9 slice 1,
     * issue #12) flagged this diff — `undefined` when the classifier
     * hasn't run for some reason (never expected in practice, but this
     * mirrors `labelApplied`'s optionality rather than assuming it did).
     */
    readonly gamingFlagged?: boolean;
    /**
     * Whether `applyNoAutoChainLabelBestEffort` actually succeeded —
     * `undefined` when `gamingFlagged` is not `true` (the label is never
     * attempted). Same "never overstate success" discipline as
     * `labelApplied` above.
     */
    readonly gamingLabelApplied?: boolean;
    /**
     * Whether `postGamingFlagAnnotation` actually succeeded — `undefined`
     * when `gamingFlagged` is not `true` (never attempted). Tracked
     * SEPARATELY from `gamingLabelApplied` (Codex + claude-review finding,
     * F1-S9 slice 1, issue #12, round 3): the label and the annotation
     * comment are two independent best-effort calls, so this summary must
     * never point the operator at "the PR's annotation comment" when that
     * comment call itself failed and no such comment exists.
     */
    readonly gamingAnnotationPosted?: boolean;
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
  //
  // Adjudicated fix (Codex P1, post-#46-merge fix-forward): Claude Code
  // Review is a THIRD case, not lumped in with "triggered normally" on
  // the non-fallback path. claude-code-review.yml's `allowed_bots` is
  // still `claude,claude[bot]` — allowlisting the factory publisher bot
  // was deliberately dropped from #46 and re-scoped to #47 for its own
  // security review (allowlisting it while the review job still holds
  // `Bash(gh pr comment:*)` + an OAuth token is a real credential-exfil
  // path on agent/issue-derived content). Until #47 lands,
  // `claude-code-action` REJECTS `roastpilot-factory[bot]` outright, so
  // Claude Code Review does NOT actually run on an App-minted factory PR
  // — reporting it as "triggered normally" here would be false on the
  // one path this summary exists to be honest about.
  const reviewAutomationLine = context.publishedViaFallback
    ? "⚠️ **Suppressed** — GitHub does not trigger downstream workflows (CI, CodeQL, " +
      "dependency review, Claude Code Review) for `GITHUB_TOKEN`-authored PR events " +
      `(factory.md §13); Codex does NOT auto-trigger either. ${labelLine} — ` +
      "a manual review pass is required before merging."
    : "✅ CI, CodeQL, and dependency review triggered normally. Codex auto-reviewed " +
      "at creation, but the operator must still manually `@codex review` the FINAL " +
      "commit and wait for its verdict before merging (AGENTS.md's Codex-wait rule) " +
      "— this is NOT satisfied automatically. ⚠️ **Claude Code Review does NOT yet " +
      // sanitizeStepSummaryText already returns its own code span — no
      // extra surrounding backticks here.
      `cover factory-authored PRs** — the publisher bot (${sanitizeStepSummaryText(context.publisherLogin)}) ` +
      "isn't allowlisted in `claude-code-review.yml` yet (tracked in #47); treat this " +
      "PR as if Claude Code Review never ran until that's resolved.";
  const gamingLabelClause =
    context.gamingLabelApplied === false
      ? `attempted but FAILED to apply the \`${NO_AUTO_CHAIN_LABEL}\` label — check the run's logs`
      : `labelled \`${NO_AUTO_CHAIN_LABEL}\``;
  // Independent of the label outcome above (Codex + claude-review finding,
  // round 3): the annotation comment is a SEPARATE best-effort call, so
  // this must only point at "the PR's annotation comment" when that call
  // actually succeeded — never assume the label's outcome implies the
  // comment's.
  const gamingAnnotationClause =
    context.gamingAnnotationPosted === false
      ? "the annotation comment FAILED to post — check the run's logs for exactly what tripped it"
      : "see the PR's annotation comment for exactly what tripped it";
  const gamingLine = !context.gamingFlagged
    ? "✅ clean — no test-file edits, no added coverage-suppression comments"
    : `🚩 **FLAGGED** — ${gamingLabelClause}; ${gamingAnnotationClause} — human review required before this advances`;
  return [
    "## Factory publish summary",
    "",
    `- **Issue:** #${context.issueNumber}`,
    `- **Publisher identity:** ${publisherIdentityLine(context)}`,
    `- **PR:** [#${context.prNumber}](${sanitizeStepSummaryUrl(context.prUrl)})${context.wasRefresh ? " (refreshed, not newly opened)" : ""}`,
    `- **Review automation:** ${reviewAutomationLine}`,
    `- **Anti-gaming classifier:** ${gamingLine}`,
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

/**
 * Extracts the model ID Claude Code actually ran with, from the implement
 * job's own execution-transcript artifact (F1-S10 slice 3, factory.md
 * §13.12's provenance trailer — the model-ID field).
 *
 * The transcript (`claude-execution-output.json`, uploaded by the
 * implement job as the `implement-agent-transcript` artifact — see
 * `implement-ready-issues.yml`) is the raw Claude Agent SDK message
 * stream: a JSON array whose first message is always `{type: "system",
 * subtype: "init", model: "<id>", ...}` (verified against
 * `anthropics/claude-code-action`'s own
 * `base-action/src/run-claude-sdk.ts` at the pinned SHA — that file reads
 * this exact field the same way, for its own sanitized log line). No
 * other source reports the model actually used: this workflow's
 * `claude-code-action` step declares no `model:` input at all (the action
 * defers to whatever the auth method resolves to), so this transcript
 * field is the ONLY place the real value is ever recorded.
 *
 * Deliberately conservative: returns `null` (never fabricates a value)
 * for anything other than a clean match — unparseable JSON, a non-array
 * top level, an array with no `system`/`init` message, or an init
 * message whose `model` field is missing, empty, not a string, or
 * carries a newline (see below). A caller must render this as
 * "unavailable", never guess.
 *
 * Rejects (rather than sanitizes) a `model` value containing `\n`/`\r`
 * (Codex P2, #55): this value is interpolated straight into a git commit
 * trailer ({@link buildCommitTrailer}) with only a nonempty check —
 * without this, a corrupted or tampered transcript whose `model` field
 * contained an embedded newline could forge an extra trailer line (e.g.
 * a fake `Signed-off-by`) into the commit message, the same class of
 * injection the `$GITHUB_STEP_SUMMARY` sanitizer earlier in this
 * pipeline's history was built to close. A legitimate model ID never
 * contains a newline, so REJECTING outright (never truncating/stripping)
 * is both simplest and correct: there is no valid partial value to
 * salvage from a model field that fails this shape check.
 *
 * @param rawTranscriptJson - The raw file contents of the transcript
 *   artifact.
 * @returns The model ID string, or `null` if it could not be determined.
 */
export function extractModelIdFromTranscript(
  rawTranscriptJson: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawTranscriptJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const initMessage = (parsed as unknown[]).find(
    (m): m is Record<string, unknown> =>
      typeof m === "object" &&
      m !== null &&
      (m as Record<string, unknown>).type === "system" &&
      (m as Record<string, unknown>).subtype === "init",
  );
  if (!initMessage) {
    return null;
  }
  const model = initMessage.model;
  if (typeof model !== "string" || model.length === 0) {
    return null;
  }
  return /[\r\n]/.test(model) ? null : model;
}

/**
 * Builds the git commit trailer (F1-S10 slice 3, factory.md §13.12): the
 * fuller provenance record #34's PR body explicitly deferred — that
 * earlier version put a minimal issue-ref + action-SHA note IN THE PR
 * BODY only; the commit itself carried no trailer at all before this.
 *
 * Every line is a valid git trailer (`Token: value`, recognized by `git
 * interpret-trailers`): `Co-Authored-By` credits the agent identity
 * (matching Claude Code's own convention elsewhere), `Signed-off-by`
 * credits the human who authorized this run via dispatch, and the
 * `Provenance-*` lines carry the model / prompt-version / agent-action /
 * issue facts a systemic-bad-PR investigation needs to trace a change
 * back to a specific model version and prompt revision.
 *
 * Applied on EVERY commit `applyPatchAndPush` makes — including a
 * re-dispatch's force-pushed refresh — unlike {@link buildImplementPrBody}'s
 * Provenance section (rendered only at PR-creation time, an existing
 * accepted gap), so the commit itself always reflects the run that
 * actually produced it even when the PR body still shows the original
 * creation's values.
 *
 * The dispatching actor's login is stripped of `[`/`]` before use in the
 * constructed noreply email's local-part — defensive-only: this
 * workflow is exclusively `workflow_dispatch`-triggered by a human (never
 * a bot), so `dispatchActor` is a real GitHub username today (which
 * cannot itself contain those characters), but a future automated
 * trigger could pass a `[bot]`-suffixed login, and those characters are
 * not valid in an unquoted email local-part.
 *
 * @param context - Issue number, agent action ref, and the gathered
 *   {@link ProvenanceContext} fields.
 * @returns The trailer block, ready to pass as a `git commit -m` message
 *   part.
 */
export function buildCommitTrailer(
  context: ProvenanceContext & {
    readonly issueNumber: number;
    readonly agentActionRef: string;
  },
): string {
  const emailSafeActor = context.dispatchActor.replace(/[[\]]/g, "");
  return [
    "Co-Authored-By: Claude <noreply@anthropic.com>",
    `Signed-off-by: ${context.dispatchActor} <${emailSafeActor}@users.noreply.github.com>`,
    `Provenance-Model: ${context.modelId ?? "unavailable (implement transcript missing or unparseable)"}`,
    `Provenance-Prompt-Version: ${context.promptVersion}`,
    `Provenance-Agent-Action: ${context.agentActionRef}`,
    `Provenance-Issue: #${context.issueNumber}`,
  ].join("\n");
}
