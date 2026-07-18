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
 * Covers only the rejection paths that happen BEFORE any `git` command is
 * ever invoked (env validation, job-result gate, missing/oversized patch
 * artifact) — `execFileSync` stays mocked and unused for these, and each
 * test asserts it. Everything that depends on git's actual `--numstat`/
 * `--summary` output (the patch-path guard, valid-patch application,
 * idempotency, and the exploit-reproduction cases) is deliberately NOT
 * mocked here — `publish-implement-patch.real-git.test.ts` runs those
 * against a real repository instead, for exactly the reason this guard
 * was rewritten: don't trust an assumption about what git's output looks
 * like when you can just ask git.
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

describe("main — input validation", () => {
  it("throws when GITHUB_REPOSITORY is not owner/repo", async () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo-string";
    await expect(main()).rejects.toThrow(/owner\/repo/);
  });
});

describe("main — fail-closed paths that never reach git (no branch, no PR, one comment)", () => {
  it("rejects a FAILED implement job without ever reading the patch or calling git", async () => {
    process.env.IMPLEMENT_JOB_RESULT = "failure";
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
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
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
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

  it("rejects an oversized patch artifact before ever invoking git", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, "x".repeat(3 * 1024 * 1024));
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
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
});

describe("main — IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN (factory.md §13 publisher-identity switch)", () => {
  afterEach(() => {
    delete process.env.IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN;
  });

  it("PATCHes the prior comment when it was authored by the configured login", async () => {
    process.env.IMPLEMENT_JOB_RESULT = "failure";
    process.env.IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN = "roastpilot-factory[bot]";

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 42,
            body: "prior failure\n\n<!-- roastpilot-factory:implement-failure:do-not-edit -->",
            user: { type: "Bot", login: "roastpilot-factory[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/42": () => jsonResponse({}, 200),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toContain('implement job result was "failure"');
  });

  it("does NOT match a prior comment authored by a different login than configured (no cross-identity edit)", async () => {
    process.env.IMPLEMENT_JOB_RESULT = "failure";
    process.env.IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN = "roastpilot-factory[bot]";

    const { fetchMock, calls } = mockFetch({
      // The prior comment is from the OLD (GITHUB_TOKEN) identity — a
      // publisher-identity switch must not silently adopt/edit a comment
      // posted under the previous identity; it posts a fresh one instead.
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 42,
            body: "prior failure\n\n<!-- roastpilot-factory:implement-failure:do-not-edit -->",
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () => jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
