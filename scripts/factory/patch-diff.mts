/**
 * Pure parsing of unified `git diff` output — no filesystem, no network.
 * Used by the `publish` job in `implement-ready-issues.yml` to extract the
 * set of paths an implement run's patch touches, which
 * `implement-patch-logic.mts`'s `findForbiddenPatchPaths` then checks
 * against the pipeline-self-modification guard, BEFORE the patch is ever
 * applied with `git apply`.
 */

const DIFF_HEADER_RE = /^diff --git (\S+) (\S+)$/;

/**
 * Upper bound on the on-disk patch artifact size, in bytes, checked via
 * `stat` BEFORE the file is read into memory — same DoS-guard rationale as
 * `MAX_PAYLOAD_BYTES` in `triage-verdict-schema.mts` (a runaway or
 * adversarial artifact must be rejected before it's fully read), sized up
 * from that verdict-JSON bound since a real code patch is legitimately
 * much larger. 2 MiB comfortably covers the house "thin slice" convention
 * (~400 changed lines, plus diff context and test files) with a lot of
 * headroom, while still being far below anything that could meaningfully
 * stall or OOM the runner.
 */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/**
 * Extracts every path a unified diff touches, from its `diff --git a/X
 * b/Y` header lines. Covers additions, deletions, and modifications
 * (both `X` and `Y` collected — for a rename these differ and both must
 * be checked, since a rename INTO a protected path is exactly as
 * dangerous as a direct edit there).
 *
 * Deliberately parses only the `diff --git` header lines, not `---`/`+++`
 * lines: `git diff` always emits a `diff --git` line for every file in
 * the patch, in the un-prefix-stripped `a/`/`b/` form, which is a single
 * reliable anchor — `---`/`+++` lines can read `/dev/null` for
 * adds/deletes and are easy to parse inconsistently across diff tools.
 *
 * @param diffText - The full unified diff, as produced by `git diff`.
 * @returns The set of touched paths, in `a/`/`b/`-prefixed diff-header
 *   form (pass to `normalizePatchPath` before matching against protected
 *   prefixes).
 */
export function extractChangedPathsFromDiff(diffText: string): string[] {
  const paths = new Set<string>();
  for (const line of diffText.split("\n")) {
    const match = DIFF_HEADER_RE.exec(line);
    if (match) {
      paths.add(match[1]!);
      paths.add(match[2]!);
    }
  }
  return Array.from(paths).sort();
}

/**
 * Whether a diff is empty (no `diff --git` headers at all) — an implement
 * run that made no changes, or whose only "changes" were reverted before
 * the diff was captured. Treated the same as a failed run: no PR opens.
 *
 * @param diffText - The full unified diff.
 * @returns `true` if the diff contains no file changes.
 */
export function isEmptyDiff(diffText: string): boolean {
  return extractChangedPathsFromDiff(diffText).length === 0;
}
