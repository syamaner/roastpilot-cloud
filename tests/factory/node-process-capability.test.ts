import { spawnSync } from "node:child_process";
import {
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  listTrackedPaths,
  type TrackedPathList,
} from "../../scripts/factory/node-process-capability.mts";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}));

const FAILURE = "listTrackedPaths process capability failed closed";

function pathStats(
  kind: "directory" | "file",
  device: number,
  inode: number,
): BigIntStats {
  return {
    dev: BigInt(device),
    ino: BigInt(inode),
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
  } as unknown as BigIntStats;
}

function successfulSpawn(stdout = Buffer.from("a.ts\0")): ReturnType<typeof spawnSync> {
  const stderr = Buffer.alloc(0);
  return {
    output: [null, stdout, stderr],
    pid: 123,
    signal: null,
    status: 0,
    stderr,
    stdout,
  };
}

function stablePathIdentities(): void {
  vi.mocked(realpathSync)
    .mockReturnValueOnce("/repo")
    .mockReturnValueOnce("/usr/bin/git")
    .mockReturnValueOnce("/repo")
    .mockReturnValueOnce("/usr/bin/git");
  vi.mocked(statSync)
    .mockReturnValueOnce(pathStats("directory", 1, 2))
    .mockReturnValueOnce(pathStats("file", 3, 4))
    .mockReturnValueOnce(pathStats("directory", 1, 2))
    .mockReturnValueOnce(pathStats("file", 3, 4));
}

beforeEach(() => {
  vi.clearAllMocks();
  stablePathIdentities();
  vi.mocked(spawnSync).mockReturnValue(successfulSpawn());
});

describe("listTrackedPaths", () => {
  it("uses the one exact D126 process contract and returns owned bytes", () => {
    process.env.PARENT_SECRET = "must-not-cross";
    const childStdout = Buffer.from("a.ts\0");
    vi.mocked(spawnSync).mockReturnValue(successfulSpawn(childStdout));

    let result: TrackedPathList;
    try {
      result = listTrackedPaths("/repo");
    } finally {
      delete process.env.PARENT_SECRET;
    }

    expect(spawnSync).toHaveBeenCalledOnce();
    expect(spawnSync).toHaveBeenCalledWith(
      "/usr/bin/git",
      ["ls-files", "-z"],
      {
        cwd: "/repo",
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
        },
        killSignal: "SIGKILL",
        maxBuffer: 16_777_216,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        windowsHide: true,
      },
    );
    expect(result).toEqual({
      repositoryRoot: "/repo",
      rawTrackedPaths: Buffer.from("a.ts\0"),
    });
    expect(result.rawTrackedPaths).not.toBe(childStdout);
    childStdout.fill(0);
    expect(result.rawTrackedPaths).toEqual(Buffer.from("a.ts\0"));
  });

  it("revalidates canonical path and device/inode identity before spawning", () => {
    expect(listTrackedPaths("/repo").repositoryRoot).toBe("/repo");

    expect(realpathSync).toHaveBeenNthCalledWith(1, "/repo");
    expect(realpathSync).toHaveBeenNthCalledWith(2, "/usr/bin/git");
    expect(realpathSync).toHaveBeenNthCalledWith(3, "/repo");
    expect(realpathSync).toHaveBeenNthCalledWith(4, "/usr/bin/git");
    expect(
      vi.mocked(realpathSync).mock.invocationCallOrder[3],
    ).toBeLessThan(vi.mocked(spawnSync).mock.invocationCallOrder[0]!);
  });

  it.each([
    {
      name: "repository realpath replacement",
      realpaths: ["/repo", "/usr/bin/git", "/other", "/usr/bin/git"],
      stats: [
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
      ],
    },
    {
      name: "repository inode replacement",
      realpaths: ["/repo", "/usr/bin/git", "/repo", "/usr/bin/git"],
      stats: [
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
        pathStats("directory", 1, 9),
        pathStats("file", 3, 4),
      ],
    },
    {
      name: "repository device replacement",
      realpaths: ["/repo", "/usr/bin/git", "/repo", "/usr/bin/git"],
      stats: [
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
        pathStats("directory", 9, 2),
        pathStats("file", 3, 4),
      ],
    },
    {
      name: "initial Git realpath mismatch",
      realpaths: ["/repo", "/other/git"],
      stats: [
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
      ],
    },
    {
      name: "initial Git non-file",
      realpaths: ["/repo", "/usr/bin/git"],
      stats: [
        pathStats("directory", 1, 2),
        pathStats("directory", 3, 4),
      ],
    },
    {
      name: "Git realpath replacement",
      realpaths: ["/repo", "/usr/bin/git", "/repo", "/other/git"],
      stats: [
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
      ],
    },
    {
      name: "Git inode replacement",
      realpaths: ["/repo", "/usr/bin/git", "/repo", "/usr/bin/git"],
      stats: [
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
        pathStats("directory", 1, 2),
        pathStats("file", 3, 8),
      ],
    },
    {
      name: "Git device replacement",
      realpaths: ["/repo", "/usr/bin/git", "/repo", "/usr/bin/git"],
      stats: [
        pathStats("directory", 1, 2),
        pathStats("file", 3, 4),
        pathStats("directory", 1, 2),
        pathStats("file", 8, 4),
      ],
    },
  ])("fails before spawn on $name", ({ realpaths, stats }) => {
    vi.mocked(realpathSync).mockReset();
    vi.mocked(statSync).mockReset();
    for (const value of realpaths) {
      vi.mocked(realpathSync).mockReturnValueOnce(value);
    }
    for (const value of stats) {
      vi.mocked(statSync).mockReturnValueOnce(value);
    }

    expect(() => listTrackedPaths("/repo")).toThrow(FAILURE);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    [
      "spawn error",
      {
        ...successfulSpawn(),
        error: Object.assign(new Error("secret child detail"), {
          code: "ETIMEDOUT",
        }),
      },
    ],
    ["nonzero exit", { ...successfulSpawn(), status: 1 }],
    ["signal", { ...successfulSpawn(), signal: "SIGKILL", status: null }],
    ["non-buffer stdout", { ...successfulSpawn(), stdout: "unexpected" }],
    ["non-buffer stderr", { ...successfulSpawn(), stderr: "unexpected" }],
    [
      "oversized stdout",
      successfulSpawn(Buffer.alloc(16_777_217)),
    ],
  ])("fails closed with a sanitized error on %s", (_name, spawnResult) => {
    vi.mocked(spawnSync).mockReturnValue(
      spawnResult as ReturnType<typeof spawnSync>,
    );

    let caught: unknown;
    try {
      listTrackedPaths("/repo");
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new Error(FAILURE));
    expect(String(caught)).not.toContain("secret child detail");
  });

  it.each([
    ["missing repository", 1],
    ["missing Git executable", 2],
    ["repository revalidation failure", 3],
    ["Git revalidation failure", 4],
  ])("sanitizes %s filesystem errors", (_name, failureCall) => {
    vi.mocked(realpathSync).mockReset();
    vi.mocked(realpathSync).mockImplementation((path) => {
      if (vi.mocked(realpathSync).mock.calls.length === failureCall) {
        throw new Error(`attacker-controlled path: ${String(path)}`);
      }
      return String(path);
    });

    expect(() => listTrackedPaths("/repo")).toThrow(FAILURE);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
