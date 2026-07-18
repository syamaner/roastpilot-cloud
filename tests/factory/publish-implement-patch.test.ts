import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const { main } = await import("../../scripts/factory/publish-implement-patch.mts");

/**
 * Mocked-git-plumbing tests: `execFileSync` never actually runs `git`
 * here, so these cover validation/rejection logic, the idempotency
 * pre-check, and that git is called with the right arguments — NOT that
 * `git apply`/`commit`/`push` genuinely work together, which
 * `publish-implement-patch.real-git.test.ts` proves against a real
 * temporary repository instead.
 */

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function mockFetch(
  handlers: Record<string, (call: FetchCall) => Response>,
): { fetchMock: ReturnType<typeof vi.fn>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url.replace("https://api.github.com", "")}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`unexpected fetch call: ${key}`);
    }
    return handler({ url, method, body });
  });
  return { fetchMock, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_DIFF = `diff --git a/lib/new-file.ts b/lib/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/lib/new-file.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;

const FORBIDDEN_DIFF = `diff --git a/.github/workflows/evil.yml b/.github/workflows/evil.yml
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/.github/workflows/evil.yml
@@ -0,0 +1,1 @@
+on: push
`;

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "publish-patch-"));
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "syamaner/roastpilot-cloud";
  process.env.TRUSTED_ISSUE_NUMBER = "6";
  process.env.IMPLEMENT_JOB_RESULT = "success";
  process.env.RUN_URL = "https://github.com/o/r/actions/runs/1";
  process.exitCode = undefined;
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockImplementation(() => Buffer.from(""));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.TRUSTED_ISSUE_NUMBER;
  delete process.env.IMPLEMENT_JOB_RESULT;
  delete process.env.RUN_URL;
  delete process.env.PATCH_PATH;
  process.exitCode = undefined;
});

describe("main — valid patch path", () => {
  it("applies the patch, pushes, and opens a new PR when none exists", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6": () =>
        jsonResponse({ title: "[F1-S3] Implement workflow" }),
      "GET /repos/syamaner/roastpilot-cloud/pulls?head=syamaner:feature/6-implement-workflow&state=open":
        () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls": () =>
        jsonResponse(
          { number: 99, html_url: "https://github.com/o/r/pull/99" },
          201,
        ),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const create = calls.find((c) => c.method === "POST");
    expect(create).toBeDefined();
    const body = create!.body as { title: string; head: string; base: string; body: string };
    expect(body.head).toBe("feature/6-implement-workflow");
    expect(body.base).toBe("main");
    expect(body.body).toContain("Closes #6");
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "git",
      ["checkout", "-b", "feature/6-implement-workflow"],
      expect.anything(),
    );
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "git",
      ["apply", patchPath],
      expect.anything(),
    );
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "git",
      ["push", "--force", "origin", "feature/6-implement-workflow"],
      expect.anything(),
    );
  });

  it("does not create a duplicate PR when one already exists for the branch (idempotency)", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6": () =>
        jsonResponse({ title: "[F1-S3] Implement workflow" }),
      "GET /repos/syamaner/roastpilot-cloud/pulls?head=syamaner:feature/6-implement-workflow&state=open":
        () =>
          jsonResponse([
            { number: 50, html_url: "https://github.com/o/r/pull/50" },
          ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    // The branch is still pushed (refreshing the existing PR's diff).
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "git",
      ["push", "--force", "origin", "feature/6-implement-workflow"],
      expect.anything(),
    );
  });
});

describe("main — input validation", () => {
  it("throws when GITHUB_REPOSITORY is not owner/repo", async () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo-string";
    await expect(main()).rejects.toThrow(/owner\/repo/);
  });
});

describe("main — fail-closed paths (no branch, no PR, one comment)", () => {
  it("rejects a FAILED implement job without ever reading the patch or calling git", async () => {
    process.env.IMPLEMENT_JOB_RESULT = "failure";
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      'implement job result was "failure"',
    );
  });

  it("rejects a missing patch artifact", async () => {
    process.env.PATCH_PATH = join(workdir, "does-not-exist.diff");

    const { fetchMock, calls } = mockFetch({
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      "patch artifact not found",
    );
  });

  it("rejects an oversized patch artifact before reading its content", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, "x".repeat(3 * 1024 * 1024));
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      "exceeds the 2097152-byte limit",
    );
  });

  it("rejects an empty diff (implement made no changes)", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, "");
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      "produced no changes",
    );
  });

  it("rejects a patch that touches a pipeline-protected path, without ever calling git", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, FORBIDDEN_DIFF);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      ".github/workflows/evil.yml",
    );
  });

  it("rejects a patch touching the privileged glue scripts (scripts/factory/**), not just .github/**", async () => {
    const diff = `diff --git a/scripts/factory/publish-implement-patch.mts b/scripts/factory/publish-implement-patch.mts
--- a/scripts/factory/publish-implement-patch.mts
+++ b/scripts/factory/publish-implement-patch.mts
@@ -1 +1 @@
-x
+y
`;
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, diff);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      "scripts/factory/publish-implement-patch.mts",
    );
  });

  it("posts a generic failure comment when git apply throws unexpectedly (patch validated but doesn't apply cleanly)", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;

    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === "apply") {
        throw new Error("patch does not apply");
      }
      return Buffer.from("");
    });

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6": () =>
        jsonResponse({ title: "[F1-S3] Implement workflow" }),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      "unexpected error",
    );
    expect((comment?.body as { body: string }).body).toContain(
      "patch does not apply",
    );
  });
});
