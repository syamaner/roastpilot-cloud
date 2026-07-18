import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/factory/publish-implement-patch.mts";

/**
 * Proves the actual git plumbing (`applyPatchAndPush`, private to
 * `publish-implement-patch.mts`) genuinely works — apply, commit, push —
 * against a real temporary repository and a real bare "remote", not a
 * mock. `publish-implement-patch.test.ts` covers validation/rejection
 * logic with `execFileSync` mocked out; this file is the complement: only
 * `fetch` is mocked here, `git` runs for real. No network access needed —
 * the "remote" is a bare repo on local disk.
 */

const VALID_DIFF = `diff --git a/lib/new-file.ts b/lib/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/lib/new-file.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let scratchDir: string;
let bareRemoteDir: string;
let localCloneDir: string;
let patchPath: string;
let originalCwd: string;

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "publish-real-git-"));
  bareRemoteDir = join(scratchDir, "remote.git");
  localCloneDir = join(scratchDir, "local");

  execFileSync("git", ["init", "--bare", "-q", bareRemoteDir]);
  execFileSync("git", ["clone", "-q", bareRemoteDir, localCloneDir]);
  git(localCloneDir, ["config", "user.name", "Test"]);
  git(localCloneDir, ["config", "user.email", "test@example.com"]);
  await writeInitialCommit(localCloneDir);
  // Force-rename to "main" regardless of git's configured init default
  // branch name (varies by environment) — idempotent, no error either way.
  git(localCloneDir, ["branch", "-M", "main"]);
  git(localCloneDir, ["push", "-u", "origin", "main"]);

  patchPath = join(scratchDir, "patch.diff");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(patchPath, VALID_DIFF),
  );

  originalCwd = process.cwd();
  process.chdir(localCloneDir);

  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "syamaner/roastpilot-cloud";
  process.env.TRUSTED_ISSUE_NUMBER = "6";
  process.env.IMPLEMENT_JOB_RESULT = "success";
  process.env.RUN_URL = "https://github.com/o/r/actions/runs/1";
  process.env.PATCH_PATH = patchPath;
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(scratchDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.TRUSTED_ISSUE_NUMBER;
  delete process.env.IMPLEMENT_JOB_RESULT;
  delete process.env.RUN_URL;
  delete process.env.PATCH_PATH;
  process.exitCode = undefined;
});

async function writeInitialCommit(dir: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(dir, "README.md"), "# scratch repo\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("publish-implement-patch — real git plumbing", () => {
  it("applies the patch, commits, and pushes a real branch to the bare remote", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/issues/6")) {
        return jsonResponse({ title: "[F1-S3] Implement workflow" });
      }
      if (method === "GET" && url.includes("/pulls?head=")) {
        return jsonResponse([]);
      }
      if (method === "POST" && url.endsWith("/pulls")) {
        return jsonResponse(
          { number: 99, html_url: "https://github.com/o/r/pull/99" },
          201,
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();

    // Verify against the BARE REMOTE, not the local clone — proves the
    // push genuinely landed, not just that the local branch was created.
    const branches = execFileSync(
      "git",
      ["branch", "--list", "feature/6-implement-workflow"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(branches).toContain("feature/6-implement-workflow");

    // Clone the remote fresh into a separate dir to inspect the pushed
    // content, independent of the working copy `main()` operated on.
    const verifyDir = join(scratchDir, "verify");
    execFileSync("git", [
      "clone",
      "-q",
      "--branch",
      "feature/6-implement-workflow",
      bareRemoteDir,
      verifyDir,
    ]);
    const content = await readFile(
      join(verifyDir, "lib", "new-file.ts"),
      "utf8",
    );
    expect(content).toBe("export const x = 1;\n");

    const log = execFileSync("git", ["log", "-1", "--format=%s%n%b"], {
      cwd: verifyDir,
      encoding: "utf8",
    });
    expect(log).toContain("Implement #6");
    expect(log).toContain("Closes #6");
  });

  it("force-pushes cleanly on a re-run against an already-existing remote branch (idempotent re-dispatch)", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.endsWith("/issues/6")) {
        return jsonResponse({ title: "[F1-S3] Implement workflow" });
      }
      if (method === "GET" && url.includes("/pulls?head=")) {
        return jsonResponse([
          { number: 50, html_url: "https://github.com/o/r/pull/50" },
        ]);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // First run.
    await main();
    expect(process.exitCode).toBeUndefined();

    // Reset the local clone back to a clean main-only state, as a fresh
    // actions/checkout would give the publish job on a re-dispatch, then
    // run again.
    process.chdir(originalCwd);
    const secondCloneDir = join(scratchDir, "local2");
    execFileSync("git", ["clone", "-q", bareRemoteDir, secondCloneDir]);
    git(secondCloneDir, ["checkout", "main"]);
    git(secondCloneDir, ["config", "user.name", "Test"]);
    git(secondCloneDir, ["config", "user.email", "test@example.com"]);
    process.chdir(secondCloneDir);

    await main();

    expect(process.exitCode).toBeUndefined();
    const branches = execFileSync(
      "git",
      ["branch", "--list", "feature/6-implement-workflow"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(branches).toContain("feature/6-implement-workflow");
  });
});
