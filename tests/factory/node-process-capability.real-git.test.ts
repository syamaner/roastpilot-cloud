import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { listTrackedPaths } from "../../scripts/factory/node-process-capability.mts";

function withTemporaryRepository(
  run: (repositoryRoot: string) => void,
): void {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "node-process-capability-"));
  try {
    execFileSync("/usr/bin/git", ["init", "--quiet"], {
      cwd: repositoryRoot,
    });
    run(repositoryRoot);
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
}

describe("listTrackedPaths real Git boundary", () => {
  it("overrides a repository-local core.fsmonitor hook", () => {
    withTemporaryRepository((repositoryRoot) => {
      const trackedPath = join(repositoryRoot, "tracked.txt");
      const hookPath = join(repositoryRoot, "fsmonitor-hook.sh");
      const sentinelPath = join(repositoryRoot, "fsmonitor-ran");
      writeFileSync(trackedPath, "tracked\n");
      execFileSync("/usr/bin/git", ["add", "--", "tracked.txt"], {
        cwd: repositoryRoot,
      });
      writeFileSync(
        hookPath,
        [
          "#!/bin/sh",
          `: > '${sentinelPath.replaceAll("'", "'\\''")}'`,
          "printf '\\n'",
          "",
        ].join("\n"),
      );
      chmodSync(hookPath, 0o755);
      execFileSync(
        "/usr/bin/git",
        ["config", "core.fsmonitor", hookPath],
        { cwd: repositoryRoot },
      );

      execFileSync("/usr/bin/git", ["ls-files", "-z"], {
        cwd: repositoryRoot,
        env: {
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        } as unknown as NodeJS.ProcessEnv,
      });
      expect(existsSync(sentinelPath)).toBe(true);
      rmSync(sentinelPath);

      const result = listTrackedPaths(repositoryRoot);

      expect(result.rawTrackedPaths).toEqual(Buffer.from("tracked.txt\0"));
      expect(existsSync(sentinelPath)).toBe(false);
    });
  });

  it("returns the canonical root used to list a symlinked repository", () => {
    const parent = mkdtempSync(join(tmpdir(), "node-process-capability-link-"));
    try {
      const repositoryRoot = join(parent, "repository");
      const symlinkRoot = join(parent, "repository-link");
      execFileSync("/usr/bin/git", ["init", "--quiet", repositoryRoot]);
      writeFileSync(join(repositoryRoot, "tracked.txt"), "tracked\n");
      execFileSync("/usr/bin/git", ["add", "--", "tracked.txt"], {
        cwd: repositoryRoot,
      });
      symlinkSync(repositoryRoot, symlinkRoot);

      const result = listTrackedPaths(symlinkRoot);

      expect(result.repositoryRoot).toBe(realpathSync(repositoryRoot));
      expect(result.rawTrackedPaths).toEqual(Buffer.from("tracked.txt\0"));
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });
});
