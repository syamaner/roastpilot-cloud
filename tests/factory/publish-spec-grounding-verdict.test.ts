import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { formatUncaughtErrorForLog, main } from "../../scripts/factory/publish-spec-grounding-verdict.mts";
import {
  assembleSpecGroundingSummaryCommentBody,
  SPEC_GROUNDING_SUMMARY_COMMENT_MARKER,
} from "../../scripts/factory/publish-spec-grounding-verdict-logic.mts";
import {
  CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER,
  criterionBlockerCommentMarker,
  DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER,
  inlineBlockerGenerationMarker,
  unreviewedClosingIssueCommentMarker,
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

function reviewThreadsResponse(
  nodes: readonly { readonly commentId: number; readonly isResolved: boolean }[],
): Response {
  return jsonResponse({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: nodes.map((node) => ({
              isResolved: node.isResolved,
              comments: { nodes: [{ databaseId: node.commentId }] },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
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
 * review round 3, Codex, P1, TOCTOU fold; `baseSha` added F1-S9 slice
 * 90.5b, PR #97 draft round 6, Codex, cid 3626754037) so a test can
 * simulate the PR having moved (`headSha`), advanced its target branch
 * (`baseSha`), or gained a new closing reference (`body`) since an
 * earlier snapshot -- every input `publishSummary`'s own T0 and pre-write
 * (T2) re-verifies both check. A separate function (not an optional param
 * on `prFetchHandler` itself) so every existing bare `prFetchHandler`
 * usage (passed directly as a mockFetch handler) keeps its own simple,
 * argument-free signature.
 */
function prFetchHandlerWithOverrides(overrides: { headSha?: string; baseSha?: string; body?: string | null }): Response {
  return jsonResponse({
    head: { sha: overrides.headSha ?? TRUSTED_HEAD_SHA },
    base: { sha: overrides.baseSha ?? TRUSTED_BASE_SHA },
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

  it.each([
    ["missing entirely", {}, /must carry a "reviewedClosingIssueNumbers" array/i],
    ["not an array", { reviewedClosingIssueNumbers: "12" }, /must carry a "reviewedClosingIssueNumbers" array/i],
    ["contains ZERO -- issue #0 does not exist (team-lead's own refinement, positive not merely non-negative)", { reviewedClosingIssueNumbers: [0] }, /must contain only positive integers/i],
    ["contains a negative number", { reviewedClosingIssueNumbers: [-1] }, /must contain only positive integers/i],
    ["contains a non-integer", { reviewedClosingIssueNumbers: [1.5] }, /must contain only positive integers/i],
    ["contains a non-number element", { reviewedClosingIssueNumbers: ["12"] }, /must contain only positive integers/i],
    ["contains a DUPLICATE (a legitimate writer's own Set-based construction can never produce one)", { reviewedClosingIssueNumbers: [12, 12] }, /contains a duplicate \(12\)/i],
    [
      "exceeds MAX_REVIEWED_CLOSING_ISSUE_NUMBERS (team-lead's own refinement -- mirrors criteria-spine.json's own identical cap)",
      { reviewedClosingIssueNumbers: Array.from({ length: 1001 }, (_unused, i) => i + 1) },
      /has 1001 elements, exceeds 1000/i,
    ],
  ])(
    "posts a visible fallback when outcome.json's reviewedClosingIssueNumbers %s (F1-S9 slice 90.5, PR #96 review round 2, Codex, cid 3626169262, BLOCKER -- FAILS CLOSED, unlike noCriteriaReason's own safe-default coercion)",
    async (_label, malformedField, expectedMessage) => {
      const outcomePath = join(workdir, "outcome.json");
      await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", ...malformedField }));
      process.env.OUTCOME_PATH = outcomePath;
      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
        "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
      });
      vi.stubGlobal("fetch", fetchMock);

      await main();

      expect(process.exitCode).toBe(1);
      const post = calls.find((c) => c.method === "POST");
      expect((post?.body as { body: string }).body).toMatch(expectedMessage);
    },
  );

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
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
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
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
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
            body:
              `stale blocker\n<!-- roastpilot-factory:spec-grounding-blocker:criterion:12:0:do-not-edit -->\n` +
              inlineBlockerGenerationMarker("1"),
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

  it("reason=no-references: passes the validated run generation through and retains a newer run's blocker", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "5";
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 77,
            body: `current generation\n${marker}\n${inlineBlockerGenerationMarker("5")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 78,
            body: `newer generation\n${marker}\n${inlineBlockerGenerationMarker("6")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/77": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/77$/),
    ]);
  });

  it("reason=no-references: rechecks after inline-comment pagination and stops before DELETE when a closing reference is re-added in that window", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    let pullsCallCount = 0;
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        pullsCallCount += 1;
        return prFetchHandlerWithOverrides({ body: pullsCallCount < 3 ? "" : "Closes #12" });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 77,
            body: `became applicable again\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
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
    expect(pullsCallCount).toBe(3);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/issues/comments/55"));
    expect((patch?.body as { body: string }).body).toMatch(/left in place/i);
    expect((patch?.body as { body: string }).body).not.toMatch(/deleted \d+ stale inline blocker/i);
  });

  it("reason=no-references: reports partial safe cleanup and stops subsequent deletes when state drifts between candidates", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    let pullsCallCount = 0;
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        pullsCallCount += 1;
        return prFetchHandlerWithOverrides({ body: pullsCallCount < 4 ? "" : "Closes #12" });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse(
          [77, 78].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/77": () => new Response(null, { status: 204 }),
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
    expect(pullsCallCount).toBe(4);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/77$/),
    ]);
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/issues/comments/55"));
    const body = (patch?.body as { body: string }).body;
    expect(body).toMatch(/deleted 1 stale inline blocker comment\(s\)/i);
    expect(body).toMatch(/no further blocker was deleted after drift/i);
  });

  it("reason=no-references: creates a visible warning after partial cleanup when no prior summary exists", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    let pullsCallCount = 0;
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        pullsCallCount += 1;
        return prFetchHandlerWithOverrides({ body: pullsCallCount < 4 ? "" : "Closes #12" });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse(
          [77, 78].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/77": () => new Response(null, { status: 204 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 56 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/77$/),
    ]);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).toMatch(/deleted 1 stale inline blocker comment\(s\)/i);
    expect(body).toMatch(/remaining inline blocker threads[\s\S]*left in place/i);
  });

  it("reason=no-references: reports a completed delete when the next destructive-boundary recheck fails", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    let pullsCallCount = 0;
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        pullsCallCount += 1;
        return pullsCallCount === 4
          ? new Response("recheck unavailable", { status: 503 })
          : prFetchHandler();
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse(
          [77, 78].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/77": () => new Response(null, { status: 204 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/77$/),
    ]);
    const fallbackPost = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (fallbackPost?.body as { body: string }).body;
    expect(body).toMatch(/failed: GitHub API GET .* 503/i);
    expect(body).toMatch(/confirmed 1 stale inline blocker comment\(s\) deleted/i);
    expect(body).toMatch(/no further DELETE was attempted after the failure/i);
  });

  it("reason=no-references: reports a completed delete when the next DELETE fails", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse(
          [77, 78].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/77": () => new Response(null, { status: 204 }),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/78": () =>
        new Response("forbidden", { status: 403 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/77$/),
      expect.stringMatching(/comments\/78$/),
    ]);
    const fallbackPost = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (fallbackPost?.body as { body: string }).body;
    expect(body).toMatch(/failed: GitHub API DELETE .* 403/i);
    expect(body).toMatch(/confirmed 1 stale inline blocker comment\(s\) deleted/i);
    expect(body).toMatch(/failed DELETE request's outcome is unknown/i);
    expect(body).toMatch(/no later candidate DELETE was attempted/i);
  });

  it("reason=no-references: reports an unknown outcome when the first DELETE fails", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse(
          [77, 78].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/77": () =>
        new Response("server error", { status: 503 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/77$/),
    ]);
    const fallbackPost = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (fallbackPost?.body as { body: string }).body;
    expect(body).toMatch(/no DELETE received a confirmed-success response/i);
    expect(body).toMatch(/failed DELETE request's outcome is unknown/i);
    expect(body).toMatch(/no later candidate DELETE was attempted/i);
  });

  it("reason=no-references: retains the partial delete count when writing the drift summary fails", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    let pullsCallCount = 0;
    let summaryLookupCalls = 0;
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        pullsCallCount += 1;
        return prFetchHandlerWithOverrides({ body: pullsCallCount < 4 ? "" : "Closes #12" });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse(
          [77, 78].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/77": () => new Response(null, { status: 204 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => {
        summaryLookupCalls += 1;
        return summaryLookupCalls === 1
          ? new Response("rate limited", { status: 403 })
          : jsonResponse([]);
      },
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/77$/),
    ]);
    const fallbackPost = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (fallbackPost?.body as { body: string }).body;
    expect(body).toMatch(/failed: GitHub API GET .* 403/i);
    expect(body).toMatch(/confirmed 1 stale inline blocker comment\(s\) deleted/i);
  });

  it("reason=no-references: fails visibly before stale-state cleanup when GITHUB_RUN_NUMBER is invalid", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    process.env.GITHUB_RUN_NUMBER = "not-a-number";
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.some((c) => c.method === "PATCH" || c.method === "DELETE")).toBe(false);
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    const fallbackPost = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    expect((fallbackPost?.body as { body: string }).body).toMatch(
      /GITHUB_RUN_NUMBER.*not a valid positive integer/i,
    );
  });

  it("reason=no-references BUT the PR moved (head SHA no longer matches trusted) since the review ran: FAILS CLOSED with a visible fallback (F1-S9 slice 90.5, PR #96 review round 2, Codex, cid 3626169262 -- Fork A's own new head-verify now runs BEFORE either reason-specific branch, uniformly matching publishSummary's own hasCriteria:true behavior, rather than the narrower graceful degrade isStillSafeToDeleteInlineBlockerThreads used to provide for this exact scenario)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ headSha: "differentsha0000000000000000000000000000" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    expect(post).toBeDefined();
    expect((post?.body as { body: string }).body).toMatch(/does not match the trusted event head sha/i);
    // Fork A's own head-verify fails BEFORE either reason-specific branch
    // (no summary clear, no inline-comment lookup or delete attempt at all).
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reason=no-references: STILL degrades to the non-destructive path (via isStillSafeToDeleteInlineBlockerThreads's own re-check) for the NARROWER TOCTOU window that remains AFTER Fork A's own head-verify -- the PR moves a SECOND time, between Fork A's fetch and this function's own separate, later re-fetch (F1-S9 slice 90.5: Fork A's new head-verify does not replace this pre-existing, independent re-check immediately before the destructive delete)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    let pullsCallCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        pullsCallCount += 1;
        // FIRST call (Fork A's own fetchAndVerifyPrShas) sees the TRUSTED
        // head SHA and an empty body -- passes cleanly. SECOND call
        // (isStillSafeToDeleteInlineBlockerThreads's own, separate
        // re-fetch, immediately before the destructive delete) finds the
        // PR has moved AGAIN in the interim -- the narrow race window
        // that mechanism still exists specifically to close.
        return pullsCallCount === 1
          ? prFetchHandler()
          : prFetchHandlerWithOverrides({ headSha: "differentsha0000000000000000000000000000" });
      },
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
    expect(pullsCallCount).toBe(2);
    const patch = calls.find((c) => c.method === "PATCH" && c.url.includes("/issues/comments/"));
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toMatch(/own state changed/i);
    expect((patch?.body as { body: string }).body).toMatch(/left in place/i);
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reason=no-references BUT the PR's CURRENT body now shows a closing reference (added after the review ran, head SHA unchanged): Fork A itself now fails this closed with its own specific message, BEFORE either reason-specific branch runs (F1-S9 slice 90.5, PR #96 review round 2, Codex, cid 3626169262 -- supersedes the narrower, gracefully-degrading treatment isStillSafeToDeleteInlineBlockerThreads used to give this exact scenario)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      // Same head SHA as trusted (a body-only edit never bumps it), but
      // the body NOW carries a real closing reference the runner never saw.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    expect(post).toBeDefined();
    expect((post?.body as { body: string }).body).toMatch(/closing reference to issue #12 was not part of that review/i);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reason=no-unmet-criteria: updates the summary with the self-attested caveat but LEAVES inline blocker threads untouched -- deleting a required_conversation_resolution-gating thread on a self-attested, non-diff-verified signal would be an anti-gaming hole (PR #87 review, Codex, P1/medium fold)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-unmet-criteria", reviewedClosingIssueNumbers: [12] }),
    );
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

  it("reason=no-unmet-criteria: Fork A ALSO fails closed here when the PR's CURRENT body shows a genuinely new closing reference (F1-S9 slice 90.5, PR #96 review round 2, Codex, cid 3626169262, BLOCKER) -- completes Fork A's coverage to BOTH no-criteria sub-paths, not just no-references", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      // #12 was reviewed as closing (self-attested complete); #99 is a
      // BRAND-NEW closing reference this run never knew about at all.
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-unmet-criteria", reviewedClosingIssueNumbers: [12] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12 and closes #99" }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    expect(post).toBeDefined();
    expect((post?.body as { body: string }).body).toMatch(/closing reference to issue #99 was not part of that review/i);
    // Fork A's own check fails BEFORE the "no-unmet-criteria" branch's own
    // summary-upsert logic ever runs.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("an unknown/missing noCriteriaReason on a false outcome.json FAILS CLOSED to the non-destructive treatment -- never deletes inline blocker threads on a signal it could not confirm (PR #87 review, Codex, P1/medium fold)", async () => {
    const outcomePath = join(workdir, "outcome.json");
    // Deliberately missing noCriteriaReason -- a malformed/stale-runner
    // artifact this entrypoint cannot positively confirm as no-references.
    // reviewedClosingIssueNumbers IS present and valid here -- this test
    // isolates the noCriteriaReason-coercion behavior specifically, not
    // the separate (and separately tested) reviewedClosingIssueNumbers
    // validation (F1-S9 slice 90.5).
    await writeFile(outcomePath, JSON.stringify({ hasCriteria: false, reviewedClosingIssueNumbers: [] }));
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
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
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    // The summary-comment lookup 403s exactly ONCE (clearStaleSpecGroundingSummary's
    // own check) -- publishFallback's own subsequent lookup, in the catch
    // block, must still succeed so the fallback comment can genuinely post.
    let summaryLookupCalls = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
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

  it("stringifies a non-Error stale-state cleanup failure in the visible fallback", async () => {
    const outcomePath = join(workdir, "outcome.json");
    await writeFile(
      outcomePath,
      JSON.stringify({ hasCriteria: false, noCriteriaReason: "no-references", reviewedClosingIssueNumbers: [] }),
    );
    process.env.OUTCOME_PATH = outcomePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        throw "raw cleanup rejection";
      },
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const fallbackPost = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    expect((fallbackPost?.body as { body: string }).body).toMatch(/failed: raw cleanup rejection/i);
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
      // F1-S9 slice 90.4: reconciliation always runs on the zero-blocker
      // path -- fetches existing inline comments to find (none here)
      // anything obsolete to delete.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
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

  it("renders only non-blocking findings whose issues remain referenced in the PR current body", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "CURRENT_NON_CLOSING" },
          { criterionId: "34:0", satisfied: false, rationale: "STALE_NON_CLOSING" },
          { criterionId: "56:0", satisfied: true, rationale: "DOWNGRADED_BUT_REFERENCED" },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "non-closing", criterionId: "12:0" },
          { issueNumber: 34, kind: "non-closing", criterionId: "34:0" },
          { issueNumber: 56, kind: "closing", criterionId: "56:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [56],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Refs #12 and refs #56" }),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.some((call) => call.url.includes("/compare/"))).toBe(false);
    const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("CURRENT_NON_CLOSING");
    expect(body).toContain("DOWNGRADED_BUT_REFERENCED");
    expect(body).not.toContain("STALE_NON_CLOSING");
  });

  it("posts a visible fallback and exits nonzero when reconciling obsolete inline blocker comments fails -- a genuine non-404 failure is never silently swallowed", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        new Response("forbidden", { status: 403 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/failed to reconcile this run's own obsolete inline blocker comments/i);
    expect(body).toMatch(/403/);
  });

  it("KEEPS a prior run's own inline blocker comment for a criterion this run's verdict now finds SATISFIED, as long as its own issue is STILL closing-referenced (F1-S9 slice 90.4, redesigned per the operator's #801 anti-gaming ruling) -- a satisfied-but-still-live obligation is a human's call, never auto-cleared", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    const { fetchMock, calls } = mockFetch({
      // #12 is STILL a closing reference in the current body -- only its
      // own CRITERION is now satisfied.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 201,
            body: `Was unsatisfied.\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    expect((post?.body as { body: string }).body).toContain("No blocking findings.");
  });

  it("DELETES a prior run's own inline blocker comment for a criterion that is now DE-REFERENCED, regardless of whether the verdict itself found it satisfied or still unmet (F1-S9 slice 90.4, redesigned -- the operator's #801 bright line is CURRENT-BODY closing-reference presence, not verdict outcome)", async () => {
    const marker = criterionBlockerCommentMarker("34:0");
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      // Genuinely still UNMET per the verdict -- proves the delete is
      // driven by de-reference, never by verdict satisfaction.
      verdict: { findings: [{ criterionId: "34:0", satisfied: false, rationale: "Still genuinely unmet." }] },
      spine: {
        entries: [{ issueNumber: 34, kind: "closing", criterionId: "34:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    const { fetchMock, calls } = mockFetch({
      // #34 is no longer referenced at all in the current body.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": prFetchHandler,
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 201,
            body: `Still genuinely unmet.\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/201": () => new Response(null, { status: 204 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/pulls/comments/201"))).toBe(true);
  });

  it("FAILS CLOSED, loudly, BEFORE ANY posting or reconciliation, when GITHUB_RUN_NUMBER is not a valid positive integer (F1-S9 slice 90.4, redesigned, Codex finding #798 -- validated ONCE at the top of publishSummary, not just immediately before the reconcile call as an earlier version did) -- Number('not-a-number') is NaN, and any comparison against NaN is false, which would otherwise make EVERY comment look safe to delete regardless of its own real generation", async () => {
    process.env.GITHUB_RUN_NUMBER = "not-a-number";
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      // A REAL blocker-bearing verdict this time -- proves the fail-closed
      // check fires before the posting path too, not only the zero-blocker one.
      verdict: { findings: [{ criterionId: "12:0", satisfied: false, rationale: "Missing the retry wrapper." }] },
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

    expect(process.exitCode).toBe(1);
    // Never even reaches the diff fetch, inline-comment fetch, or the
    // reconciliation fetch at all -- fails before any of them, so there's
    // no risk of posting a generation-marked comment OR reconciling
    // against an untrustworthy generation.
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/compare/"))).toBe(false);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/GITHUB_RUN_NUMBER.*is not a valid positive integer/i);
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
    expect(summaryBody).toContain("1 current-applicable blocking finding(s)");
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
    // One live finding is current-applicable; the two stale findings are
    // reported separately in review-time finding units.
    expect(summaryBody).toContain("1 current-applicable blocking finding(s)");
    expect(summaryBody).toMatch(
      /review also identified 2 blocking findings for issues that are no longer closing obligations/i,
    );
  });

  it("publishes a coherent zero-current headline and exits successfully when every review-time blocker is de-referenced", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [{ criterionId: "34:0", satisfied: false, rationale: "Stale blocker." }],
      },
      spine: {
        entries: [{ issueNumber: 34, kind: "closing", criterionId: "34:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "No linked issue remains." }),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.some((call) => call.url.includes("/compare/"))).toBe(false);
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/pulls/83/comments"))).toBe(false);
    const summaryPost = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    expect(summaryBody).toContain("No current-applicable blocking findings.");
    expect(summaryBody).toMatch(/review-time blocking findings.*note\(s\) below/i);
    expect(summaryBody).toMatch(/#34 were NOT posted inline[\s\S]*no longer references them at all/i);
    expect(summaryBody).not.toMatch(/\*\*\d+ current-applicable blocking finding/);
    expect(summaryBody).not.toContain("No unmet acceptance criteria were found at all.");
  });

  it("distinguishes a DOWNGRADED closing blocker from a fully DE-REFERENCED one, in the SAME run, with two separate accurate notes (F1-S9 slice 90.6a -- the stale-vs-downgraded bucket-split): #12 still closing (posted inline normally), #34 and #78 both downgraded Closes->Refs (still referenced, but no longer closing -- two, deliberately out of ascending order, to exercise the downgraded bucket's own sort, not just a single-element no-op), #99 removed from the body entirely (not referenced at all)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "Still-live blocker." },
          // Deliberately out of ascending order (78 before 34).
          { criterionId: "78:0", satisfied: false, rationale: "Downgraded blocker, higher number." },
          { criterionId: "34:0", satisfied: false, rationale: "Downgraded blocker, lower number." },
          { criterionId: "99:0", satisfied: false, rationale: "De-referenced blocker." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 78, kind: "closing", criterionId: "78:0" },
          { issueNumber: 34, kind: "closing", criterionId: "34:0" },
          { issueNumber: 99, kind: "closing", criterionId: "99:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [12, 78, 34, 99],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // #12 stays a live Closes; #34 and #78 both downgraded to a plain
      // Refs (still referenced); #99 is not mentioned at all anymore.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12, refs #34, refs #78" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => jsonResponse({ id: 1 }, 201),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    // Exactly ONE inline comment posted -- for #12, never for #34, #78, or #99.
    const inlinePosts = calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls/83/comments"));
    expect(inlinePosts).toHaveLength(1);
    expect((inlinePosts[0]?.body as { body: string }).body).toContain("Still-live blocker.");

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // #99's own note: de-referenced entirely.
    expect(summaryBody).toMatch(/#99 were NOT posted inline[\s\S]*no longer references them at all/i);
    // #34 and #78's own note: downgraded, still referenced -- ascending
    // order (#34 before #78), NOT the verdict's own findings order (78
    // was listed before 34 above).
    expect(summaryBody).toMatch(
      /#34, #78 were NOT posted inline[\s\S]*still references them, but no longer with a closing keyword/i,
    );
    expect(summaryBody).toMatch(/downgraded/i);
    // Neither note wrongly claims the other bucket's own case.
    expect(summaryBody).not.toMatch(/#34[\s\S]{0,80}no longer references them at all/i);
    expect(summaryBody).not.toMatch(/#99[\s\S]{0,80}still references them, but no longer with a closing keyword/i);
    // #12 never appears in either skip-note.
    expect(summaryBody).not.toMatch(/#12[\s\S]{0,40}were NOT posted inline/i);
    // The headline and exit path share the one CURRENT-applicable finding
    // (#12). The separate review-time note counts the other three findings
    // while the detailed notes retain deduplicated issue-number buckets.
    expect(summaryBody).toContain("1 current-applicable blocking finding(s)");
    expect(summaryBody).toMatch(
      /review also identified 3 blocking findings for issues that are no longer closing obligations/i,
    );
  });

  it("budgets the COMPLETE assembled comment across a near-max non-blocking list, anchor fallback, and both capped skip-note buckets (F1-S9 slice 90.6b-1, issue #90)", async () => {
    const LIVE_COUNT = 5;
    const STALE_COUNT = 300;
    const DOWNGRADED_COUNT = 300;
    const NON_BLOCKING_COUNT = 180;
    const findings = [
      ...Array.from({ length: LIVE_COUNT }, (_unused, i) => ({
        criterionId: `${i + 1}:0`,
        satisfied: false,
        rationale: "L".repeat(2_000),
      })),
      ...Array.from({ length: STALE_COUNT }, (_unused, i) => ({
        criterionId: `${1000 + i}:0`,
        satisfied: false,
        rationale: "De-referenced blocker.",
      })),
      ...Array.from({ length: DOWNGRADED_COUNT }, (_unused, i) => ({
        criterionId: `${2000 + i}:0`,
        satisfied: false,
        rationale: "Downgraded blocker.",
      })),
      ...Array.from({ length: NON_BLOCKING_COUNT }, (_unused, i) => ({
        criterionId: `${3000 + i}:0`,
        satisfied: false,
        rationale: "N".repeat(2_000),
      })),
    ];
    const entries = [
      ...Array.from({ length: LIVE_COUNT }, (_unused, i) => ({
        issueNumber: i + 1,
        kind: "closing" as const,
        criterionId: `${i + 1}:0`,
      })),
      ...Array.from({ length: STALE_COUNT }, (_unused, i) => ({
        issueNumber: 1000 + i,
        kind: "closing" as const,
        criterionId: `${1000 + i}:0`,
      })),
      ...Array.from({ length: DOWNGRADED_COUNT }, (_unused, i) => ({
        issueNumber: 2000 + i,
        kind: "closing" as const,
        criterionId: `${2000 + i}:0`,
      })),
      ...Array.from({ length: NON_BLOCKING_COUNT }, (_unused, i) => ({
        issueNumber: 3000 + i,
        kind: "non-closing" as const,
        criterionId: `${3000 + i}:0`,
      })),
    ];
    const reviewedClosingIssueNumbers = [
      ...Array.from({ length: LIVE_COUNT }, (_unused, i) => i + 1),
      ...Array.from({ length: STALE_COUNT }, (_unused, i) => 1000 + i),
      ...Array.from({ length: DOWNGRADED_COUNT }, (_unused, i) => 2000 + i),
    ];
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings },
      spine: {
        entries,
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers,
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    // The CURRENT body: five blockers stay closing; the 300 "downgraded"
    // issues and all non-blocking issues are still referenced via Refs;
    // the 300 "stale" blocker issues are absent.
    const currentBody =
      Array.from({ length: LIVE_COUNT }, (_unused, i) => `Closes #${i + 1}`).join(", ") +
      ", " +
      Array.from({ length: DOWNGRADED_COUNT }, (_unused, i) => `refs #${2000 + i}`).join(", ") +
      ", " +
      Array.from({ length: NON_BLOCKING_COUNT }, (_unused, i) => `refs #${3000 + i}`).join(", ");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: currentBody }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    const budgetProbeSection = `ENTRYPOINT-BUDGET-PROBE:${"P".repeat(10_000)}`;
    await main((buildBaseBody, appendedSections) => {
      expect(appendedSections).toHaveLength(3);
      return assembleSpecGroundingSummaryCommentBody(
        buildBaseBody,
        [...appendedSections, budgetProbeSection],
      );
    });

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // Real content posted -- never the generic fallback.
    expect(summaryBody).not.toMatch(/could not run to completion/i);
    expect(summaryBody).toContain(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER);
    expect(summaryBody).toMatch(/blocking findings are listed here/i);
    expect(summaryBody).toMatch(/were NOT posted inline[\s\S]*no longer references them at all/i);
    expect(summaryBody).toMatch(
      /were NOT posted inline[\s\S]*still references them, but no longer with a closing keyword/i,
    );
    expect(summaryBody.match(/and \d+ more/gi)).toHaveLength(2);
    expect(summaryBody).toMatch(/further finding\(s\) omitted/i);
    expect(summaryBody.endsWith(budgetProbeSection)).toBe(true);
    expect(summaryBody.length).toBeLessThanOrEqual(65_536);
  });

  it("does NOT list a DOWNGRADED (or de-referenced) blocker's own full detail in the ANCHOR-FALLBACK supplement (F1-S9 slice 90.6a, issue #90's own #376 -- the caller used to pass the RAW, unfiltered, review-time criterionBlockers here, contradicting the skip-notes appended right below): #12 stays closing (inline posting degrades, so its detail belongs in the fallback), #34 downgraded Closes->Refs -- its own detail must NOT appear in the fallback (that would claim it's still a live obligation while the downgraded skip-note, right below, says otherwise)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "Still-live blocker rationale." },
          { criterionId: "34:0", satisfied: false, rationale: "Downgraded blocker rationale." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 34, kind: "closing", criterionId: "34:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [12, 34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // #12 stays a live Closes; #34 downgraded to a plain Refs.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12, refs #34" }),
      // An EMPTY diff -- no addable anchor at all, forcing the
      // anchor-fallback path (blockersPostedInline: false, degradeReason:
      // "no-addable-anchor").
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // NOT a categorical "no inline thread for them" claim (F1-S9 slice
    // 90.6a, PR #99 review, Codex, cid 3627450889, P2) -- some listed
    // entries below CAN already have a real (possibly-resolved) inline
    // thread from a retained PATCH; the wording tells a human to resolve
    // any existing thread first, then address whatever remains here.
    expect(summaryBody).toMatch(/resolve any inline thread that already exists for one of these first/i);
    expect(summaryBody).not.toMatch(/could not be posted as inline comments/i);
    expect(summaryBody).not.toMatch(/no inline thread for them/i);
    // #12's own full detail belongs in the fallback -- it's still a live
    // obligation with no inline thread.
    expect(summaryBody).toContain("Still-live blocker rationale.");
    // #34's own full detail must NOT appear here -- it's downgraded, and
    // its own skip-note (appended separately, below) already covers it
    // accurately. Listing it in the fallback too would contradict that
    // note by implying #34 is still a live, resolvable obligation.
    expect(summaryBody).not.toContain("Downgraded blocker rationale.");
    // The downgraded skip-note IS present, and is the ONLY place #34 is
    // described.
    expect(summaryBody).toMatch(/#34 were NOT posted inline[\s\S]*still references them, but no longer with a closing keyword/i);
  });

  it("keeps a PATCHed RESOLVED criterion blocker visible in fallback after a later first-CREATE 422", async () => {
    const stillLiveMarker = criterionBlockerCommentMarker("12:0");
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "First rationale, already posted." },
          { criterionId: "34:0", satisfied: false, rationale: "Second rationale, 422 on create." },
          { criterionId: "56:0", satisfied: false, rationale: "Third rationale, never attempted." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 34, kind: "closing", criterionId: "34:0" },
          { issueNumber: 56, kind: "closing", criterionId: "56:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [12, 34, 56],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    // All three stay closing -- isolating this test to the posted-subset
    // dimension alone, not overlapping with the bucket-split (#376).
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12, closes #34, closes #56" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      // #12 already has a prior comment -- PATCHes successfully. #34 and
      // #56 have no prior comment -- #34 is the FIRST genuine CREATE
      // attempt (the diagnostic one); its own 422 degrades the whole
      // plan, so #56 is never even attempted.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 201,
            body: `First rationale, already posted.\n${stillLiveMarker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/201": () => jsonResponse({}),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => new Response("Unprocessable Entity", { status: 422 }),
      "POST /graphql": () => reviewThreadsResponse([{ commentId: 201, isResolved: true }]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // NOT a categorical "no inline thread for them" claim (F1-S9 slice
    // 90.6a, PR #99 review, Codex, cid 3627450889, P2) -- some listed
    // entries below CAN already have a real (possibly-resolved) inline
    // thread from a retained PATCH; the wording tells a human to resolve
    // any existing thread first, then address whatever remains here.
    expect(summaryBody).toMatch(/resolve any inline thread that already exists for one of these first/i);
    expect(summaryBody).not.toMatch(/could not be posted as inline comments/i);
    expect(summaryBody).not.toMatch(/no inline thread for them/i);
    // #12's own PATCH succeeded, but GraphQL confirms its thread is
    // RESOLVED. It stays visible so PATCH's inability to reopen the thread
    // cannot make the blocker disappear.
    expect(summaryBody).toContain("First rationale, already posted.");
    // #34 and #56 genuinely have no inline thread -- both belong in the fallback too.
    expect(summaryBody).toContain("Second rationale, 422 on create.");
    expect(summaryBody).toContain("Third rationale, never attempted.");
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
    expect(summaryBody).toContain("3 current-applicable blocking finding(s)");
    expect(summaryBody).toMatch(/unresolved inline review thread\(s\) and\/or the fallback details below/i);
    expect(summaryBody).not.toMatch(/finding\(s\) are already covered by inline review comment/i);
  });

  it("excludes a PATCHed UNRESOLVED criterion blocker while keeping the later failed diff-truncation CREATE in fallback", async () => {
    const marker12 = criterionBlockerCommentMarker("12:0");
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [{ criterionId: "12:0", satisfied: false, rationale: "Still-live blocker rationale." }],
      },
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
    // #12 stays closing -- no drift, isolating this test to the
    // diff-truncation dimension of the split alone (no stale/downgraded
    // blockers, so the review-time count exactly equals the still-applicable
    // total the invariant is checked against).
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      // #12 already has a prior comment -- PATCHes successfully. The
      // diff-truncation aggregate has none -- the first genuine CREATE in
      // the whole plan, and its own 422 degrades it.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 301,
            body: `prior\n${marker12}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/301": () => jsonResponse({}),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => new Response("Unprocessable Entity", { status: 422 }),
      "POST /graphql": () => reviewThreadsResponse([{ commentId: 301, isResolved: false }]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // Review-time total: 1 criterion blocker + 1 diff-truncation term = 2.
    expect(summaryBody).toContain("2 current-applicable blocking finding(s)");
    expect(summaryBody).toMatch(/unresolved inline review thread\(s\) and\/or the fallback details below/i);
    // #12's updated thread is confirmed unresolved, so its duplicate
    // fallback detail is omitted while the real thread continues to gate.
    expect(summaryBody).not.toContain("Still-live blocker rationale.");
    // The diff-truncation blocker's own detail is ALSO in the fallback --
    // it genuinely never posted at all.
    expect(summaryBody).toMatch(/this pr's own diff was truncated/i);
  });

  it("excludes a PATCHed UNRESOLVED unreviewed-closing-issue blocker while keeping the later failed CREATE in fallback", async () => {
    const marker78 = unreviewedClosingIssueCommentMarker(78);
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [] },
      spine: {
        entries: [],
        truncated: true,
        unreviewedClosingIssues: [
          { issueNumber: 78, truncationKind: "fully-dropped" },
          { issueNumber: 90, truncationKind: "fully-dropped" },
        ],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #78, closes #90" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      // #78 already has a prior comment -- PATCHes successfully. #90 has
      // none -- the first genuine CREATE attempt, and its own 422
      // degrades the whole plan.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 301,
            body: `prior\n${marker78}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/301": () => jsonResponse({}),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => new Response("Unprocessable Entity", { status: 422 }),
      "POST /graphql": () => reviewThreadsResponse([{ commentId: 301, isResolved: false }]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // NOT a categorical "no inline thread for them" claim (F1-S9 slice
    // 90.6a, PR #99 review, Codex, cid 3627450889, P2) -- some listed
    // entries below CAN already have a real (possibly-resolved) inline
    // thread from a retained PATCH; the wording tells a human to resolve
    // any existing thread first, then address whatever remains here.
    expect(summaryBody).toMatch(/resolve any inline thread that already exists for one of these first/i);
    expect(summaryBody).not.toMatch(/could not be posted as inline comments/i);
    expect(summaryBody).not.toMatch(/no inline thread for them/i);
    // #78's PATCHed thread is confirmed unresolved, so it remains actionable
    // there and its duplicate fallback detail is omitted.
    expect(summaryBody).not.toMatch(/Issue #78: \*\*never reviewed at all\*\*/);
    // #90 genuinely has no inline thread -- belongs in the fallback too.
    expect(summaryBody).toMatch(/Issue #90: \*\*never reviewed at all\*\*/);
    expect(calls.some((c) => c.method === "PATCH")).toBe(true);
  });

  it("excludes criteria covered by PATCHed UNRESOLVED individual and aggregate threads while keeping a later failed CREATE in fallback", async () => {
    const individualMarkers = Array.from({ length: 5 }, (_unused, i) => criterionBlockerCommentMarker(`12:${i}`));
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          ...Array.from({ length: 6 }, (_unused, i) => ({
            criterionId: `12:${i}`,
            satisfied: false,
            rationale: `Rationale for 12:${i}.`,
          })),
        ],
      },
      spine: {
        entries: Array.from({ length: 6 }, (_unused, i) => ({
          issueNumber: 12,
          kind: "closing" as const,
          criterionId: `12:${i}`,
        })),
        truncated: true,
        unreviewedClosingIssues: [{ issueNumber: 90, truncationKind: "fully-dropped" }],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [12, 90],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Closes #12, closes #90" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      // 5 individual criterion comments (12:0-12:4) AND the ONE aggregate
      // comment covering the overflow (12:5) already exist -- all 6
      // PATCH successfully. #90 (an unreviewed closing issue) has no
      // prior comment -- the first genuine CREATE in the whole plan, and
      // its own 422 degrades it.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          ...individualMarkers.map((marker, i) => ({
            id: 100 + i,
            body: `prior\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
          {
            id: 200,
            body: `prior aggregate\n${CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/100": () => jsonResponse({}),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/101": () => jsonResponse({}),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/102": () => jsonResponse({}),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/103": () => jsonResponse({}),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/104": () => jsonResponse({}),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/200": () => jsonResponse({}),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => new Response("Unprocessable Entity", { status: 422 }),
      "POST /graphql": () =>
        reviewThreadsResponse([
          ...Array.from({ length: 5 }, (_unused, i) => ({ commentId: 100 + i, isResolved: false })),
          { commentId: 200, isResolved: false },
        ]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    // NOT a categorical "no inline thread for them" claim (F1-S9 slice
    // 90.6a, PR #99 review, Codex, cid 3627450889, P2) -- some listed
    // entries below CAN already have a real (possibly-resolved) inline
    // thread from a retained PATCH; the wording tells a human to resolve
    // any existing thread first, then address whatever remains here.
    expect(summaryBody).toMatch(/resolve any inline thread that already exists for one of these first/i);
    expect(summaryBody).not.toMatch(/could not be posted as inline comments/i);
    expect(summaryBody).not.toMatch(/no inline thread for them/i);
    // The headline remains the review-time total, while the fallback details
    // include only #90: all six criteria remain actionable through confirmed
    // unresolved threads.
    expect(summaryBody).toContain("7 current-applicable blocking finding(s)");
    for (let i = 0; i < 5; i++) {
      expect(summaryBody).not.toContain(`Rationale for 12:${i}.`);
    }
    expect(summaryBody).not.toMatch(/more unmet acceptance criterion\(a\) also treated as unsatisfied/i);
    // #90 genuinely has no inline thread -- belongs in the fallback.
    expect(summaryBody).toMatch(/Issue #90: \*\*never reviewed at all\*\*/);
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(6);
  });

  it("PATCHes a still-closing-referenced criterion's own comment (still unmet) while DELETING a de-referenced sibling's own comment via reconciliation, in the SAME run (F1-S9 slice 90.4, redesigned -- de-reference is now a real delete, not a 'leave in place, note it as stale' no-op)", async () => {
    const stillLiveMarker = criterionBlockerCommentMarker("12:0");
    const dereferencedMarker = criterionBlockerCommentMarker("34:0");
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "Still-live blocker." },
          // #34 is de-referenced from the CURRENT body (below); the VERDICT
          // itself never found it satisfied either -- proves the delete is
          // driven by de-reference alone, not by verdict outcome.
          { criterionId: "34:0", satisfied: false, rationale: "De-referenced, but never actually fixed." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 34, kind: "closing", criterionId: "34:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [12, 34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    const { fetchMock, calls } = mockFetch({
      // The CURRENT body only references #12 -- #34's own reference was
      // removed since the review ran (a body-only edit).
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      // Both #12's and #34's own comments already exist, from a PRIOR
      // (older-generation) run.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 101,
            body: `Still-live blocker.\n${stillLiveMarker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 102,
            body: `De-referenced, but never actually fixed.\n${dereferencedMarker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/101": () => jsonResponse({}),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/102": () => new Response(null, { status: 204 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    // #12's own comment is PATCHed (still closing-referenced, still unmet).
    expect(calls.some((c) => c.method === "PATCH" && c.url.endsWith("/pulls/comments/101"))).toBe(true);
    // #34's own comment is DELETED by this same run's own reconciliation
    // -- de-referenced from the current body, regardless of the verdict's
    // own (irrelevant here) satisfaction outcome.
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/pulls/comments/102"))).toBe(true);

    const summaryPost = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const summaryBody = (summaryPost?.body as { body: string }).body;
    expect(summaryBody).toMatch(
      /#34[\s\S]*were NOT posted inline[\s\S]*positively confirm was safe to remove has been deleted/i,
    );
  });

  it("FAILS CLOSED (visible fallback, exit 1, no summary posted) when the PR's closing-reference SET SIZE changed between this run's own earlier snapshot and the re-verify inside the reconcile, immediately before its first delete (F1-S9 slice 90.4, PR #95 review round 4, Codex, P1, cid 3625635480 -- a mismatch means BOTH this run's own posting decisions AND the reconcile are stale, so the whole run fails closed rather than publishing a stale summary)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "34:0", satisfied: false, rationale: "Still genuinely unmet." }] },
      spine: {
        entries: [{ issueNumber: 34, kind: "closing", criterionId: "34:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    let prFetchCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCount += 1;
        // FIRST call (fetchAndVerifyPrShas, the early snapshot): body has
        // no closing reference at all -- #34 is de-referenced, snapshot
        // set is EMPTY. SECOND call (the reconcile's own internal
        // re-verify, after its own comment pagination, immediately before
        // its delete loop): a race landed -- the body now ALSO references
        // #99 as closing, growing the set from size 0 to size 1 (a size
        // MISMATCH, not just a different single element).
        return prFetchHandlerWithOverrides({ body: prFetchCount === 1 ? "" : "Closes #99" });
      },
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(prFetchCount).toBe(2);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/references changed since this run's own earlier snapshot/i);
  });

  it.each([
    ["head", /head SHA changed after this run's reviewed snapshot/i, { headSha: "moved-head" }],
    ["base", /base SHA changed after this run's reviewed snapshot/i, { baseSha: "moved-base" }],
  ] as const)(
    "fails closed with the specific %s-drift fallback and no delete when PR identity changes during reconciliation",
    async (_dimension, expectedFallback, overrides) => {
      const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
        verdict: { findings: [{ criterionId: "34:0", satisfied: false, rationale: "Still genuinely unmet." }] },
        spine: {
          entries: [{ issueNumber: 34, kind: "closing", criterionId: "34:0" }],
          truncated: false,
          unreviewedClosingIssues: [],
          diffTruncated: false,
          reviewedClosingIssueNumbers: [34],
          reviewedBaseSha: TRUSTED_BASE_SHA,
        },
      });
      process.env.OUTCOME_PATH = outcomePath;
      process.env.VERDICT_PATH = verdictPath;
      process.env.CRITERIA_SPINE_PATH = spinePath;
      let prFetchCount = 0;
      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
          prFetchCount += 1;
          return prFetchHandlerWithOverrides({
            body: "",
            ...(prFetchCount === 1 ? {} : overrides),
          });
        },
        "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
        "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
        "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
      });
      vi.stubGlobal("fetch", fetchMock);

      await main();

      expect(process.exitCode).toBe(1);
      expect(prFetchCount).toBe(2);
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
      const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
      const body = (post?.body as { body: string }).body;
      expect(body).toMatch(expectedFallback);
      expect(body).toMatch(/failing closed without deleting any blocker/i);
    },
  );

  it("FAILS CLOSED when the closing-reference set is the SAME SIZE but a DIFFERENT issue number between the snapshot and the reconcile's own internal re-verify (F1-S9 slice 90.4, PR #95 review round 4, Codex, P1 -- the element-mismatch branch, distinct from the size-mismatch one)", async () => {
    const marker = criterionBlockerCommentMarker("34:0");
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "34:0", satisfied: false, rationale: "Still genuinely unmet." }] },
      spine: {
        entries: [{ issueNumber: 34, kind: "closing", criterionId: "34:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    process.env.GITHUB_RUN_NUMBER = "2";
    let prFetchCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCount += 1;
        // FIRST call: closing set is {34}. SECOND call (the reconcile's
        // own internal re-verify): SAME SIZE (one closing reference) but
        // a DIFFERENT issue number (#99, not #34) -- #34 was
        // de-referenced AND #99 was newly closed in the same edit,
        // landing between the snapshot and the re-verify.
        return prFetchHandlerWithOverrides({ body: prFetchCount === 1 ? "Closes #34" : "Closes #99" });
      },
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 201,
            body: `Was still live.\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      // #34 already has a matching existing comment (id 201) at the
      // snapshot body ("Closes #34"), so tryPostBlockersInline PATCHes it
      // in place rather than creating a new one -- this run's own
      // POSTING succeeds normally; only the LATER reconcile detects the
      // race and fails the whole run closed.
      "PATCH /repos/syamaner/roastpilot-cloud/pulls/comments/201": () => jsonResponse({}),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    // #34's own PRIOR comment (id 201) is left untouched -- the
    // reconcile's own re-verify detected the set changed (even though the
    // SIZE matched) and never reached its delete loop at all.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(prFetchCount).toBe(2);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/references changed since this run's own earlier snapshot/i);
  });

  it("FAILS CLOSED (never publishes a MISCLASSIFIED bucket note) when a body edit lands between this run's own T0 snapshot and the reconcile's own re-verify in a way that would flip #34 from DOWNGRADED to fully DE-REFERENCED -- CRITICALLY, the CLOSING-kind set alone is UNCHANGED by this exact edit (still {12} both before and after), so only the ANY-KIND re-verify (Codex cid 3626169271, made load-bearing by the F1-S9 slice 90.6a bucket-split) catches it; a closing-only re-verify would have missed this drift entirely and let a stale, wrongly-worded 'downgraded' note publish for an issue that is actually gone", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [
          { criterionId: "12:0", satisfied: false, rationale: "Still-live blocker." },
          { criterionId: "34:0", satisfied: false, rationale: "Would be classified downgraded at T0." },
        ],
      },
      spine: {
        entries: [
          { issueNumber: 12, kind: "closing", criterionId: "12:0" },
          { issueNumber: 34, kind: "closing", criterionId: "34:0" },
        ],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [12, 34],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    let prFetchCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCount += 1;
        // T0 (fetchAndVerifyPrShas, this run's own snapshot -- ALSO the
        // exact body tryPostBlockersInline's own bucket-split classifies
        // #34 against): #12 closing, #34 downgraded but still referenced
        // -- currentlyClosingIssueNumbers={12}, currentlyReferencedIssueNumbers={12,34}.
        // Call 2+ (the reconcile's own internal re-verify): #34 is
        // REMOVED entirely -- currentlyClosingIssueNumbers is STILL {12}
        // (unchanged!), but currentlyReferencedIssueNumbers shrinks to
        // {12}. A closing-only re-verify would see NO drift at all here.
        return prFetchHandlerWithOverrides({ body: prFetchCount === 1 ? "Closes #12, refs #34" : "Closes #12" });
      },
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(DIFF_WITH_ANCHOR),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/pulls/83/comments": () => jsonResponse({ id: 1 }, 201),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    // The reconcile's any-kind re-verify caught the drift and the whole
    // run failed closed -- never reaching a delete, and never reaching
    // this fix's own T2 preWriteCheck (a 3rd /pulls/83 fetch) either,
    // since publishSummary returns immediately on the reconcile failure.
    expect(process.exitCode).toBe(1);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(prFetchCount).toBe(2);
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/references changed since this run's own earlier snapshot/i);
    // Neither bucket-split note was ever built or published -- correct
    // OR incorrect wording, for #34 or anyone else.
    expect(body).not.toMatch(/were NOT posted inline/i);
    expect(body).not.toMatch(/no longer references them at all/i);
    expect(body).not.toMatch(/still references them, but no longer with a closing keyword/i);
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
    expect(summaryBody).toContain("1 current-applicable blocking finding(s)");
    expect(summaryBody).toMatch(
      /review also identified 1 blocking finding for an issue that is no longer a closing obligation/i,
    );
  });

  it("degrades to the fallback summary and exits nonzero when the diff has NO addable line at all (anchorFallbackNeeded, structural) -- reconciliation STILL runs (F1-S9 slice 90.4, redesigned, Fork-1: unconditional) even though this run's own new blockers could not post inline", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir);
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      // Reconciliation's own fetch -- runs unconditionally now, even
      // though this run's OWN new blockers degraded to the fallback below.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/pulls/83/comments"))).toBe(true);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("1 current-applicable blocking finding(s)");
    expect(body).toMatch(/unresolved inline review thread\(s\) and\/or the fallback details below/i);
    expect(body).toContain("Missing the retry wrapper.");
    // NOT a categorical "no inline thread for them" claim (F1-S9 slice
    // 90.6a, PR #99 review, Codex, cid 3627450889, P2) -- see the sibling
    // assertions above in this file for the full reasoning.
    expect(body).toMatch(/resolve any inline thread that already exists for one of these first/i);
  });

  it("degrades to the fallback summary and exits nonzero when the FIRST inline POST is rejected with a 422 (the probe-then-degrade, not a genuine error) -- reconciliation STILL runs (F1-S9 slice 90.4, redesigned, Fork-1: unconditional)", async () => {
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
    expect(body).toContain("1 current-applicable blocking finding(s)");
    expect(body).toMatch(/unresolved inline review thread\(s\) and\/or the fallback details below/i);
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
    // F1-S9 slice 90.4, redesigned: TWO GETs to this endpoint, both real
    // -- one from postInlineCommentPlan's own internal fetch (attempting,
    // and 422-failing, the post), one from this SAME run's own
    // reconciliation, which runs UNCONDITIONALLY now regardless of
    // whether this run's own new blockers posted inline.
    expect(calls.filter((c) => c.method === "GET" && c.url.includes("/pulls/83/comments")).length).toBe(2);
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
      // F1-S9 slice 90.4: reconciliation always runs on the zero-blocker
      // path -- fetches existing inline comments to find (none here)
      // anything obsolete to delete.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
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
      // Explicit body needed (F1-S9 slice 90.5b, PR #96 review round 2,
      // Codex, cid 3626169268): the diff-truncation blocker now depends on
      // the PR's CURRENT body still referencing #12 as closing, not merely
      // on the review-time spine -- the bare `prFetchHandler` returns
      // `body: null`, which would (correctly, under the fix) suppress this
      // blocker entirely, since there'd be no live closing claim left to
      // protect.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      // Reconciliation's own fetch -- runs unconditionally now (F1-S9
      // slice 90.4, redesigned), even on this degraded (no-addable-anchor)
      // blocker-bearing path.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("1 current-applicable blocking finding(s)");
    expect(body).toMatch(/this pr's own diff was truncated/i);
  });

  it("does not re-post or keep counting a diff-truncation blocker after its only closing reference is downgraded, and deletes the obsolete prior aggregate (F1-S9 slices 90.5b and 90.6a-3)", async () => {
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
      // #12 downgraded from Closes to Refs since the review ran -- no
      // longer a live closing claim for the truncated diff to protect.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Refs #12" }),
      // NOT actually called (F1-S9 slice 90.5b, PR #97 draft round 3, Codex,
      // cid 3626596213): `tryPostBlockersInline`'s own current-state
      // recompute finds nothing left to plan or post, so it early-returns
      // BEFORE ever fetching the diff -- this handler is registered
      // defensively only, in case a future regression reintroduces the
      // unconditional fetch this fix removed.
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      // Reconciliation runs unconditionally and now removes the prior
      // whole-run aggregate whose current applicability flipped false.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 41,
            body:
              `obsolete whole-run blocker\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/41": () => new Response(null, { status: 204 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("No blocking findings.");
    expect(body).not.toMatch(/this pr's own diff was truncated/i);
    expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/pulls/comments/41"))).toBe(true);
  });

  it("fails closed during duplicate aggregate cleanup, reports the partial delete, and never publishes the normal summary", async () => {
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
    let prFetchCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCount += 1;
        return prFetchHandlerWithOverrides({ body: prFetchCount < 4 ? "Refs #12" : "Closes #12" });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () =>
        jsonResponse(
          [41, 42].map((id) => ({
            id,
            body:
              `duplicate obsolete aggregate ${id}\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/syamaner/roastpilot-cloud/pulls/comments/41": () => new Response(null, { status: 204 }),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(prFetchCount).toBe(4);
    expect(calls.filter((call) => call.method === "DELETE").map((call) => call.url)).toEqual([
      expect.stringMatching(/pulls\/comments\/41$/),
    ]);
    const post = calls.find((call) => call.method === "POST" && call.url.endsWith("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/linked-issue references changed/i);
    expect(body).toMatch(/after deleting 1 blocker comment\(s\) while the snapshot still matched/i);
    expect(body).toMatch(/no blocker was deleted after drift was detected/i);
  });

  it("does NOT re-create the diff-truncation aggregate blocker via a currently-closing but FULLY-SATISFIED 'phantom' issue once the real review-time blocker has been downgraded (F1-S9 slice 90.5b, PR #97 draft round 2, Codex, cid 3626534230, P1 -- the completed fix for the same permanent-over-gate class cid 3626169268 first closed): #12 was a real review-time criterion blocker on a closing keyword, since downgraded to a plain reference; #13 is a SEPARATE issue this run also reviewed and found fully satisfied (zero unmet criteria -- so it has neither a `joined` entry nor an `unreviewedClosingIssues` entry, only a `reviewedClosingIssueNumbers` trace), and is STILL currently closing-referenced. The buggy `currentlyClosingIssueNumbers.size > 0` check would go true from #13 alone and re-create the aggregate; the fix must not", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: false, rationale: "Missing the retry wrapper." }] },
      spine: {
        entries: [{ issueNumber: 12, kind: "closing", criterionId: "12:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: true,
        // Both #12 and #13 were fetched and reviewed this run (#13 simply
        // had nothing unmet, so it never produced a spine entry at all --
        // the same "omitted from specs entirely" shape as the 90.2
        // regression class).
        reviewedClosingIssueNumbers: [12, 13],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      // #12 downgraded from Closes to Refs since the review ran; #13 is a
      // brand-new closing reference this run already reviewed (fully
      // satisfied) -- still closing-referenced right now.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () =>
        prFetchHandlerWithOverrides({ body: "Refs #12, closes #13" }),
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse(""),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    // The review-time criterion blocker (#12) was downgraded, so nothing
    // remains current-applicable: no inline attempt and no fallback exit.
    expect(process.exitCode).toBeUndefined();
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("No current-applicable blocking findings.");
    expect(body).toMatch(/review-time blocking findings.*note\(s\) below/i);
    // The specific bug this test proves fixed: no aggregate diff-truncation
    // blocker was fabricated from #13's mere presence in
    // `currentlyClosingIssueNumbers` alone.
    expect(body).not.toMatch(/this pr's own diff was truncated/i);
    const inlinePost = calls.find(
      (c) => c.method === "POST" && c.url.includes("/pulls/83/comments"),
    );
    expect(inlinePost).toBeUndefined();
  });

  it("never calls the diff-compare API at all -- and so survives it being down -- once the current-state recompute finds nothing left to plan or post (F1-S9 slice 90.5b, PR #97 draft round 3, Codex, cid 3626596213, P2): the caller only reaches tryPostBlockersInline on a nonzero REVIEW-TIME blocker count (here, the diff-truncation term alone), but the only closing reference it was protecting can still have been downgraded since -- leaving nothing for the network round-trip to be worth. A transient compare-API failure must not over-gate a run with no real blocking obligation left", async () => {
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
      // #12 downgraded from Closes to Refs since the review ran -- no
      // longer a live closing claim for the truncated diff to protect;
      // `criterionBlockers` was already empty (satisfied: true), so
      // there is truly nothing left for tryPostBlockersInline to plan or
      // post once its own current-state recompute runs.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Refs #12" }),
      // Stubbed as a TRANSIENT failure, deliberately -- proves the early
      // return happens BEFORE this call, not merely that this call happens
      // to succeed. If a future regression reintroduces the unconditional
      // fetch this fix removed, this test fails loudly (a thrown
      // GithubApiError surfacing as a visible fallback + exitCode 1)
      // instead of silently passing.
      [`GET /repos/syamaner/roastpilot-cloud/compare/${TRUSTED_BASE_SHA}...${TRUSTED_HEAD_SHA}`]: () =>
        textResponse("service unavailable", 500),
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const compareCall = calls.find((c) => c.url.includes("/compare/"));
    expect(compareCall).toBeUndefined();
    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("No blocking findings.");
  });

  it("FAILS CLOSED, rather than publishing a narrowed all-clear, when the PR body changes AGAIN between the reconcile's own re-verify and the publish itself (F1-S9 slice 90.5b, PR #97 draft round 4, Codex, cid 3626639088, P1 BLOCKER -- a genuine TOCTOU fail-open the #2 narrowing introduced): body=Refs #12 at this run's own first fetch (the diff-truncation term narrows to false, planning a clean all-clear) AND still at the reconcile's own re-verify (so that re-verify sees no drift and proceeds) -- but body=Closes #12 by the time this fix's own pre-publish re-verify runs, a THIRD, independent fetch. Without this fix, nothing would ever re-check the body a third time, and this run would publish 'No blocking findings' + exit 0 for a closing claim it never verified against this run's own truncated diff", async () => {
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
    let prFetchCallCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCallCount += 1;
        // Call 1 (fetchAndVerifyPrShas, this run's own initial snapshot)
        // and call 2 (the reconcile's own pre-delete re-verify, inside
        // reconcileObsoleteInlineBlockerComments) both still see the
        // downgraded body -- an attacker's edit restoring the closing
        // keyword lands strictly AFTER call 2 but BEFORE call 3, this
        // fix's own pre-publish re-verify, which is the only thing that
        // catches it.
        const body = prFetchCallCount >= 3 ? "Closes #12" : "Refs #12";
        return prFetchHandlerWithOverrides({ body });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(prFetchCallCount).toBeGreaterThanOrEqual(3);
    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    expect(post).toBeDefined();
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/changed again since this run's own earlier snapshot/i);
    // Never got as far as a real inline-comment attempt on this failed run.
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/pulls/83/comments"))).toBe(false);
  });

  it("fails closed when an any-kind reference disappears after non-blocking findings were filtered but before the summary write", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: {
        findings: [{ criterionId: "12:0", satisfied: false, rationale: "MUST_NOT_PUBLISH_STALE_CONTEXT" }],
      },
      spine: {
        entries: [{ issueNumber: 12, kind: "non-closing", criterionId: "12:0" }],
        truncated: false,
        unreviewedClosingIssues: [],
        diffTruncated: false,
        reviewedClosingIssueNumbers: [],
        reviewedBaseSha: TRUSTED_BASE_SHA,
      },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    let prFetchCallCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCallCount += 1;
        return prFetchHandlerWithOverrides({
          body: prFetchCallCount >= 3 ? "No linked issues remain." : "Refs #12",
        });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(prFetchCallCount).toBeGreaterThanOrEqual(3);
    expect(process.exitCode).toBe(1);
    const post = calls.find((call) => call.method === "POST" && call.url.includes("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).toMatch(/changed again since this run's own earlier snapshot/i);
    expect(body).not.toContain("MUST_NOT_PUBLISH_STALE_CONTEXT");
  });

  it("posts a visible fallback and exits nonzero when this run's own pre-write reference/head-SHA re-verify genuinely fails (F1-S9 slice 90.5b, PR #97 draft round 5) -- a genuine (non-drift) network failure on the THIRD `/pulls/83` fetch, never silently swallowed or treated as a clean all-clear", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    let prFetchCallCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCallCount += 1;
        // Call 1 (fetchAndVerifyPrShas, this run's own initial snapshot)
        // and call 2 (the reconcile's own pre-delete re-verify) both
        // succeed; call 3 -- this fix's own preWriteCheck, threaded into
        // upsertSummaryComment and firing AFTER findExistingSummaryComment's
        // own pagination -- hits a transient GitHub outage.
        if (prFetchCallCount >= 3) {
          return new Response("service unavailable", { status: 500 });
        }
        return prFetchHandler();
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(prFetchCallCount).toBeGreaterThanOrEqual(3);
    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/failed to re-verify this pr's identity and linked-issue references immediately before publishing/i);
    expect(body).toMatch(/500/);
  });

  it("FAILS CLOSED, rather than publishing a narrowed all-clear, when the PR body is restored DURING findExistingSummaryComment's own multi-page pagination (F1-S9 slice 90.5b, PR #97 draft round 5, Codex, cid 3626686028, P1 BLOCKER -- the residual window round 4's fix left open): body=Refs #12 at this run's own first fetch and at the reconcile's own re-verify; findExistingSummaryComment then genuinely paginates (a full page-1 of 100 unrelated comments, forcing a real page-2 fetch) before this fix's own preWriteCheck runs its THIRD, independent /pulls/83 fetch -- which is where the restored body=Closes #12 is finally caught, immediately before the write", async () => {
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
    let prFetchCallCount = 0;
    // A full page of 100 unrelated comments -- none carry the marker
    // findExistingSpecGroundingSummaryCommentId looks for -- forces
    // findExistingSummaryComment to fetch a genuine page 2, proving this
    // fix's own re-verify sits AFTER that real pagination, not merely
    // after a single, trivially-empty page.
    const unrelatedCommentsPage = Array.from({ length: 100 }, (_, i) => ({
      id: 9000 + i,
      body: "an unrelated human comment",
      user: { type: "User", login: "someone" },
    }));
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCallCount += 1;
        // Calls 1 (fetchAndVerifyPrShas) and 2 (the reconcile's own
        // pre-delete re-verify) both still see the downgraded body; the
        // restore lands strictly after those but before call 3 -- this
        // fix's own preWriteCheck, which only runs once pagination below
        // has fully completed.
        const body = prFetchCallCount >= 3 ? "Closes #12" : "Refs #12";
        return prFetchHandlerWithOverrides({ body });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () =>
        jsonResponse(unrelatedCommentsPage),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=2": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    // Real pagination happened (page 2 was actually fetched), and the
    // pre-publish re-verify ran strictly AFTER it (the third /pulls/83
    // fetch, which is what caught the restore).
    expect(calls.some((c) => c.url.includes("/issues/83/comments?per_page=100&page=2"))).toBe(true);
    expect(prFetchCallCount).toBeGreaterThanOrEqual(3);
    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/changed again since this run's own earlier snapshot/i);
    // Never actually wrote the stale, narrowed all-clear.
    expect(body).not.toMatch(/this pr's own diff was truncated/i);
  });

  it("FAILS CLOSED, rather than publishing a stale verdict, when the PR's head SHA changes between this run's own T0 snapshot and the pre-write re-verify (F1-S9 slice 90.5b, PR #97 draft round 5, security-reviewer MEDIUM -- a different dimension of the same TOCTOU shape cid 3626686028 closed for references): a push landing after this run's own trusted head SHA was captured but before the write must not let a verdict reviewed against the OLD head get published as if it still applied", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    let prFetchCallCount = 0;
    const MOVED_HEAD_SHA = "movedsha0000000000000000000000000000000";
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCallCount += 1;
        // Calls 1 and 2 still see this run's own trusted head; a push
        // lands strictly after those but before call 3 -- this fix's own
        // preWriteCheck, which reuses fetchAndVerifyPrShas and so throws
        // on this exact mismatch.
        const headSha = prFetchCallCount >= 3 ? MOVED_HEAD_SHA : TRUSTED_HEAD_SHA;
        return prFetchHandlerWithOverrides({ headSha, body: null });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(prFetchCallCount).toBeGreaterThanOrEqual(3);
    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/failed to re-verify this pr's identity and linked-issue references immediately before publishing/i);
    expect(body).toMatch(new RegExp(MOVED_HEAD_SHA));
  });

  it("FAILS CLOSED, rather than publishing a stale verdict, when the PR's BASE SHA changes between this run's own T0 snapshot and the pre-write re-verify (F1-S9 slice 90.5b, PR #97 draft round 6, Codex, cid 3626754037, P1 BLOCKER -- the third dimension of the same TOCTOU shape: unlike a head-SHA move, a base-branch advance fires no replacement run at all, so a stale verdict would stand permanently uncorrected): a target-branch push landing after this run's own T0 base snapshot but before the write, with the PR's head and linked-issue references BOTH unchanged, must still be caught", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    let prFetchCallCount = 0;
    const MOVED_BASE_SHA = "movedbasesha00000000000000000000000000000";
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => {
        prFetchCallCount += 1;
        // Calls 1 (fetchAndVerifyPrShas, T0) and 2 (the reconcile's own
        // pre-delete re-verify) both still see this run's own reviewed
        // base; the target branch advances strictly after those but
        // before call 3 -- this fix's own preWriteCheck. Head SHA and
        // body stay unchanged throughout, isolating this test to the
        // base-SHA dimension alone.
        const baseSha = prFetchCallCount >= 3 ? MOVED_BASE_SHA : TRUSTED_BASE_SHA;
        return prFetchHandlerWithOverrides({ baseSha, body: null });
      },
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "GET /repos/syamaner/roastpilot-cloud/issues/83/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/83/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(prFetchCallCount).toBeGreaterThanOrEqual(3);
    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/issues/83/comments"));
    const body = (post?.body as { body: string }).body;
    expect(body).not.toContain("No blocking findings.");
    expect(body).toMatch(/this pr's current base sha .* no longer matches the base this run's own review actually diffed against/i);
    expect(body).toMatch(new RegExp(MOVED_BASE_SHA));
    // Never actually wrote the stale, published verdict.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
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
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
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
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
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
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
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

describe("main — all-paths new-closing-reference check (F1-S9 slice 90.5, issue #12)", () => {
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
    // tryPostBlockersInline (or the reconcile) is ever reached -- no diff
    // fetch, no inline comment lookup or post, no reconcile fetch at all.
    // (The one /pulls/83 call itself is fetchAndVerifyPrShas's own,
    // unavoidable and legitimate -- Fork A needs THAT fetch's own pr.body.)
    expect(calls.some((c) => c.url.includes("/compare/"))).toBe(false);
    expect(calls.some((c) => c.url.includes("/pulls/83/comments"))).toBe(false);
    expect(calls.filter((c) => c.url === "https://api.github.com/repos/syamaner/roastpilot-cloud/pulls/83")).toHaveLength(1);
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
      // The de-reference reconcile runs unconditionally now (F1-S9 slice
      // 90.4), even on this zero-blocker path -- fetches existing inline
      // comments to find (none here) anything obsolete to delete.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
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

  it("happy path: publishes normally on the ZERO-blocker path when the only current closing reference is already known (ordinary case, no new-closing divergence)", async () => {
    const { outcomePath, verdictPath, spinePath } = await writeArtifacts(workdir, {
      verdict: { findings: [{ criterionId: "12:0", satisfied: true, rationale: "Retry wrapper is present." }] },
    });
    process.env.OUTCOME_PATH = outcomePath;
    process.env.VERDICT_PATH = verdictPath;
    process.env.CRITERIA_SPINE_PATH = spinePath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/pulls/83": () => prFetchHandlerWithOverrides({ body: "Closes #12" }),
      // The de-reference reconcile runs unconditionally now (F1-S9 slice
      // 90.4), even on this zero-blocker path.
      "GET /repos/syamaner/roastpilot-cloud/pulls/83/comments?per_page=100&page=1": () => jsonResponse([]),
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
