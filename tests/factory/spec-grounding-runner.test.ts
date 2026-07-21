import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateDelimiterNonce, main } from "../../scripts/factory/spec-grounding-runner.mts";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/factory/spec-grounding-runner.mts", import.meta.url));

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

// A fixed, injected nonce for deterministic test fixtures (F1-S9 slice
// 3b-ii-a, issue #12 -- team-lead's sign-off explicitly calls for this:
// "Fixed-inject the nonce in tests for determinism"). DELIMITER_NONCE_OVERRIDE
// is read ONLY by generateDelimiterNonce() -- never set by any real
// workflow, so this has no effect outside this test file.
const TEST_NONCE = "deadbeefcafef00d";

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
  process.env.DELIMITER_NONCE_OVERRIDE = TEST_NONCE;
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
  delete process.env.DELIMITER_NONCE_OVERRIDE;
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

    // no-criteria-reason=no-references (PR #87 review, Codex, P1/medium
    // fold): no closing-keyword reference at all -- there was never any
    // obligation, distinct from the "self-attested complete" branch below.
    expect(await readOutput()).toBe("has-criteria=false\nno-criteria-reason=no-references\n");
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

    // no-criteria-reason=no-unmet-criteria (PR #87 review, Codex, P1/medium
    // fold): the linked issue's own acceptance criteria are SELF-ATTESTED
    // complete (checked off), never diff-verified -- a materially weaker
    // signal than the no-references branch above.
    expect(await readOutput()).toBe("has-criteria=false\nno-criteria-reason=no-unmet-criteria\n");
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

    expect(await readOutput()).toBe(`has-criteria=true\ndelimiter-nonce=${TEST_NONCE}\n`);

    const criteriaBlock = await readFile(criteriaBlockPath, "utf-8");
    expect(criteriaBlock).toContain("Do the thing.");
    expect(criteriaBlock.startsWith(`<UNTRUSTED_ISSUE_DATA_${TEST_NONCE}>`)).toBe(true);

    const spine = JSON.parse(await readFile(criteriaSpinePath, "utf-8")) as unknown;
    // No criterionText field -- the spine carries only trusted metadata
    // (Codex finding, PR #72 review round 2, BLOCKER). Top-level wrapper
    // shape (Codex finding, PR #76 review, L181): `entries` is the array
    // the agent's own criterionId correlation matches against; `truncated`
    // / `unreviewedClosingIssues` are new trusted metadata for slice
    // 3b-iii only -- both false/empty here, nothing was truncated.
    // `reviewedClosingIssueNumbers` (F1-S9 slice 90.2) includes #12 --
    // it's the sole closing-kind reference, fetched within cap.
    expect(spine).toEqual({
      entries: [{ issueNumber: 12, kind: "closing", criterionId: "12:0" }],
      truncated: false,
      unreviewedClosingIssues: [],
      diffTruncated: false,
      reviewedClosingIssueNumbers: [12],
    });

    const diffBlock = await readFile(prDiffBlockPath, "utf-8");
    expect(diffBlock.startsWith(`<UNTRUSTED_PR_DIFF_${TEST_NONCE}>`)).toBe(true);
    expect(diffBlock).toContain("+did the thing");
    // The PR changed well under GitHub's 300-file compare cap, so no
    // file-count truncation warning appears.
    expect(diffBlock).not.toContain("more files than GitHub's compare API");
  });

  it("generates a REAL CSPRNG nonce (128 bits, 32 lowercase hex chars) when DELIMITER_NONCE_OVERRIDE is unset -- the production path, never exercised by any other test in this file (F1-S9 slice 3b-ii-a, issue #12, team-lead's sign-off: >=128-bit CSPRNG floor)", async () => {
    delete process.env.DELIMITER_NONCE_OVERRIDE;
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12"),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({
          title: "An issue",
          body: "### Acceptance criteria\n- [ ] Do the thing.",
        }),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const output = await readOutput();
    const match = /delimiter-nonce=([0-9a-f]+)\n/.exec(output);
    expect(match).not.toBeNull();
    // 16 bytes = 32 lowercase hex characters.
    expect(match?.[1]).toHaveLength(32);
  });

  it("uses a DIFFERENT nonce on each separate run (proving real randomness, not a hardcoded or memoized fallback)", async () => {
    delete process.env.DELIMITER_NONCE_OVERRIDE;
    const makeHandlers = (): Record<string, (call: FetchCall) => Response> => ({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12"),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({ title: "An issue", body: "### Acceptance criteria\n- [ ] Do the thing." }),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n"),
    });

    vi.stubGlobal("fetch", mockFetch(makeHandlers()).fetchMock);
    await main();
    const firstOutput = await readOutput();
    const firstNonce = /delimiter-nonce=([0-9a-f]+)\n/.exec(firstOutput)?.[1];

    // Fresh output file + fresh mock for the second run.
    githubOutputPath = join(workdir, "github-output-2.txt");
    process.env.GITHUB_OUTPUT = githubOutputPath;
    vi.stubGlobal("fetch", mockFetch(makeHandlers()).fetchMock);
    await main();
    const secondOutput = await readOutput();
    const secondNonce = /delimiter-nonce=([0-9a-f]+)\n/.exec(secondOutput)?.[1];

    expect(firstNonce).toBeDefined();
    expect(secondNonce).toBeDefined();
    expect(firstNonce).not.toBe(secondNonce);
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
    expect(diffBlock.startsWith(`<UNTRUSTED_PR_DIFF_${TEST_NONCE}>`)).toBe(true);
    expect(diffBlock.endsWith(`</UNTRUSTED_PR_DIFF_${TEST_NONCE}>`)).toBe(true);

    // Slice 3b-iii, issue #12, PR #76 review, L733: pr-diff-block.txt
    // itself is never uploaded as an artifact -- only criteria-spine.json
    // and the agent's verdict are. So the spine is where this truncation
    // signal must also surface, alongside (not instead of) criteria
    // truncation, so 3b-iii can fail-closed on either kind.
    const spine = JSON.parse(await readFile(criteriaSpinePath, "utf-8")) as unknown;
    expect(spine).toMatchObject({ diffTruncated: true });
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

    expect(await readOutput()).toBe(`has-criteria=true\ndelimiter-nonce=${TEST_NONCE}\n`);
    const spine = JSON.parse(await readFile(criteriaSpinePath, "utf-8")) as unknown;
    // Only issue #8's criterion survives -- #12's verified 404 degraded to
    // silence, not a thrown error and not a fabricated entry. #12 is a
    // CLOSING reference ("Closes #12") that ends up with zero spine
    // entries too, same as a genuinely truncated one would -- but a
    // verified 404 is an accepted, deliberate no-op (the issue is simply
    // gone), NOT a truncation gap, so unreviewedClosingIssues must stay
    // empty here (Codex finding, PR #76 review, L181's own scope: only a
    // resource-capped drop escalates, never a confirmed-deleted issue).
    // reviewedClosingIssueNumbers (F1-S9 slice 90.2) still includes #12,
    // even though it has no spine entry and never landed in
    // unreviewedClosingIssues either: #12 was a closing reference WITHIN
    // the fetch cap, and the 404 is the SAME "attempted, nothing further
    // to say" outcome this field's own docstring treats as reviewed --
    // exactly the case this field exists to make distinguishable from a
    // reference genuinely never looked at.
    expect(spine).toEqual({
      entries: [{ issueNumber: 8, kind: "non-closing", criterionId: "8:0" }],
      truncated: false,
      unreviewedClosingIssues: [],
      diffTruncated: false,
      reviewedClosingIssueNumbers: [12],
    });
  });

  it("includes a FULLY-SATISFIED closing issue in reviewedClosingIssueNumbers even though it has NO spine entry at all and never appears in unreviewedClosingIssues either (F1-S9 slice 90.2 -- the exact gap this field closes: buildLinkedIssueSpecs silently omits an issue with zero unmet criteria from result.specs entirely, so without this field there was no trace anywhere that this closing reference was ever reviewed)", async () => {
    const { fetchMock } = mockFetch({
      [PULLS_JSON_KEY]: () => prResponse("Closes #12\nRefs #8"),
      [`GET /repos/syamaner/roastpilot-cloud/issues/12 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({
          title: "An issue",
          // Every acceptance criterion already checked off -- ZERO unmet
          // criteria, so buildLinkedIssueSpecs omits issue #12 from
          // result.specs entirely, same as if it had never been fetched
          // at all from that function's own perspective.
          body: "### Acceptance criteria\n- [x] Already done.",
        }),
      [`GET /repos/syamaner/roastpilot-cloud/issues/8 accept=${JSON_ACCEPT}`]: () =>
        jsonResponse({
          title: "Another issue",
          body: "### Acceptance criteria\n- [ ] Still open.",
        }),
      [COMPARE_DIFF_KEY]: () => textResponse("diff --git a/x b/x\n"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const spine = JSON.parse(await readFile(criteriaSpinePath, "utf-8")) as unknown;
    // #12 has NO entry (zero unmet criteria) and is absent from
    // unreviewedClosingIssues (fully satisfied is not a truncation gap --
    // computeCriteriaSpineTruncation's own docstring). Only
    // reviewedClosingIssueNumbers carries any trace that #12 was ever
    // looked at as a closing reference.
    expect(spine).toEqual({
      entries: [{ issueNumber: 8, kind: "non-closing", criterionId: "8:0" }],
      truncated: false,
      unreviewedClosingIssues: [],
      diffTruncated: false,
      reviewedClosingIssueNumbers: [12],
    });
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
    expect(await readOutput()).toBe(`has-criteria=true\ndelimiter-nonce=${TEST_NONCE}\n`);
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

    // A null body -> parsed as empty text -> zero references -> the
    // no-references branch (never any obligation to begin with).
    expect(await readOutput()).toBe("has-criteria=false\nno-criteria-reason=no-references\n");
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

describe("generateDelimiterNonce (F1-S9 slice 3b-ii-a, issue #12, PR pre-open pass fold)", () => {
  it("test mode (VITEST=true, always the case in this suite) accepts a valid lowercase-hex override", () => {
    process.env.DELIMITER_NONCE_OVERRIDE = "0123456789abcdef";
    expect(generateDelimiterNonce()).toBe("0123456789abcdef");
    delete process.env.DELIMITER_NONCE_OVERRIDE;
  });

  it("test mode REJECTS an empty override -- the '??' foot-gun this fold closes: an empty string is not null/undefined, so a naive '??' fallback would have silently produced nonce=''", () => {
    process.env.DELIMITER_NONCE_OVERRIDE = "";
    expect(() => generateDelimiterNonce()).toThrow(/non-empty lowercase hex/);
    delete process.env.DELIMITER_NONCE_OVERRIDE;
  });

  it.each([
    ["uppercase hex", "DEADBEEF"],
    ["non-hex characters", "not-hex-at-all"],
    ["a literal newline -- the $GITHUB_OUTPUT-injection vector this fold closes", "x\nhas-criteria=false"],
  ])("test mode REJECTS %s", (_label, invalidOverride) => {
    process.env.DELIMITER_NONCE_OVERRIDE = invalidOverride;
    expect(() => generateDelimiterNonce()).toThrow(/non-empty lowercase hex/);
    delete process.env.DELIMITER_NONCE_OVERRIDE;
  });

  it("PRODUCTION (VITEST unset) ALWAYS ignores DELIMITER_NONCE_OVERRIDE and takes the real CSPRNG path, even when an override is set -- re-imports the module fresh (vi.resetModules) since the production/test gate is evaluated once at module load, the same class of 'must genuinely run outside the test runner's own signal' case the self-invoke guard's subprocess test already established a precedent for in this file", async () => {
    const originalVitest = process.env.VITEST;
    process.env.DELIMITER_NONCE_OVERRIDE = "0123456789abcdef";
    delete process.env.VITEST;
    vi.resetModules();
    try {
      const freshModule = await import("../../scripts/factory/spec-grounding-runner.mts");
      const nonce = freshModule.generateDelimiterNonce();
      expect(nonce).not.toBe("0123456789abcdef");
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      if (originalVitest === undefined) {
        delete process.env.VITEST;
      } else {
        process.env.VITEST = originalVitest;
      }
      delete process.env.DELIMITER_NONCE_OVERRIDE;
      vi.resetModules();
    }
  });
});

describe("self-invoke guard (codecov/patch coverage, PR #72 review, final gate)", () => {
  it("running the script directly (node --experimental-strip-types, the exact form triage-issues.yml/implement-ready-issues.yml use for their own sibling scripts) actually invokes main() and reports a failure on stderr with a non-zero exit code -- exercised as a REAL subprocess, not mocked, since this is the one path `import { main }`-style unit tests structurally cannot reach", () => {
    // Explicitly WITHOUT GH_TOKEN (and the other vars this suite's own
    // beforeEach sets for other describe blocks) -- requireEnv("GH_TOKEN")
    // throws synchronously before any network call, so this stays fast and
    // fully offline while still exercising main().catch(...) and the
    // exitCode assignment for real.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.GH_TOKEN;
    delete childEnv.GITHUB_REPOSITORY;
    delete childEnv.TRUSTED_PR_NUMBER;
    delete childEnv.TRUSTED_HEAD_SHA;
    const result = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT_PATH], {
      encoding: "utf-8",
      env: childEnv,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("spec-grounding-runner failed:");
    expect(result.stderr).toContain("missing required environment variable: GH_TOKEN");
  });
});
