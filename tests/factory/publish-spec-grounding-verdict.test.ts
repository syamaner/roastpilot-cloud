import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { formatUncaughtErrorForLog, main } from "../../scripts/factory/publish-spec-grounding-verdict.mts";
import { SPEC_GROUNDING_SUMMARY_COMMENT_MARKER } from "../../scripts/factory/publish-spec-grounding-verdict-logic.mts";
import {
  criterionBlockerCommentMarker,
  inlineBlockerGenerationMarker,
} from "../../scripts/factory/publish-spec-grounding-blocker-logic.mts";

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
  reviewedClosingIssueNumbers: [12],
  reviewedBaseSha: TRUSTED_BASE_SHA,
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
  process.env.GITHUB_RUN_NUMBER = "1";
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
  delete process.env.GITHUB_RUN_NUMBER;
  delete process.env.SPEC_GROUNDED_REVIEW_JOB_RESULT;
  delete process.env.OUTCOME_PATH;
  delete process.env.CRITERIA_SPINE_PATH;
  delete process.env.VERDICT_PATH;
  process.exitCode = undefined;
});

/** Standard PR-identity fetch handler, matching the trusted head SHA set in beforeEach. */
function prFetchHandler() {
  return jsonResponse({ head: { sha: TRUSTED_HEAD_SHA }, base: { sha: TRUSTED_BASE_SHA }, body: null });
}

/**
 * Sibling of {@link prFetchHandler} with explicit overrides (PR #87
 * review round 3, Codex, P1, TOCTOU fold) so a test can simulate the PR
 * having moved (`headSha`) or gained a new closing reference (`body`)
 * since the read-only runner ran -- both inputs {@link
 * isStillSafeToDeleteInlineBlockerThreads}'s own revalidation re-checks.
 * A separate function (not an optional param on `prFetchHandler` itself)
 * so every existing bare `prFetchHandler` usage (passed directly as a
 * mockFetch handler) keeps its own simple, argument-free signature.
 */
function prFetchHandlerWithOverrides(overrides: { headSha?: string; body?: string | null }): Response {
  return jsonResponse({
    head: { sha: overrides.headSha ?? TRUSTED_HEAD_SHA },
    base: { sha: TRUSTED_BASE_SHA },
    body: overrides.body ?? null,
  });
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
    expect((post?.body as { body: string }).body).toContain('must be shaped {"hasCriteria": boolean, ...}');
  });

  it("posts a visible fallback when outcome.json has hasCriteria:true but ALSO carries a noCriteriaReason field (never expected there, PR #87 review, Codex, P1/medium fold)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: true, noCriteriaReason: "no-references" }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain('must be exactly {"hasCriteria": true}');
  });

  it("posts a visible fallback when outcome.json has hasCriteria:false but carries an unexpected extra field beyond noCriteriaReason (PR #87 review, Codex, P1/medium fold)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", extra: "hack" }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("carries unexpected field(s) (extra)");
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
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references" }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("reason=no-references: clears a prior summary comment AND prior inline blocker comments when hasCriteria is false but earlier state exists (PR #86 review, Codex, P2)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references" }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
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
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/issues/comments/"));
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toMatch(/no longer references any issue/i);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/comments/77"))).toBe(true);
  });

  it("reason=no-references BUT the PR moved (head SHA no longer matches trusted) since the review ran: degrades to the non-destructive path, never deletes (PR #87 review round 3, Codex, P1, gate-integrity TOCTOU)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references" }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ headSha: "differentsha0000000000000000000000000000" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 55,
            body: `stale summary\n<!-- roastpilot-factory:spec-grounding-summary:do-not-edit -->`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/55": () => jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/issues/comments/"));
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toMatch(/own state changed/i);
    expect((patch?.body as { body: string }).body).toMatch(/left in place/i);
    // The inline blocker comments endpoint is NEVER even fetched, let
    // alone anything DELETEd -- the revalidation failed BEFORE the
    // destructive path was ever reached.
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reason=no-references BUT the PR's CURRENT body now shows a closing reference (added after the review ran, head SHA unchanged): degrades to the non-destructive path, never deletes (PR #87 review round 3, Codex, P1, gate-integrity TOCTOU)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references" }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      // Same head SHA as trusted (a body-only edit never bumps it), but
      // the body NOW carries a real closing reference the runner never saw.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 55,
            body: `stale summary\n<!-- roastpilot-factory:spec-grounding-summary:do-not-edit -->`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/55": () => jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/issues/comments/"));
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toMatch(/own state changed/i);
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reason=no-unmet-criteria: updates the summary with the self-attested caveat but LEAVES inline blocker threads untouched -- deleting a required_conversation_resolution-gating thread on a self-attested, non-diff-verified signal would be an anti-gaming hole (PR #87 review, Codex, P1/medium fold)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-unmet-criteria" }));
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
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/issues/comments/"));
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toMatch(/self-attested/i);
    expect((patch?.body as { body: string }).body).toMatch(/left in place/i);
    // The inline blocker comments endpoint is NEVER even fetched -- this
    // reason never attempts to clear that channel at all.
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("an unknown/missing noCriteriaReason on a false outcome.json FAILS CLOSED to the non-destructive treatment -- never deletes inline blocker threads on a signal it could not confirm (PR #87 review, Codex, P1/medium fold)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    // Deliberately missing noCriteriaReason -- a malformed/stale-runner
    // artifact this entrypoint cannot positively confirm as no-references.
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("posts a visible fallback, rather than crashing or silently no-opping, when clearing stale state genuinely fails", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references" }));
    process.env.OUTCOME_PATH = outcomePath;
    // The summary-comment lookup 403s exactly ONCE (clearStaleSpecGroundingSummary's
    // own check) -- publishFallback's own subsequent lookup, in the catch
    // block, must still succeed so the fallback comment can genuinely post.
    let summaryLookupCalls = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
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
      spine: {
        entries: "not-an-array",
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
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
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
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

  it("does NOT post a stale all-clear on the ZERO-blocker path when the PR's current head SHA no longer matches the trusted event SHA -- verifies the trusted head on EVERY hasCriteria:true publish, not just when there are blockers to post inline (PR #87 review round 7, Codex, medium, fail-open close)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
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
    // The FALLBACK wording, never the stale "No blocking findings" all-clear.
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/failed to verify this pr's current head sha/i);
    expect(body).toMatch(/does not match the trusted event head SHA/i);
  });

  it("posts the sole blocker as a REAL inline comment and exits ZERO when a real anchor exists -- the healthy path, gated by required_conversation_resolution on the thread itself, not this job's own exit code", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
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

  it("embeds this run's own GITHUB_RUN_NUMBER as the generation marker in a REAL posted inline blocker comment (F1-S9 slice 90.3, end-to-end -- workflow env through to the actual posted body)", async () => {
    process.env.GITHUB_RUN_NUMBER = "9999";
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => jsonResponse({ id: 1 }, 201),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const inlinePost = calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"));
    const inlineBody = (inlinePost?.body as { body: string }).body;
    expect(inlineBody).toContain("<!-- roastpilot-factory:spec-grounding-blocker:generation:9999:do-not-edit -->");
  });

  it("PATCHes (never re-posts) a PRIOR run's own inline blocker comment when this run's own GENERATION differs from that comment's -- the generation marker never affects the existing find/upsert-by-identity-marker match (F1-S9 slice 90.3's own core AC)", async () => {
    process.env.GITHUB_RUN_NUMBER = "2";
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    // Simulates a PRIOR run's own already-posted comment: same identity
    // marker (criterion 12:0), but generation:1 (an EARLIER run).
    const priorRunBody = [
      "**Blocking: unmet acceptance criterion on issue #12**",
      "",
      "Some earlier rationale.",
      "",
      criterionBlockerCommentMarker("12:0"),
      inlineBlockerGenerationMarker("1"),
    ].join("\n");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          { id: 77, body: priorRunBody, user: { type: "Bot", login: "github-actions[bot]" } },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/77": () => jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    // No new inline comment POST at all -- the existing one was found (by
    // its own unchanged identity marker) and PATCHed in place, exactly
    // the pre-90.3 behavior for a re-run.
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"))).toBe(false);
    const patch = calls.find((c) => c.method === "PATCH" && c.url.endsWith("/pulls/comments/77"));
    expect(patch).toBeDefined();
    const patchedBody = (patch?.body as { body: string }).body;
    // The identity marker is unchanged; the generation marker now reads
    // THIS run's own (newer) value, replacing the prior run's.
    expect(patchedBody).toContain(criterionBlockerCommentMarker("12:0"));
    expect(patchedBody).toContain(inlineBlockerGenerationMarker("2"));
    expect(patchedBody).not.toContain(inlineBlockerGenerationMarker("1"));
  });

  it("skips posting an inline comment for a blocker whose issue is NO LONGER referenced in the PR's CURRENT body (a body-only edit removed it since the review ran), posting the still-referenced blocker normally and noting the skip in the summary, in ascending issue-number order regardless of the runner's own ordering (PR #87 review round 4, Codex, P1 -- symmetric to the delete-path TOCTOU fold)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "Still-live blocker." },
          // Deliberately out of ascending order (99 before 34) -- exercises
          // the stale-issue-number sort, not just a single-element no-op.
          { criterionId: "99:0", satisfied: false, rationale: "Stale blocker, higher number." },
          { criterionId: "34:0", satisfied: false, rationale: "Stale blocker, lower number." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 99, kind: "closing", criterionId: "99:0" },
          { issueNumber: 34, kind: "closing", criterionId: "34:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [12, 99, 34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // The CURRENT body only references #12 -- #34 and #99's own
      // references were removed since the read-only review ran (a
      // body-only edit, so the head SHA is unchanged).
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => jsonResponse({ id: 1 }, 201),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    // Exactly ONE inline comment posted -- for #12, never for the stale ones.
    const inlinePosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"));
    expect(inlinePosts).toHaveLength(1);
    expect((inlinePosts[0]?.body as { body: string }).body).toContain("Still-live blocker.");
    expect((inlinePosts[0]?.body as { body: string }).body).not.toContain("Stale blocker");

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // Ascending order (#34 before #99), NOT the runner's own findings
    // order (99 was listed before 34 in the verdict above).
    expect(summaryBody).toMatch(/#34, #99[\s\S]*were NOT posted inline/i);
    expect(summaryBody).toMatch(/no longer references them/i);
    expect(summaryBody).not.toMatch(/#12[\s\S]*were NOT posted inline/i);
    // KNOWN RESIDUAL, documented not hidden (see tryPostBlockersInline's
    // own docstring): the "N blocking finding(s)" count still comes from
    // the UNFILTERED runner-time set (3), even though only 1 was actually
    // posted inline -- the stale-note above is what reconciles the
    // difference for a human reading this summary.
    expect(summaryBody).toContain("3 blocking finding(s)");
  });

  it("applies the SAME current-body staleness re-check to unreviewedClosingIssues, not just criterion blockers -- posts the still-referenced one inline, skips the stale one (PR #87 review round 4, Codex, P1)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [] },
      spine: {
        entries: [],
        truncated: true,
        unreviewedClosingIssues: [
          { issueNumber: 12, truncationKind: "fully-dropped" },
          { issueNumber: 56, truncationKind: "fully-dropped" },
        ],
        diffTruncated: false,
        // Both entries are "fully-dropped" (never even fetched, in this
        // fixture), so reviewedClosingIssueNumbers correctly has neither
        // -- "fully-dropped" is deliberately NOT cross-checked against
        // this field either way (see validateCrossEntryInvariants's own
        // docstring).
        reviewedClosingIssueNumbers: [],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // The CURRENT body only references #12 -- #56's own reference was
      // removed since the review ran.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => jsonResponse({ id: 1 }, 201),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const inlinePosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"));
    expect(inlinePosts).toHaveLength(1);
    expect((inlinePosts[0]?.body as { body: string }).body).toContain("#12");
    expect((inlinePosts[0]?.body as { body: string }).body).not.toContain("#56");

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    expect(summaryBody).toMatch(/#56[\s\S]*were NOT posted inline/i);
    expect(summaryBody).not.toMatch(/#12[\s\S]*were NOT posted inline/i);
  });

  it("degrades to the fallback summary and exits nonzero when the diff has NO addable line at all (anchorFallbackNeeded, structural)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
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
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
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
    // The DISCRIMINATED reason (PR #87 review round 4, Codex, P1): a real
    // anchor was selected and tried, GitHub itself rejected it -- distinct
    // wording from the anchor-absent case, never implying no anchor was
    // ever attempted.
    expect(body).toMatch(/github itself rejected the deterministic anchor/i);
    expect(body).not.toMatch(/no addable line to anchor them to/i);
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

  it("posts a visible fallback and exits nonzero when the PR's current base SHA no longer matches the base recorded in the spine (F1-S9 slice 90.2, reordered per the #90 PR-plan revision) -- the target branch advanced since the review ran, even though the head SHA is unchanged", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // Head unchanged (matches TRUSTED_HEAD_SHA), but base has advanced
      // past what VALID_SPINE's own reviewedBaseSha (TRUSTED_BASE_SHA)
      // recorded -- e.g. a merge into main landed between the review run
      // and this publish run.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        jsonResponse({ head: { sha: TRUSTED_HEAD_SHA }, base: { sha: "some-other-base-the-target-advanced-to" } }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    // The FALLBACK wording, never the stale "No blocking findings" all-clear.
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/does not match the base this run's own review actually diffed against/i);
  });

  it("publishes normally when the PR's current base SHA still matches the base recorded in the spine (the healthy, same-base path)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("No blocking findings.");
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
        reviewedClosingIssueNumbers: [12],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    let postCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
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

  it("throws when GITHUB_RUN_NUMBER is missing entirely (bad workflow wiring, F1-S9 slice 90.3)", async () => {
    delete process.env.GITHUB_RUN_NUMBER;
    await expect(main()).rejects.toThrow(/GITHUB_RUN_NUMBER/);
  });

  it("counts the whole-run diff-truncation blocker when the diff was truncated and this run has a closing-kind reference -- even when every JOINED criterion is satisfied", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Looks present, but the diff was cut short." }] },
      spine: {
        entries: [{ issueNumber: 12, kind: "closing", criterionId: "12:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: true,
        reviewedClosingIssueNumbers: [12],
        reviewedBaseSha: TRUSTED_BASE_SHA,
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
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
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
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
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
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
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

describe("main — kind-aware revalidation + all-paths new-closing-reference check (F1-S9 slice 90.5, issue #12)", () => {
  it("fails closed on the ZERO-blocker path when the PR's CURRENT body references a brand-new closing issue the review never knew about in any way", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // #12 is a known, already-reviewed closing reference (satisfied) --
      // but the CURRENT body ALSO now closes #99, which appears in
      // NEITHER reviewedClosingIssueNumbers NOR unreviewedClosingIssues.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12 and closes #99" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/closing reference to issue #99 was not part of that review/i);
  });

  it("fails closed on the BLOCKER-BEARING path when the PR's CURRENT body references a brand-new closing issue -- touches NOTHING else (no inline post attempted at all)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: false, rationale: "Missing the retry wrapper." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12 and closes #99" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    // The whole run diverts to the new-closing fallback BEFORE
    // tryPostBlockersInline is ever reached -- no diff fetch, no inline
    // comment lookup or post at all.
    expect(calls.some((c) => c.url.includes("/compare/"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toMatch(/closing reference to issue #99 was not part of that review/i);
  });

  it("fails closed on an UPGRADED reference (Refs -> Closes since the review ran): the issue was never reviewed AS CLOSING, so its criteria were never escalated at closing severity, and the current closing claim is unverified", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." },
          { criterionId: "50:0", satisfied: false, rationale: "Non-closing at review time, unmet." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 50, kind: "non-closing", criterionId: "50:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        // #50 was reviewed only as a NON-closing reference -- absent from
        // reviewedClosingIssueNumbers, which only ever tracks closing-kind
        // fetched references.
        reviewedClosingIssueNumbers: [12],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // The CURRENT body upgrades #50 from a plain reference to a closing one.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12 and closes #50" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toMatch(/closing reference to issue #50 was not part of that review/i);
  });

  it("does NOT false-positive on a closing issue that was FULLY SATISFIED at review time (zero unmet criteria, no spine trace at all) -- the core 90.2 regression fix for PR #87 rounds 8-9's own permanent-red bug", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      // #12 has NOTHING unmet, so it produces no finding/entry of its own
      // at all -- #77 (non-closing) keeps the spine/hasCriteria non-empty.
      verdict: { findings: [{ criterionId: "77:0", satisfied: false, rationale: "Non-closing, unmet." }] },
      spine: {
        entries: [{ issueNumber: 77, kind: "non-closing", criterionId: "77:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        // #12 WAS reviewed as closing (found fully satisfied, hence no
        // entry above) -- only reviewedClosingIssueNumbers can say so.
        reviewedClosingIssueNumbers: [12],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12 and refs #77" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).not.toMatch(/was not part of that review/i);
    expect(body).toContain("No blocking findings.");
  });

  it("does NOT double-flag a beyond-fetch-cap closing reference (absent from reviewedClosingIssueNumbers by construction) that already carries its OWN unreviewedClosingIssues blocker -- posts that blocker normally instead of diverting to the generic new-closing fallback", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [] },
      spine: {
        entries: [],
        truncated: true,
        unreviewedClosingIssues: [{ issueNumber: 12, truncationKind: "fully-dropped" }],
        diffTruncated: false,
        // #12 is beyond the fetch cap -- correctly ABSENT here, but
        // already accounted for via unreviewedClosingIssues above.
        reviewedClosingIssueNumbers: [],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => jsonResponse({ id: 1 }, 201),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    // Posted as a REAL inline comment, the ordinary healthy path -- never
    // diverted to the generic "was not part of that review" fallback.
    const inlinePosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"));
    expect(inlinePosts).toHaveLength(1);
    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    expect(summaryBody).not.toMatch(/was not part of that review/i);
  });

  it("drops DOWNGRADED closing blockers (Closes -> Refs since the review ran) from posting, reporting them via their OWN accurate note in ascending order -- distinct from the stale-at-all-referenced-not case", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "Still-live blocker." },
          // Deliberately out of ascending order (99 before 34) -- exercises
          // the downgraded-issue-number sort, not just a single-element no-op
          // (mirrors the stale-blocker sort test's own precedent above).
          { criterionId: "99:0", satisfied: false, rationale: "Downgraded blocker, higher number." },
          { criterionId: "34:0", satisfied: false, rationale: "Downgraded blocker, lower number." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 99, kind: "closing", criterionId: "99:0" },
          { issueNumber: 34, kind: "closing", criterionId: "34:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [12, 99, 34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // #34 and #99 are STILL referenced, just downgraded from Closes to
      // Refs -- NOT removed outright, so this is NOT the stale-at-all case.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12, refs #99, refs #34" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => jsonResponse({ id: 1 }, 201),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const inlinePosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"));
    expect(inlinePosts).toHaveLength(1);
    expect((inlinePosts[0]?.body as { body: string }).body).toContain("Still-live blocker.");
    expect((inlinePosts[0]?.body as { body: string }).body).not.toContain("Downgraded blocker");

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // Ascending order (#34 before #99), NOT the verdict's own findings
    // order (99 was listed before 34 above).
    expect(summaryBody).toMatch(/#34, #99[\s\S]*were NOT posted inline/i);
    expect(summaryBody).toMatch(/no longer as a CLOSING reference/i);
    // NOT the "no longer references at all" wording -- #34/#99 ARE still referenced.
    expect(summaryBody).not.toMatch(/#34, #99[\s\S]*no longer references them at all/i);
  });

  it("happy path: publishes normally on the ZERO-blocker path when the only current closing reference is already known (ordinary case, no new-closing divergence)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as { body: string }).body).toContain("No blocking findings.");
  });

  it("happy path: publishes normally on the BLOCKER-BEARING path when the only current closing reference is already known (ordinary case, no new-closing divergence)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
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
    const inlinePosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"));
    expect(inlinePosts).toHaveLength(1);
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
