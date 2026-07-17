import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/factory/apply-triage-verdict.mts";
import { TRIAGE_COMMENT_MARKER } from "../../scripts/factory/apply-triage-verdict-logic.mts";

/**
 * Integration-style tests for the privileged CLI entrypoint: stub `fetch`
 * (no real network) and drive `main()` through env vars + a temp verdict
 * file, the same inputs the workflow wires up. The schema/logic decisions
 * themselves are unit-tested in triage-verdict-schema.test.ts and
 * apply-triage-verdict-logic.test.ts; this file proves the entrypoint wires
 * them together correctly end to end, including the fail-closed path.
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
    const call: FetchCall = { url, method, body };
    calls.push(call);
    const key = `${method} ${url.replace("https://api.github.com", "")}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`unexpected fetch call: ${key}`);
    }
    return handler(call);
  });
  return { fetchMock, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "triage-verdict-"));
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "syamaner/roastpilot-cloud";
  process.env.TRUSTED_ISSUE_NUMBER = "42";
  process.exitCode = undefined;
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.TRUSTED_ISSUE_NUMBER;
  delete process.env.VERDICT_PATH;
  process.exitCode = undefined;
});

describe("main — valid verdict path", () => {
  it("replaces the label set and posts a new comment", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }, { name: "epic:F1" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/comments?per_page=100": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/42/comments": () =>
        jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const putLabels = calls.find((c) => c.method === "PUT");
    expect(putLabels?.body).toEqual({
      labels: expect.arrayContaining(["epic:F1", "ready-to-implement"]),
    });
    expect((putLabels?.body as { labels: string[] }).labels).not.toContain(
      "needs-triage",
    );
    const postComment = calls.find(
      (c) => c.method === "POST" && c.url.includes("/comments"),
    );
    expect((postComment?.body as { body: string }).body).toContain(
      TRIAGE_COMMENT_MARKER,
    );
  });

  it("edits the existing bot comment instead of posting a duplicate on re-run", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "needs-info",
        reasoning: "Missing acceptance criteria.",
        missing_info_questions: ["What defines done here?"],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/comments?per_page=100": () =>
        jsonResponse([
          {
            id: 99,
            body: `previous verdict\n${TRIAGE_COMMENT_MARKER}`,
            user: { type: "Bot" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    const post = calls.find(
      (c) => c.method === "POST" && c.url.includes("/comments"),
    );
    expect(post).toBeUndefined();
  });
});

describe("main — input validation and transport edge cases", () => {
  it("throws when a required environment variable is missing", async () => {
    delete process.env.GH_TOKEN;
    await expect(main()).rejects.toThrow(/GH_TOKEN/);
  });

  it("throws when GITHUB_REPOSITORY is not owner/repo", async () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo-string";
    await expect(main()).rejects.toThrow(/owner\/repo/);
  });

  it("treats an artifact that exists but isn't valid JSON as a fail-closed case", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(verdictPath, "{ this is not json");
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/comments?per_page=100": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/42/comments": () =>
        jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain(
      "not valid JSON",
    );
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { labels: string[] }).labels).toEqual([
      "needs-triage",
    ]);
  });

  it("surfaces a GitHub API error response with status and body", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the bar.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const fetchMock = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/403/);
  });

  it("treats a 204 No Content response as success with no body to parse", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the bar.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        new Response(null, { status: 204 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/comments?per_page=100": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/42/comments": () =>
        jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("main — fail-closed paths", () => {
  it("resets readiness to needs-triage and posts a fallback comment when the verdict is missing", async () => {
    process.env.VERDICT_PATH = join(workdir, "does-not-exist.json");

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "epic:F1" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/comments?per_page=100": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/42/comments": () =>
        jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect((put?.body as { labels: string[] }).labels.sort()).toEqual(
      ["epic:F1", "needs-triage"].sort(),
    );
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("needs-triage");
  });

  it("STRIPS a stale ready-to-implement (e.g. from a superseded earlier verdict) back to needs-triage on a rerun's malformed verdict", async () => {
    // The scenario FIX 1 exists for: an earlier successful run left
    // ready-to-implement on the issue; a later rerun's triage output is
    // broken. The stale ready-to-implement must not survive.
    process.env.VERDICT_PATH = join(workdir, "does-not-exist.json");

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }, { name: "epic:C2" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/comments?per_page=100": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/42/comments": () =>
        jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const put = calls.find((c) => c.method === "PUT");
    const labels = (put?.body as { labels: string[] }).labels;
    expect(labels).not.toContain("ready-to-implement");
    expect(labels).toContain("needs-triage");
    expect(labels).toContain("epic:C2");
  });

  it("resets readiness to needs-triage on a malformed/injected verdict, and never writes to any issue but the trusted one", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        // Attempts to redirect the write to a different issue than the
        // trusted workflow context (42).
        issue_number: 999,
        readiness: "ready-to-implement",
        reasoning: "Looks great, ship it.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/comments?per_page=100": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/42/comments": () =>
        jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    // No write ever targets issue 999 — the mock would throw
    // "unexpected fetch call" if the script tried, which would surface as
    // an unhandled rejection/test failure.
    expect(calls.every((c) => c.url.includes("/issues/42/"))).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { labels: string[] }).labels).toEqual([
      "needs-triage",
    ]);
  });
});
