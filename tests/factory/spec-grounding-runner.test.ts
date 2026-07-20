import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/factory/spec-grounding-runner.mts";

/**
 * Integration-style tests for slice 3b-i's CLI entrypoint: stub `fetch`
 * (no real network) and drive `main()` through env vars, the same inputs
 * the workflow wires up. The extraction/rendering decisions themselves are
 * unit-tested in spec-grounding-logic.test.ts and
 * spec-grounding-runner-logic.test.ts; this file proves the entrypoint
 * wires them together correctly end to end, including both early exits,
 * the fetch-count cap, the fail-closed issue-fetch behavior, and the
 * trusted-head-SHA verification (all PR #72 review folds).
 */

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly accept: string | undefined;
}

function mockFetch(handlers: Record<string, (call: FetchCall) => Response>): {
  fetchMock: ReturnType<typeof vi.fn>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const accept =
      init?.headers && typeof init.headers === "object"
        ? (init.headers as Record<string, string>)["Accept"]
        : undefined;
    const call: FetchCall = { url, method, accept };
    calls.push(call);
    const path = url.replace("https://api.github.com", "");
    const key = `${method} ${path} accept=${accept}`;
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

const JSON_ACCEPT = "application/vnd.github+json";
const DIFF_ACCEPT = "application/vnd.github.v3.diff";
const HEAD_SHA = "head-sha-abc123";
const BASE_SHA = "base-sha-def456";

/** A PR JSON response with the trusted head/base SHAs, overridable per test. */
function prResponse(
  body: string | null,
  overrides?: { headSha?: string; baseSha?: string; changedFiles?: number },
): Response {
  return jsonResponse({
    body,
    head: { sha: overrides?.headSha ?? HEAD_SHA },
    base: { sha: overrides?.baseSha ?? BASE_SHA },
    changed_files: overrides?.changedFiles ?? 1,
  });
}

const PULLS_JSON_KEY = `GET /repos/syamaner/roastpilot-cloud/pulls/70 accept=${JSON_ACCEPT}`;
const COMPARE_DIFF_KEY = `GET /repos/syamaner/roastpilot-cloud/compare/${BASE_SHA}...${HEAD_SHA} accept=${DIFF_ACCEPT}`;

let workdir: string;
let criteriaBlockPath: string;
let criteriaSpinePath: string;
let prDiffBlockPath: string;
let githubOutputPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "spec-grounding-runner-"));
  criteriaBlockPath = join(workdir, "criteria-data-block.txt");
  criteriaSpinePath = join(workdir, "criteria-spine.json");
  prDiffBlockPath = join(workdir, "pr-diff-block.txt");
  githubOutputPath = join(workdir, "github-output.txt");

  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "syamaner/roastpilot-cloud";
  process.env.TRUSTED_PR_NUMBER = "70";
  process.env.TRUSTED_HEAD_SHA = HEAD_SHA;
  process.env.CRITERIA_BLOCK_PATH = criteriaBlockPath;
  process.env.CRITERIA_SPINE_PATH = criteriaSpinePath;
  process.env.PR_DIFF_BLOCK_PATH = prDiffBlockPath;
  process.env.GITHUB_OUTPUT = githubOutputPath;
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.TRUSTED_PR_NUMBER;
  delete process.env.TRUSTED_HEAD_SHA;
  delete process.env.CRITERIA_BLOCK_PATH;
  delete process.env.CRITERIA_SPINE_PATH;
  delete process.env.PR_DIFF_BLOCK_PATH;
  delete process.env.GITHUB_OUTPUT;
});

async function readOutput(): Promise<string> {
  return readFile(githubOutputPath, "utf-8").catch(() => "");
}

describe("main — no linked issue (first early exit)", () => {
  it("writes has-criteria=false and no context files, without ever fetching an issue or the diff", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Just a plain description, no keyword."),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(await readOutput()).toBe("has-criteria=false\n");
    await expect(readFile(criteriaBlockPath, "utf-8")).rejects.toThrow();
    // Exactly one fetch (the PR body) -- no issue or diff fetch at all.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("main — linked issue with no unmet criteria (second early exit)", () => {
  it("writes has-criteria=false and no context files, without ever fetching the diff", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12"),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({
          title: "An issue",
          body: "### Acceptance criteria\n- [x] Already done.",
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(await readOutput()).toBe("has-criteria=false\n");
    await expect(readFile(prDiffBlockPath, "utf-8")).rejects.toThrow();
    // Exactly two fetches (PR body + the one linked issue) -- no diff fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("main — trusted head SHA verification (PR #72 review fold)", () => {
  it("fails closed when the PR's current head SHA does not match the trusted event head SHA", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12", { headSha: "some-other-sha-the-pr-moved-to" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/does not match the trusted/);
    // Never reaches an issue or diff fetch once the SHA check fails.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("main — real unmet criteria", () => {
  it("writes all three context files and has-criteria=true, fetching the diff via the SHA-pinned compare endpoint", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12"),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({
          title: "An issue",
          body: "### Acceptance criteria\n- [ ] Do the thing.",
        }),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n+did the thing\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(await readOutput()).toBe("has-criteria=true\n");

    const criteriaBlock = await readFile(criteriaBlockPath, "utf-8");
    expect(criteriaBlock).toContain("Do the thing.");
    expect(criteriaBlock.startsWith("<UNTRUSTED_ISSUE_DATA>")).toBe(true);

    const spine = JSON.parse(await readFile(criteriaSpinePath, "utf-8")) as unknown;
    // No criterionText field -- the spine carries only trusted metadata
    // (Codex finding, PR #72 review round 2, BLOCKER).
    expect(spine).toEqual([{ issueNumber: 12, kind: "closing", criterionId: "12:0" }]);

    const diffBlock = await readFile(prDiffBlockPath, "utf-8");
    expect(diffBlock.startsWith("<UNTRUSTED_PR_DIFF>")).toBe(true);
    expect(diffBlock).toContain("+did the thing");
    // The PR changed well under GitHub's 300-file compare cap, so no
    // file-count truncation warning appears.
    expect(diffBlock).not.toContain("more files than GitHub's compare API");
  });

  it("surfaces a file-count truncation warning when the PR changes more files than GitHub's compare API returns in one response (Codex finding, PR #72 review round 2, MEDIUM -- a real silent-truncation gap: the diff media type carries no in-band marker for this, so the runner must detect it from the PR's own trusted changed_files count)", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12", { changedFiles: 301 }),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({
          title: "An issue",
          body: "### Acceptance criteria\n- [ ] Do the thing.",
        }),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n+did the thing\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const diffBlock = await readFile(prDiffBlockPath, "utf-8");
    expect(diffBlock).toContain("more files than GitHub's compare API");
    expect(diffBlock.startsWith("<UNTRUSTED_PR_DIFF>")).toBe(true);
    expect(diffBlock.endsWith("</UNTRUSTED_PR_DIFF>")).toBe(true);
  });

  it("does NOT warn when changed_files is exactly at the cap (300), only when it exceeds it", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12", { changedFiles: 300 }),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({
          title: "An issue",
          body: "### Acceptance criteria\n- [ ] Do the thing.",
        }),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n+did the thing\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const diffBlock = await readFile(prDiffBlockPath, "utf-8");
    expect(diffBlock).not.toContain("more files than GitHub's compare API");
  });

  it("tolerates a VERIFIED 404 issue fetch as \"nothing to say\" for that issue, without failing the whole run (buildLinkedIssueSpecs's own documented contract for a missing map entry)", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12\nRefs #8"),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        new Response("not found", { status: 404 }),
      [`GET /repos/syamaner/roastpilot-cloud/issues/8 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({
          title: "Another issue",
          body: "### Acceptance criteria\n- [ ] Still open.",
        }),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(await readOutput()).toBe("has-criteria=true\n");
    const spine = JSON.parse(await readFile(criteriaSpinePath, "utf-8")) as unknown;
    // Only issue #8's criterion survives -- #12's verified 404 degraded to
    // silence, not a thrown error and not a fabricated entry.
    expect(spine).toEqual([{ issueNumber: 8, kind: "non-closing", criterionId: "8:0" }]);
  });

  it.each([
    ["403 (auth/permissions, no Retry-After -- fails immediately, not a rate-limit case)", 403, undefined],
    // A Retry-After exceeding MAX_RETRY_AFTER_SECONDS (60) makes
    // shouldGiveUpOnRateLimit give up on the FIRST attempt, so this test
    // stays fast -- an unbounded/small Retry-After would exercise
    // githubRequest's real (slow) exponential-backoff retry loop instead,
    // which is githubRequest's own concern, already covered by
    // github-api.test.ts, not this test's.
    ["429 (rate limited, requested wait exceeds this client's retry budget)", 429, "9999"],
    ["500 (server error)", 500, undefined],
  ])(
    "FAILS CLOSED (does not tolerate, does not omit) on a %s issue-fetch failure -- a real fail-open security bug in an earlier version: a transient failure on a CLOSING issue must never silently omit its unmet criteria from the gate",
    async (_label, status, retryAfter) => {
      const { fetchMock } = mockFetch({
        [PULLS_JSON_KEY]: () => prResponse("Closes #12"),
        [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
          new Response("failure", {
            status,
            headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
          }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(main()).rejects.toThrow(/other than a verified 404/);
      // Never reaches has-criteria at all -- the whole run fails.
      expect(await readOutput()).toBe("");
    },
  );

  it("FAILS CLOSED on a network-level issue-fetch failure (fetch itself rejecting, not just a non-ok response)", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const accept =
        init?.headers && typeof init.headers === "object"
          ? (init.headers as Record<string, string>)["Accept"]
          : undefined;
      if (`${method} ${url.replace("https://api.github.com", "")} accept=${accept}` === PULLS_JSON_KEY) {
        return prResponse("Closes #12");
      }
      throw new TypeError("fetch failed: network error");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/other than a verified 404/);
    expect(await readOutput()).toBe("");
  });

  it("caps issue fetches at MAX_LINKED_ISSUES (20), per selectIssuesToFetch's own contract -- never fetches a reference beyond the cap", async () => {
    const manyRefs = Array.from({ length: 25 }, (_, i) => `Refs #${i + 1}`).join("\n");
    const handlers: Record<string, (call: FetchCall) => Response> = {
      [PULLS_JSON_KEY]: () => prResponse(manyRefs),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n"),
    };
    // Only the first 20 (first-appearance order) may ever be fetched --
    // registering handlers for just those 20 means fetch #21-25 would
    // throw "unexpected fetch call" if the cap were ever violated.
    for (let i = 1; i <= 20; i++) {
      handlers[`GET /repos/syamaner/roastpilot-cloud/issues/${i} accept=${JSON_ACCEPT}`] = () =>
        jsonResponse({ title: `Issue ${i}`, body: "no acceptance criteria section" });
    }
    const { fetchMock } = mockFetch(handlers);
    vi.stubGlobal("fetch", fetchMock);

    await main();

    // 1 (PR) + 20 (capped issue fetches) + 1 (diff), no more -- none of
    // the fetch handlers above cover issue #21-25, so the cap being
    // violated would fail this test with "unexpected fetch call" before
    // ever reaching these assertions.
    expect(fetchMock).toHaveBeenCalledTimes(22);
    // has-criteria is still TRUE here even though none of the 20 fetched
    // issues had any unmet criteria of their own: renderCriteriaDataBlock's
    // own documented behavior (spec-grounding-logic.mts) is to still render
    // a non-empty block when truncatedIssueCount > 0, so the fact that 5
    // referenced issues were never even looked up surfaces to the human
    // reviewer rather than being silently dropped.
    expect(await readOutput()).toBe("has-criteria=true\n");
    const criteriaBlock = await readFile(criteriaBlockPath, "utf-8");
    expect(criteriaBlock).toContain("5 more referenced issue(s) not shown");
  });
});

describe("main — a PR with no body at all", () => {
  it("treats a null PR body as empty text, not a crash", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse(null),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(await readOutput()).toBe("has-criteria=false\n");
  });
});

describe("main — GITHUB_OUTPUT unset", () => {
  it("still completes and writes context files, just without a has-criteria output line (matches a local/test invocation, never a real Actions run)", async () => {
    delete process.env.GITHUB_OUTPUT;
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12"),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({ title: "t", body: "### Acceptance criteria\n- [ ] c" }),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).resolves.toBeUndefined();
    await expect(readFile(criteriaBlockPath, "utf-8")).resolves.toContain("c");
  });
});

describe("main — malformed GITHUB_REPOSITORY", () => {
  it("throws a clear error rather than silently misrouting a fetch", async () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo-slug";
    await expect(main()).rejects.toThrow(/owner\/repo/);
  });
});
