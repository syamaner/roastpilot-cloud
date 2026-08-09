/**
 * Dependency-free formatting for authoritative patch-analysis git output.
 *
 * Git execution belongs to the privileged publisher. This leaf only turns
 * already-captured strings into the shared structured result so credentialed
 * callers can consume that result without importing a process capability.
 */

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

/** One path row from git's authoritative `--numstat -z` scratch-index diff. */
export interface FactoryPatchLineStat {
  /** Destination path, or the only path for a non-rename row. */
  readonly path: string;
  /** Source path when git reports a rename/copy row. */
  readonly sourcePath?: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

/** What {@link getAuthoritativePatchAnalysis} reports about a patch. */
export interface AuthoritativePatchAnalysis {
  /** Commit SHA to which the patch was authoritatively applied. */
  readonly baseSha: string;
  /** Exact tree object written by the proven scratch index. */
  readonly treeOid: string;
  /** Every path git itself reports as touched, both sides of every rename/copy. */
  readonly changedPaths: string[];
  /**
   * A git-REGENERATED, `--text`-forced diff of the same scratch tree —
   * authoritative content for the anti-gaming classifiers
   * ({@link findAddedCoverageSuppressions}, {@link findAddedPackageJsonTestScriptEdits})
   * to scan, never the agent's own raw patch bytes. See this function's
   * own docstring, point 3.
   */
  readonly diffText: string;
  /** Per-path changed-line rows from the same applied scratch index. */
  readonly lineStats: FactoryPatchLineStat[];
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

/**
 * Parses rename-aware `git diff --cached --numstat -z HEAD` output.
 *
 * The first two TABs delimit additions and deletions; the remaining bytes are
 * the unquoted path and may themselves contain TABs. For rename/copy rows git
 * leaves that path empty and emits the source and destination as the next two
 * NUL records. Binary rows use `-` for both counts. Malformed output throws so
 * the privileged publisher fails closed rather than guessing.
 *
 * @param numstatZOutput - Raw stdout from the scratch-index git query.
 * @returns Validated per-path changed-line rows.
 */
export function parseNumstatZ(
  numstatZOutput: string,
): FactoryPatchLineStat[] {
  if (numstatZOutput === "") {
    return [];
  }
  const records = numstatZOutput.split("\0");
  if (records.pop() !== "") {
    throw new Error("numstat output is not NUL-terminated");
  }
  const stats: FactoryPatchLineStat[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const firstTab = record.indexOf("\t");
    const secondTab =
      firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) {
      throw new Error("numstat output contains a malformed record");
    }
    const additionsRaw = record.slice(0, firstTab);
    const deletionsRaw = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    let sourcePath: string | undefined;
    if (path.length === 0) {
      sourcePath = records[index + 1];
      path = records[index + 2] ?? "";
      if (!sourcePath || !path) {
        throw new Error("numstat rename/copy row is truncated");
      }
      index += 2;
    }
    let additions: number | null;
    let deletions: number | null;
    if (additionsRaw === "-" || deletionsRaw === "-") {
      if (additionsRaw !== "-" || deletionsRaw !== "-") {
        throw new Error("numstat binary row has mismatched counts");
      }
      additions = null;
      deletions = null;
    } else {
      if (
        !/^(?:0|[1-9][0-9]*)$/.test(additionsRaw) ||
        !/^(?:0|[1-9][0-9]*)$/.test(deletionsRaw)
      ) {
        throw new Error("numstat output contains invalid changed-line counts");
      }
      additions = Number(additionsRaw);
      deletions = Number(deletionsRaw);
      if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
        throw new Error(
          "numstat changed-line count exceeds the safe integer range",
        );
      }
    }
    stats.push(
      sourcePath === undefined
        ? { path, additions, deletions }
        : { path, sourcePath, additions, deletions },
    );
  }
  return stats;
}

export interface AuthoritativePatchAnalysisOutput {
  readonly baseSha: string;
  readonly treeOid: string;
  readonly nameStatusOutput: string;
  readonly numstatOutput: string;
  readonly diffText: string;
}

/** Formats already-captured git output without executing git or touching I/O. */
export function parseAuthoritativePatchAnalysis(
  output: AuthoritativePatchAnalysisOutput,
): AuthoritativePatchAnalysis {
  const lineStats = parseNumstatZ(output.numstatOutput);
  return {
    baseSha: output.baseSha,
    treeOid: output.treeOid,
    changedPaths: parseNameStatusZ(output.nameStatusOutput),
    diffText: output.diffText,
    lineStats,
  };
}
