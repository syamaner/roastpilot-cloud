/**
 * Protected, closed external-process capabilities for factory glue.
 *
 * Callers receive typed operations only. Executable identity, arguments,
 * environment, working directory, and lifecycle options remain private.
 */

import { spawnSync } from "node:child_process";
import {
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { resolve } from "node:path";

const PROCESS_CAPABILITY_FAILURE =
  "listTrackedPaths process capability failed closed";

interface PathIdentity {
  readonly canonicalPath: string;
  readonly device: bigint;
  readonly inode: bigint;
}

/** Exact result of the reviewed Git tracked-path capability. */
export interface TrackedPathList {
  readonly repositoryRoot: string;
  readonly rawTrackedPaths: Buffer;
}

function capabilityFailure(): Error {
  return new Error(PROCESS_CAPABILITY_FAILURE);
}

function identity(
  canonicalPath: string,
  stats: BigIntStats,
): PathIdentity {
  return {
    canonicalPath,
    device: stats.dev,
    inode: stats.ino,
  };
}

function inspectRepositoryRoot(repositoryRoot: string): PathIdentity {
  try {
    const canonicalPath = realpathSync(resolve(repositoryRoot));
    const stats = statSync(canonicalPath, { bigint: true });
    if (!stats.isDirectory()) throw capabilityFailure();
    return identity(canonicalPath, stats);
  } catch {
    throw capabilityFailure();
  }
}

function inspectGitExecutable(): PathIdentity {
  try {
    const canonicalPath = realpathSync("/usr/bin/git");
    const stats = statSync(canonicalPath, { bigint: true });
    if (canonicalPath !== "/usr/bin/git" || !stats.isFile()) {
      throw capabilityFailure();
    }
    return identity(canonicalPath, stats);
  } catch {
    throw capabilityFailure();
  }
}

function revalidateIdentity(
  expected: PathIdentity,
  expectedKind: "directory" | "file",
): void {
  try {
    const canonicalPath = realpathSync(expected.canonicalPath);
    const stats = statSync(canonicalPath, { bigint: true });
    const correctKind =
      expectedKind === "directory"
        ? stats.isDirectory()
        : stats.isFile();
    if (
      canonicalPath !== expected.canonicalPath ||
      stats.dev !== expected.device ||
      stats.ino !== expected.inode ||
      !correctKind
    ) {
      throw capabilityFailure();
    }
  } catch {
    throw capabilityFailure();
  }
}

/**
 * Lists raw NUL-delimited tracked paths for one canonical Git repository.
 *
 * @param repositoryRoot - Existing repository working-tree root.
 * @returns The canonical root and an owned copy of Git's raw stdout bytes.
 * @throws Error when path identity, process execution, or output validation
 *   does not satisfy D126.
 */
export function listTrackedPaths(
  repositoryRoot: string,
): TrackedPathList {
  const rootIdentity = inspectRepositoryRoot(repositoryRoot);
  const gitIdentity = inspectGitExecutable();
  revalidateIdentity(rootIdentity, "directory");
  revalidateIdentity(gitIdentity, "file");

  try {
    const result = spawnSync("/usr/bin/git", ["ls-files", "-z"], {
      cwd: rootIdentity.canonicalPath,
      encoding: "buffer",
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_KEY_0: "core.fsmonitor",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_VALUE_0: "false",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      } as unknown as NodeJS.ProcessEnv,
      killSignal: "SIGKILL",
      maxBuffer: 16_777_216,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
      windowsHide: true,
    });

    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0 ||
      !Buffer.isBuffer(result.stdout) ||
      !Buffer.isBuffer(result.stderr) ||
      result.stdout.length > 16_777_216
    ) {
      throw capabilityFailure();
    }

    return {
      repositoryRoot: rootIdentity.canonicalPath,
      rawTrackedPaths: Buffer.from(result.stdout),
    };
  } catch {
    throw capabilityFailure();
  }
}
