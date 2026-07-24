/**
 * Rejects literal zero-width and bidi-format characters in tracked UTF-8
 * repository text.
 *
 * This scanner is dependency-free so CI can run it before `npm ci`. It reads
 * the working tree rather than Git object contents so the same command also
 * catches local, uncommitted edits during preflight.
 */

import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readlinkSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_TRACKED_PATH_LIST_BYTES = 16 * 1024 * 1024;
const DISALLOWED_FORMAT_CHARACTER_PATTERN =
  /\p{Default_Ignorable_Code_Point}/gu;
const LOG_UNSAFE_CHARACTER_PATTERN =
  /[\p{Default_Ignorable_Code_Point}\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  // Preserve a leading UTF-8 BOM as U+FEFF so the guard can reject it.
  ignoreBOM: true,
});

/**
 * Exact repo-relative paths allowed to contain the otherwise forbidden
 * characters.
 *
 * Keep this empty unless a conventional protected-path review records a
 * concrete need and rationale for an exact file.
 */
export const ALLOWLISTED_TRACKED_PATHS: ReadonlySet<string> = new Set();

/** One forbidden character and its one-based location. */
export interface InvisibleFormatFinding {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly codePoint: number;
}

/** Aggregate result from scanning the tracked working tree. */
export interface InvisibleFormatScanResult {
  readonly findings: readonly InvisibleFormatFinding[];
  readonly scannedTextFiles: number;
  readonly skippedNonTextEntries: number;
  readonly skippedAllowlistedEntries: number;
}

/** File loader injected into the pure tracked-path traversal. */
export type TrackedEntryLoader = (path: string) => Uint8Array | null;

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function advancePosition(
  text: string,
  line: number,
  column: number,
): { line: number; column: number } {
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    if (character === "\r") {
      index += text[index + 1] === "\n" ? 2 : 1;
      line += 1;
      column = 1;
    } else if (
      character === "\n" ||
      character === "\u2028" ||
      character === "\u2029"
    ) {
      index += character.length;
      line += 1;
      column = 1;
    } else {
      index += character.length;
      column += 1;
    }
  }
  return { line, column };
}

/**
 * Finds forbidden literal format characters in decoded text.
 *
 * @param path - Repo-relative tracked path used only in returned diagnostics.
 * @param text - Valid UTF-8 text to inspect.
 * @returns Findings in source order with one-based line and code-point column.
 */
export function findInvisibleFormatCharacters(
  path: string,
  text: string,
): InvisibleFormatFinding[] {
  const findings: InvisibleFormatFinding[] = [];
  let cursor = 0;
  let line = 1;
  let column = 1;

  for (const match of text.matchAll(DISALLOWED_FORMAT_CHARACTER_PATTERN)) {
    const index = match.index;
    const position = advancePosition(text.slice(cursor, index), line, column);
    line = position.line;
    column = position.column;
    const character = match[0];
    findings.push({
      path,
      line,
      column,
      codePoint: character.codePointAt(0)!,
    });
    const afterMatch = advancePosition(character, line, column);
    line = afterMatch.line;
    column = afterMatch.column;
    cursor = index + character.length;
  }
  return findings;
}

/**
 * Decodes content only when it is NUL-free, valid UTF-8 text.
 *
 * @param content - Raw tracked working-tree bytes.
 * @returns Decoded text, or `null` for binary/non-UTF-8 content.
 */
export function decodeTrackedText(content: Uint8Array): string | null {
  if (content.includes(0)) {
    return null;
  }
  try {
    return UTF8_DECODER.decode(content);
  } catch {
    return null;
  }
}

/**
 * Scans a deterministic tracked-path list with an injected entry loader.
 *
 * @param trackedPaths - Repo-relative paths from `git ls-files -z`.
 * @param loadEntry - Loads a regular file or symlink's tracked bytes; returns
 *   `null` for non-file entries such as submodules.
 * @param allowlistedPaths - Exact repo-relative paths exempt from findings.
 * @returns Counts and findings sorted by the supplied path order.
 */
export function scanTrackedPaths(
  trackedPaths: readonly string[],
  loadEntry: TrackedEntryLoader,
  allowlistedPaths: ReadonlySet<string> = ALLOWLISTED_TRACKED_PATHS,
): InvisibleFormatScanResult {
  const findings: InvisibleFormatFinding[] = [];
  let scannedTextFiles = 0;
  let skippedNonTextEntries = 0;
  let skippedAllowlistedEntries = 0;

  for (const path of trackedPaths) {
    if (allowlistedPaths.has(path)) {
      skippedAllowlistedEntries += 1;
      continue;
    }
    const content = loadEntry(path);
    if (content === null) {
      skippedNonTextEntries += 1;
      continue;
    }
    const text = decodeTrackedText(content);
    if (text === null) {
      skippedNonTextEntries += 1;
      continue;
    }
    scannedTextFiles += 1;
    findings.push(...findInvisibleFormatCharacters(path, text));
  }

  return {
    findings,
    scannedTextFiles,
    skippedNonTextEntries,
    skippedAllowlistedEntries,
  };
}

function safePathForLog(path: string): string {
  return JSON.stringify(path).replace(
    LOG_UNSAFE_CHARACTER_PATTERN,
    (character) => `[${codePointLabel(character.codePointAt(0)!)}]`,
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

/**
 * Formats a finding without echoing attacker-controlled source content.
 *
 * @param finding - Finding returned by {@link scanTrackedPaths}.
 * @returns One workflow-log-safe diagnostic line.
 */
export function formatInvisibleFormatFinding(
  finding: InvisibleFormatFinding,
): string {
  return `${safePathForLog(finding.path)}:${finding.line}:${finding.column}: forbidden ${codePointLabel(finding.codePoint)}`;
}

/**
 * Loads one tracked working-tree entry without following symlinks.
 *
 * @param repositoryRoot - Repository root containing the tracked path.
 * @param path - Repo-relative path reported by Git.
 * @returns Regular-file bytes, symlink text bytes, or `null` for a non-file
 *   entry such as a gitlink directory.
 */
export function loadTrackedWorkingTreeEntry(
  repositoryRoot: string,
  path: string,
): Uint8Array | null {
  const absolutePath = resolve(repositoryRoot, path);
  const rootPrefix = repositoryRoot.endsWith(sep)
    ? repositoryRoot
    : `${repositoryRoot}${sep}`;
  if (!absolutePath.startsWith(rootPrefix)) {
    throw new Error(
      `tracked path escapes repository root: ${safePathForLog(path)}`,
    );
  }

  try {
    try {
      return readlinkSync(absolutePath, { encoding: "buffer" });
    } catch (error) {
      if (!hasErrorCode(error, "EINVAL")) {
        throw error;
      }
    }

    const descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!fstatSync(descriptor).isFile()) {
        return null;
      }
      return readFileSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    throw new Error(`cannot inspect tracked path: ${safePathForLog(path)}`);
  }
}

/**
 * Scans all tracked working-tree entries in a repository.
 *
 * @param repositoryRoot - Absolute or relative Git working-tree root.
 * @returns Aggregate scan counts and findings.
 */
export function scanRepository(
  repositoryRoot: string,
): InvisibleFormatScanResult {
  const resolvedRoot = resolve(repositoryRoot);
  const trackedPathOutput = execFileSync("git", ["ls-files", "-z"], {
    cwd: resolvedRoot,
    encoding: "utf8",
    maxBuffer: MAX_TRACKED_PATH_LIST_BYTES,
  });
  const trackedPaths = trackedPathOutput.split("\0").filter(Boolean);
  return scanTrackedPaths(
    trackedPaths,
    (path) => loadTrackedWorkingTreeEntry(resolvedRoot, path),
    ALLOWLISTED_TRACKED_PATHS,
  );
}

/** Runs the repository scanner from the current working directory. */
export function main(): void {
  const result = scanRepository(process.cwd());
  if (result.findings.length > 0) {
    const diagnostics = result.findings.map(formatInvisibleFormatFinding);
    throw new Error(
      [
        `Found ${result.findings.length} forbidden literal invisible format character(s):`,
        ...diagnostics,
        "Use a visible \\\\uXXXX escape or runtime code-point construction instead.",
      ].join("\n"),
    );
  }
  console.log(
    `Invisible-format guard passed: scanned ${result.scannedTextFiles} tracked UTF-8 text file(s); ` +
      `skipped ${result.skippedNonTextEntries} non-text and ${result.skippedAllowlistedEntries} allowlisted entry/entries.`,
  );
}

/** Converts scanner failures into a nonzero workflow process result. */
export function runCli(): void {
  try {
    main();
  } catch (error) {
    console.error(
      "Invisible-format guard failed:",
      /* v8 ignore next -- scanner paths throw Error instances. */
      error instanceof Error ? error.message : "unexpected error",
    );
    process.exitCode = 1;
  }
}

/**
 * Checks whether Node invoked this module as the process entrypoint.
 *
 * @param moduleUrl - The module's `import.meta.url`.
 * @param argvPath - Node's entrypoint argument, when present.
 * @returns `true` only when both resolve to the same filesystem path.
 */
export function isDirectExecution(
  moduleUrl: string,
  argvPath: string | undefined,
): boolean {
  return (
    argvPath !== undefined &&
    realpathSync(fileURLToPath(moduleUrl)) ===
      realpathSync(resolve(argvPath))
  );
}

/* v8 ignore next -- import-only branch; runCli is process tested. */
if (isDirectExecution(import.meta.url, process.argv[1])) {
  runCli();
}
