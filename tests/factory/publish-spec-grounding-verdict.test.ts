import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { formatUncaughtErrorForLog, main } from "../../scripts/factory/publish-spec-grounding-verdict.mts";
import { SPEC_GROUNDING_SUMMARY_COMMENT_MARKER } from "../../scripts/factory/publish-spec-grounding-verdict-logic.mts";

/**
 * Integration-style tests for the privileged CLI entrypoint (slice d4 —
 * summary AND inline blocker posting, with the 422 probe-then-degrade;
 * see the module's own top-level docstring): stub `fetch`, drive
 * `main()` through env vars + temp artifact files, matching
 * `apply-triage-verdict.test.ts`'s own established pattern for the
 * sibling privileged entrypoint.
 */

const TRUSTED_HEAD_SHA = "headsha000000000000000000000000000000000";
const TRUSTED_BASE_SHA = "basesha000000000000000000000000000000000";

/** A unified diff with exactly one addable line -- resolves to a real anchor. */
const DIFF_WITH_ANCHOR = [
  "diff --git a/scripts/factory/foo.mts b/scripts/factory/foo.mts",
  "+++ b/scripts/factory/foo.mts",
  "@@ -1,1 +1,2 @@",
  " context",
  "+added",
].join("\n");

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

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

let workdir: string;

const VALID_VERDICT = { findings: [{ criterionId: "12:0", satisfied: false, rationale: "Missing the retry wrapper." }] };
const VALID_SPINE = {
  entries: [{ issueNumber: 12, kind: "closing", criterionId: "12:0" }],
  truncated: false,
  unreviewedClosingIssues: [],
  diffTruncated: false,
};

async function writeArtifacts(
  dir: string,
  overrides: { outcome?: unknown; verdict?: unknown; spine?: unknown } = {},
): Promise<{ outcomePath: string; verdictPath: string; spinePath: string }> {
  const outcomePath = join(dir, "outcome.json");
  const verdictPath = join(dir, "verdict.json");
  const spinePath = join(dir, "spine.json");
  await writeFile(outcomePath, JSON.stringify(overrides.outcome ?? { hasCriteria: true }));
  await writeFile(verdictPath, JSON.stringify(overrides.verdict ?? VALID_VERDICT));
  await writeFile(spinePath, JSON.stringify(overrides.spine ?? VALID_SPINE));
  return { outcomePath, verdictPath, spinePath };
}

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "spec-grounding-verdict-"));
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "syamaner/roastpilot-cloud";
  process.env.TRUSTED_PR_NUMBER = "83";
  process.env.TRUSTED_HEAD_SHA = TRUSTED_HEAD_SHA;
  process.env.SPEC_GROUNDED_REVIEW_JOB_RESULT = "success";
  process.exitCode = undefined;
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.TRUSTED_PR_NUMBER;
  delete process.env.TRUSTED_HEAD_SHA;
  delete process.env.SPEC_GROUNDED_REVIEW_JOB_RESULT;
  delete process.env.OUTCOME_PATH;
  delete process.env.CRITERIA_SPINE_PATH;
  delete process.env.VERDICT_PATH;
  process.exitCode = undefined;
});

/** Standard PR-identity fetch handler, matching the trusted head SHA set in beforeEach. */
function prFetchHandler() {
  return jsonResponse({ head: { sha: TRUSTED_HEAD_SHA }, base: { sha: TRUSTED_BASE_SHA } });
}

describe("main — the three-way job-result gate", () => {
  it.each(["skipped", "cancelled"])(
    "silently no-ops on a %s job result, without any fetch call at all",
    async (result) => {
      process.env.SPEC_GROUNDED_REVIEW_JOB_RESULT = result;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await main();

      expect(process.exitCode).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("posts a visible fallback and exits nonzero on a failure job result", async () => {
    process.env.SPEC_GROUNDED_REVIEW_JOB_RESULT = "failure";
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain('job result was "failure"');
  });

  it("treats an unexpected job-result value the same as failure (fail closed, not silently ignored)", async () => {
    process.env.SPEC_GROUNDED_REVIEW_JOB_RESULT = "some-unexpected-value";
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain('"some-unexpected-value"');
  });

  it("throws when SPEC_GROUNDED_REVIEW_JOB_RESULT is missing entirely (bad workflow wiring)", async () => {
    delete process.env.SPEC_GROUNDED_REVIEW_JOB_RESULT;
    await expect(main()).rejects.toThrow(/SPEC_GROUNDED_REVIEW_JOB_RESULT/);
  });
});

describe("main — the outcome.json tri-state", () => {
  it("posts a visible fallback and exits nonzero when outcome.json is absent despite a successful job result", async () => {
    process.env.OUTCOME_PATH = join(workdir, "does-not-exist.json");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("outcome.json not found");
  });

  it("posts a visible fallback when outcome.json is malformed (wrong shape)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: "not-a-boolean" }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain('must be exactly {"hasCriteria": boolean}');
  });

  it("posts a visible fallback when outcome.json exists but isn't valid JSON", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, "{ not json");
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("outcome.json at");
    expect((post?.body as { body: string }).body).toContain("not valid JSON");
  });

  it("posts a visible fallback when the outcome.json path exists but cannot actually be read as a file (CodeQL js/file-system-race fold: readArtifactFile now opens by file descriptor, not by stat-then-read-by-path -- a directory at that path opens successfully but fails on the subsequent read, EISDIR)", async () => {
    // OUTCOME_PATH points at a DIRECTORY, not a file -- `open` alone does
    // NOT fail for a directory, only the subsequent `readFile` does
    // (EISDIR), exercising the read-time wrapped-error branch.
    process.env.OUTCOME_PATH = workdir;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    // Opening a directory with the "r" flag does not itself fail on
    // Linux/macOS -- only the subsequent read does (EISDIR), exercising
    // the read-time wrapped-error branch rather than the open-time one.
    expect((post?.body as { body: string }).body).toContain("could not be read");
  });

  it("posts a visible fallback when the outcome.json path cannot be OPENED for a reason other than not existing (a non-directory component in the path, ENOTDIR)", async () => {
    // A REGULAR FILE sits where a directory component is expected, so
    // `open` itself fails with ENOTDIR -- distinct from the EISDIR case
    // above, which fails on the READ, not the open.
    const regularFilePath = join(workdir, "not-a-directory");
    await writeFile(regularFilePath, "x");
    process.env.OUTCOME_PATH = join(regularFilePath, "outcome.json");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("could not be opened");
  });

  it("is a genuine no-op when hasCriteria is false and there is no prior spec-grounding state to clear (PATCH/POST/DELETE-free, only the read-only lookups)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("clears a prior summary comment AND prior inline blocker comments when hasCriteria is false but earlier state exists (PR #86 review, Codex, P2)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 55,
            body: `stale summary\n<!-- roastpilot-factory:spec-grounding-summary:do-not-edit -->`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/55": () => jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 77,
            body: `stale blocker\n<!-- roastpilot-factory:spec-grounding-blocker:criterion:12:0:do-not-edit -->`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/77": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toMatch(/no linked-issue acceptance criteria remain/i);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/comments/77"))).toBe(true);
  });

  it("posts a visible fallback, rather than crashing or silently no-opping, when clearing stale state genuinely fails", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false }));
    process.env.OUTCOME_PATH = outcomePath;
    // The summary-comment lookup 403s exactly ONCE (clearStaleSpecGroundingSummary's
    // own check) -- publishFallback's own subsequent lookup, in the catch
    // block, must still succeed so the fallback comment can genuinely post.
    let summaryLookupCalls = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => {
        summaryLookupCalls += 1;
        return summaryLookupCalls === 1
          ? new Response("rate limited", { status: 403, headers: { "content-type": "text/plain" } })
          : jsonResponse([]);
      },
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const fallbackPost = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    expect(fallbackPost).toBeDefined();
    expect((fallbackPost?.body as { body: string }).body).toMatch(/clearing its prior spec-grounding state failed/i);
  });
});

describe("main — hasCriteria: true, verdict/spine reading", () => {
  it("posts a visible fallback when the verdict artifact is absent", async () => {
    const { outcomePath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    process.env.VERDICT_PATH = join(workdir, "does-not-exist.json");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("verdict was not found");
  });

  it("posts a visible fallback listing EVERY schema validation error when the verdict is malformed", async () => {
    const { outcomePath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "bad-shape", satisfied: "not-a-bool", rationale: "" }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    process.env.VERDICT_PATH = join(workdir, "verdict.json");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("verdict validation:");
  });

  it("REJECTS a verdict artifact containing a malformed UTF-8 byte via the parser's own isUtf8 check, rather than silently U+FFFD-decoding and accepting it (PR #86 review round 2, Codex -- the read<->parser UTF-8 seam: readArtifactFile must hand the parser a raw Buffer, never a pre-decoded string)", async () => {
    const { outcomePath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const verdictPath = join(workdir, "verdict.json");
    // 0xFF is never a valid UTF-8 byte in ANY position -- a JS string
    // literal can't express this directly (strings are always valid
    // UTF-16/scalar values), so the raw malformed bytes are written to
    // disk directly, bypassing writeArtifacts' own JSON.stringify.
    await writeFile(verdictPath, Buffer.from([0x7b, 0xff, 0x7d]));
    process.env.VERDICT_PATH = verdictPath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toMatch(/not valid UTF-8/i);
  });

  it("posts a visible fallback when criteria-spine.json is absent", async () => {
    const { outcomePath, verdictPath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = join(workdir, "does-not-exist.json");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("criteria-spine.json was not found");
  });

  it("posts a visible fallback when criteria-spine.json fails shape validation", async () => {
    const { outcomePath, verdictPath } = await writeArtifacts(workdir, {
      spine: { entries: "not-an-array", truncated: false, unreviewedClosingIssues: [], diffTruncated: false },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = join(workdir, "spine.json");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("criteria-spine.json validation:");
  });

  it("REJECTS a criteria-spine.json artifact containing a malformed UTF-8 byte via the parser's own isUtf8 check, rather than silently U+FFFD-decoding and accepting it (PR #86 review round 2, Codex -- the read<->parser UTF-8 seam)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    // 0xFF is never a valid UTF-8 byte in ANY position -- overwrite the
    // otherwise-valid spine file with raw malformed bytes directly.
    await writeFile(spinePath, Buffer.from([0x7b, 0xff, 0x7d]));
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toMatch(/not valid UTF-8/i);
  });
});

describe("main — the happy path", () => {
  it("posts a clean summary and exits zero when every criterion is satisfied", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("No blocking findings.");
    expect((post?.body as { body: string }).body).toContain(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER);
  });

  it("posts the sole blocker as a REAL inline comment and exits ZERO when a real anchor exists -- the healthy path, gated by required_conversation_resolution on the thread itself, not this job's own exit code", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => jsonResponse({ id: 1 }, 201),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const inlinePost = calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"));
    expect(inlinePost).toBeDefined();
    expect(inlinePost?.body).toEqual({
      body: expect.stringContaining("Missing the retry wrapper."),
      commit_id: TRUSTED_HEAD_SHA,
      path: "scripts/factory/foo.mts",
      line: 2,
      side: "RIGHT",
    });
    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    expect(summaryBody).toContain("1 blocking finding(s)");
    expect(summaryBody).toMatch(/reported as separate, resolvable inline review comment/i);
    expect(summaryBody).not.toMatch(/listed below in THIS summary/i);
  });

  it("degrades to the fallback summary and exits nonzero when the diff has NO addable line at all (anchorFallbackNeeded, structural)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("1 blocking finding(s)");
    expect(body).toMatch(/listed below in THIS summary/i);
    expect(body).toContain("Missing the retry wrapper.");
    expect(body).toMatch(/could not be posted as inline comments/i);
  });

  it("degrades to the fallback summary and exits nonzero when the FIRST inline POST is rejected with a 422 (the probe-then-degrade, not a genuine error)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () =>
        new Response("Unprocessable Entity", { status: 422 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const body = (summaryPost?.body as { body: string }).body;
    expect(body).toContain("1 blocking finding(s)");
    expect(body).toMatch(/listed below in THIS summary/i);
    expect(body).toContain("Missing the retry wrapper.");
    // A graceful degrade, NOT the "pipeline broke" fallback wording --
    // the summary itself was still built and posted successfully.
    expect(body).not.toMatch(/could not run to completion/i);
  });

  it("posts a 'pipeline broke'-style visible fallback and exits nonzero when the PR's current head SHA no longer matches the trusted event SHA", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        jsonResponse({ head: { sha: "some-other-sha-the-pr-moved-to" }, base: { sha: TRUSTED_BASE_SHA } }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/does not match the trusted event head SHA/i);
  });

  it("propagates a NON-first inline-posting failure as a genuine error -- visible fallback, not a silent degrade", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "First unmet criterion." },
          { criterionId: "12:1", satisfied: false, rationale: "Second unmet criterion." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 12, kind: "closing", criterionId: "12:1" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    let postCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => {
        postCount += 1;
        return postCount === 1
          ? jsonResponse({ id: 1 }, 201)
          : new Response("forbidden", { status: 403 });
      },
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const body = (summaryPost?.body as { body: string }).body;
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/403/);
  });

  it("throws when TRUSTED_HEAD_SHA is missing entirely (bad workflow wiring)", async () => {
    delete process.env.TRUSTED_HEAD_SHA;
    await expect(main()).rejects.toThrow(/TRUSTED_HEAD_SHA/);
  });

  it("counts the whole-run diff-truncation blocker when the diff was truncated and this run has a closing-kind reference -- even when every JOINED criterion is satisfied", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Looks present, but the diff was cut short." }] },
      spine: {
        entries: [{ issueNumber: 12, kind: "closing", criterionId: "12:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: true,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("1 blocking finding(s)");
    expect(body).toMatch(/this pr's own diff was truncated/i);
  });

  it("edits the existing summary comment instead of posting a duplicate on re-run", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Fixed." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 555,
            body: `prior summary\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/555": () => jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/comments"));
    expect(post).toBeUndefined();
  });

  it("does NOT post over a different bot's comment carrying the marker as a substring (structural-marker match, not a loose .includes())", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Fixed." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 777,
            body: `some other feature's comment embedding ${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER} mid-line`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 900 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/comments"))).toBe(true);
  });

  it("finds a prior summary comment on page 2 (>100 comments) instead of double-posting", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Fixed." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      body: `unrelated human comment ${i}`,
      user: { type: "User", login: "someone" },
    }));
    const page2 = [
      {
        id: 999,
        body: `prior summary\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`,
        user: { type: "Bot", login: "github-actions[bot]" },
      },
    ];
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse(page1),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=2": () => jsonResponse(page2),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/999": () => jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
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

  it("rejects an oversized verdict artifact via stat, before ever reading its contents into memory", async () => {
    const { outcomePath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const verdictPath = join(workdir, "huge-verdict.json");
    await writeFile(verdictPath, "x".repeat(8_000_001));
    process.env.VERDICT_PATH = verdictPath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("exceeds the 8000000-byte limit");
  });

  it("rejects an oversized criteria-spine.json artifact via stat, before ever reading its contents into memory", async () => {
    const { outcomePath, verdictPath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    const spinePath = join(workdir, "huge-spine.json");
    await writeFile(spinePath, "x".repeat(4_000_001));
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("exceeds the 4000000-byte limit");
  });

  it("surfaces a GitHub API error response with status and body", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Fixed." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const fetchMock = vi.fn(
      async () => new Response("rate limited", { status: 403, headers: { "content-type": "text/plain" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/403/);
  });
});

describe("formatUncaughtErrorForLog", () => {
  it("prefers an Error's own stack over its message alone, neutralized", () => {
    const err = new Error("boom");
    const formatted = formatUncaughtErrorForLog(err);
    expect(formatted).toContain("boom");
    // Real Error.stack starts with "Error: <message>" on its own first line.
    expect(formatted).toContain("Error: boom");
  });

  it("stringifies a non-Error value thrown as the uncaught rejection", () => {
    expect(formatUncaughtErrorForLog("a plain string rejection")).toBe("a plain string rejection");
    expect(formatUncaughtErrorForLog(42)).toBe("42");
  });

  it("falls back to err.message when a genuinely stack-less Error reaches it (defensive -- a real Error's own .stack is virtually always present, but not a runtime guarantee)", () => {
    const err = new Error("boom without a stack");
    err.stack = undefined;
    expect(formatUncaughtErrorForLog(err)).toBe("boom without a stack");
  });

  it("neutralizes a workflow-command injection attempt transitively carried in an Error's own message (e.g. a GithubApiError echoing a raw API response body)", () => {
    const err = new Error('request failed: {"message":"bad"}\n::error title=spoofed::message');
    const formatted = formatUncaughtErrorForLog(err);
    expect(formatted).not.toMatch(/\n::error/);
    expect(formatted).not.toContain("::");
  });
});
