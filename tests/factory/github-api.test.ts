import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideRateLimitResponse,
  GithubApiError,
  githubRequest,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RETRY_AFTER_SECONDS,
  MAX_TEXT_RESPONSE_LENGTH,
  MIN_RATE_LIMIT_FALLBACK_SECONDS,
  parseRateLimitResetWaitMs,
  parseRetryAfterMs,
  requireEnv,
} from "../../scripts/factory/github-api.mts";

describe("requireEnv", () => {
  afterEach(() => {
    delete process.env.TEST_VAR;
  });

  it("returns the value when set", () => {
    process.env.TEST_VAR = "hello";
    expect(requireEnv("TEST_VAR")).toBe("hello");
  });

  it("throws with the variable name when unset", () => {
    delete process.env.TEST_VAR;
    expect(() => requireEnv("TEST_VAR")).toThrow(/TEST_VAR/);
  });

  it("throws when set to an empty string", () => {
    process.env.TEST_VAR = "";
    expect(() => requireEnv("TEST_VAR")).toThrow(/TEST_VAR/);
  });
});

describe("githubRequest", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/ok")) {
          return new Response(JSON.stringify({ hello: "world" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/no-content")) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/error")) {
          return new Response("nope", { status: 403 });
        }
        throw new Error(`unexpected fetch to ${url} (${init?.method})`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on a 2xx response", async () => {
    const result = await githubRequest<{ hello: string }>(
      "tok",
      "GET",
      "/ok",
    );
    expect(result).toEqual({ hello: "world" });
  });

  it("returns undefined for a 204 No Content response", async () => {
    const result = await githubRequest("tok", "DELETE", "/no-content");
    expect(result).toBeUndefined();
  });

  it("throws, including the status and body, on a non-ok response", async () => {
    await expect(githubRequest("tok", "GET", "/error")).rejects.toThrow(
      /403/,
    );
  });

  it("throws a GithubApiError carrying the status as a structured field (F1-S9 slice 3b-i, issue #12, PR #72 review -- a caller needs to distinguish a verified 404 from every other failure for a fail-closed decision, which a plain Error's message text alone can't do reliably)", async () => {
    await expect(githubRequest("tok", "GET", "/error")).rejects.toMatchObject({
      name: "GithubApiError",
      status: 403,
    });
  });

  it("GithubApiError is a real Error subclass (instanceof works, so a catch block can narrow on it)", async () => {
    let caught: unknown;
    try {
      await githubRequest("tok", "GET", "/error");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GithubApiError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as GithubApiError).status).toBe(403);
  });

  it("sends the bearer token and a JSON body when provided", async () => {
    // `input` is typed but intentionally unused: it's here only so
    // fetchMock's inferred type matches fetch's signature, which is what
    // makes fetchMock.mock.calls type correctly below.
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await githubRequest("secret-token", "POST", "/ok", { a: 1 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("defaults to the JSON media type when `accept` is not overridden", async () => {
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) =>
        new Response(JSON.stringify({}), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await githubRequest("tok", "GET", "/ok");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ Accept: "application/vnd.github+json" });
  });

  it("sends a custom `accept` header when provided (F1-S9 slice 3b — the PR diff media type)", async () => {
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) =>
        new Response("diff --git a/x b/x\n", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await githubRequest("tok", "GET", "/ok", undefined, {
      accept: "application/vnd.github.v3.diff",
      responseType: "text",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ Accept: "application/vnd.github.v3.diff" });
  });

  it('returns the response as raw text when `responseType: "text"` is requested, instead of parsing it as JSON', async () => {
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) =>
        // Deliberately NOT valid JSON -- a raw unified diff never is. A
        // `responseType: "json"` (or default) call against this same body
        // would throw inside `response.json()`; this test's whole point is
        // proving the text path never attempts that parse at all.
        new Response("diff --git a/x b/x\n+added line\n", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await githubRequest<string>("tok", "GET", "/ok", undefined, {
      responseType: "text",
    });

    expect(result).toBe("diff --git a/x b/x\n+added line\n");
  });

  it("LAYER 2 fallback: caps a text response at MAX_TEXT_RESPONSE_LENGTH after buffering, when Content-Length was absent (security-reviewer finding, F1-S9 slice 3b-i, issue #12, PR #72 review, LOW -- this is the weaker post-buffer check; the Response constructor in this test does NOT set a Content-Length header for a plain string body, verified empirically, so this exercises the fallback path specifically, not the pre-check)", async () => {
    const oversized = "x".repeat(MAX_TEXT_RESPONSE_LENGTH + 1000);
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) => new Response(oversized, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await githubRequest<string>("tok", "GET", "/ok", undefined, { responseType: "text" });

    expect(result.length).toBe(MAX_TEXT_RESPONSE_LENGTH);
  });

  it("LAYER 1: rejects BEFORE buffering when the response's Content-Length header already exceeds the cap (Codex finding, PR #72 review round 4 -- the fix that makes the memory bound actually real, not just a post-hoc truncation of an already-fully-buffered body)", async () => {
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) =>
        new Response("short body -- the declared Content-Length is what matters here, not the actual body", {
          status: 200,
          headers: { "content-length": String(MAX_TEXT_RESPONSE_LENGTH + 1) },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(githubRequest<string>("tok", "GET", "/ok", undefined, { responseType: "text" })).rejects.toThrow(
      /Content-Length/,
    );
  });

  it("LAYER 1: does NOT reject when Content-Length is exactly at the cap", async () => {
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) =>
        new Response("body", { status: 200, headers: { "content-length": String(MAX_TEXT_RESPONSE_LENGTH) } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      githubRequest<string>("tok", "GET", "/ok", undefined, { responseType: "text" }),
    ).resolves.toBe("body");
  });

  it("LAYER 1: a non-numeric Content-Length header does not crash -- falls through to the layer-2 buffer-then-check path instead", async () => {
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) =>
        new Response("body", { status: 200, headers: { "content-length": "not-a-number" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      githubRequest<string>("tok", "GET", "/ok", undefined, { responseType: "text" }),
    ).resolves.toBe("body");
  });

  it("does not truncate a text response at or under MAX_TEXT_RESPONSE_LENGTH", async () => {
    const body = "diff --git a/x b/x\n";
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) => new Response(body, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await githubRequest<string>("tok", "GET", "/ok", undefined, { responseType: "text" });

    expect(result).toBe(body);
  });

  it("honors a smaller `maxTextResponseLength` override (test-only convenience, exercised here instead of generating a multi-megabyte fixture)", async () => {
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) => new Response("0123456789", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await githubRequest<string>("tok", "GET", "/ok", undefined, {
      responseType: "text",
      maxTextResponseLength: 5,
    });

    expect(result).toBe("01234");
  });

  it("never applies the text-response cap to a JSON response", async () => {
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) => new Response(JSON.stringify({ hello: "world" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await githubRequest<{ hello: string }>("tok", "GET", "/ok");

    expect(result).toEqual({ hello: "world" });
  });
});

describe("parseRetryAfterMs", () => {
  it("parses a plain integer-seconds value into milliseconds", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("does NOT clamp a value above MAX_RETRY_AFTER_SECONDS — returns the exact server-requested wait (Codex P2, #53: clamping here caused premature retries against a still-rate-limited server)", () => {
    const seconds = MAX_RETRY_AFTER_SECONDS + 1000;
    expect(parseRetryAfterMs(String(seconds))).toBe(seconds * 1000);
  });

  it("returns null for a missing, empty, non-integer, or negative value", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("")).toBeNull();
    expect(parseRetryAfterMs("not-a-number")).toBeNull();
    expect(parseRetryAfterMs("-5")).toBeNull();
    expect(parseRetryAfterMs("1.5")).toBeNull();
    // The HTTP-date form is valid per RFC 9110 but GitHub never sends it —
    // Number() on a date string is NaN, so this correctly falls through to
    // null (the caller's own backoff), not a nonsensical wait.
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });
});

describe("parseRateLimitResetWaitMs", () => {
  it("returns the exact wait until the UTC epoch reset time", () => {
    expect(parseRateLimitResetWaitMs("200", 150_250)).toBe(49_750);
  });

  it("returns zero when the reset is now or already past", () => {
    expect(parseRateLimitResetWaitMs("200", 200_000)).toBe(0);
    expect(parseRateLimitResetWaitMs("200", 200_001)).toBe(0);
  });

  it("rejects missing, non-integer, unsafe, or invalid-clock values", () => {
    expect(parseRateLimitResetWaitMs(null, 0)).toBeNull();
    expect(parseRateLimitResetWaitMs("not-a-number", 0)).toBeNull();
    expect(parseRateLimitResetWaitMs("-1", 0)).toBeNull();
    expect(parseRateLimitResetWaitMs("1.5", 0)).toBeNull();
    expect(
      parseRateLimitResetWaitMs(String(Number.MAX_SAFE_INTEGER), 0),
    ).toBeNull();
    expect(parseRateLimitResetWaitMs("200", Number.NaN)).toBeNull();
    expect(parseRateLimitResetWaitMs("200", -1)).toBeNull();
    expect(parseRateLimitResetWaitMs("200", 1.5)).toBeNull();
  });
});

describe("decideRateLimitResponse (F1-S10, factory.md D114)", () => {
  const nowMs = 1_000_000;

  it("prefers a valid Retry-After over a conflicting primary reset", () => {
    expect(
      decideRateLimitResponse(429, "7", "0", "1001", nowMs),
    ).toEqual({
      kind: "retry",
      waitMs: 7000,
      source: "retry-after",
    });
  });

  it("falls through an invalid Retry-After to a valid primary reset", () => {
    expect(
      decideRateLimitResponse(403, "garbage", "0", "1050", nowMs),
    ).toEqual({
      kind: "retry",
      waitMs: 50_000,
      source: "rate-limit-reset",
    });
  });

  it.each([403, 429])(
    "recognizes a primary-limit %s and waits exactly until reset",
    (status) => {
      expect(
        decideRateLimitResponse(status, null, "0", "1050", nowMs),
      ).toEqual({
        kind: "retry",
        waitMs: 50_000,
        source: "rate-limit-reset",
      });
    },
  );

  it("retries immediately when the primary reset is at or before now", () => {
    expect(
      decideRateLimitResponse(403, null, "0", "1000", nowMs),
    ).toEqual({
      kind: "retry",
      waitMs: 0,
      source: "rate-limit-reset",
    });
    expect(
      decideRateLimitResponse(403, null, "0", "999", nowMs),
    ).toEqual({
      kind: "retry",
      waitMs: 0,
      source: "rate-limit-reset",
    });
  });

  it("allows a server-directed wait exactly at the 60-second ceiling", () => {
    expect(
      decideRateLimitResponse(403, null, "0", "1060", nowMs),
    ).toEqual({
      kind: "retry",
      waitMs: 60_000,
      source: "rate-limit-reset",
    });
    expect(
      decideRateLimitResponse(429, "60", null, null, nowMs),
    ).toEqual({
      kind: "retry",
      waitMs: 60_000,
      source: "retry-after",
    });
  });

  it.each([
    ["retry-after", "61", null, null],
    ["rate-limit-reset", null, "0", "1061"],
  ] as const)(
    "gives up without clamping when %s requests a wait above the cap",
    (source, retryAfter, remaining, reset) => {
      expect(
        decideRateLimitResponse(429, retryAfter, remaining, reset, nowMs),
      ).toEqual({
        kind: "give-up",
        waitMs: 61_000,
        source,
      });
    },
  );

  it("uses the documented 60-second fallback for a 429 with no usable timing signal", () => {
    expect(
      decideRateLimitResponse(429, null, null, null, nowMs),
    ).toEqual({
      kind: "retry",
      waitMs: MIN_RATE_LIMIT_FALLBACK_SECONDS * 1000,
      source: "fallback",
    });
    expect(
      decideRateLimitResponse(429, "garbage", "0", "garbage", nowMs),
    ).toEqual({
      kind: "retry",
      waitMs: MIN_RATE_LIMIT_FALLBACK_SECONDS * 1000,
      source: "fallback",
    });
  });

  it("gives up when a continued headerless 429 requires exponential fallback above the cap", () => {
    expect(
      decideRateLimitResponse(429, null, null, null, nowMs, 1),
    ).toEqual({
      kind: "give-up",
      waitMs: 120_000,
      source: "fallback",
    });
  });

  it("does not turn an ordinary or malformed-primary 403 into a retry", () => {
    expect(
      decideRateLimitResponse(403, null, null, null, nowMs),
    ).toEqual({ kind: "not-rate-limited" });
    expect(
      decideRateLimitResponse(403, null, "0", "garbage", nowMs),
    ).toEqual({ kind: "not-rate-limited" });
    expect(
      decideRateLimitResponse(403, "garbage", "1", "1050", nowMs),
    ).toEqual({ kind: "not-rate-limited" });
  });

  it("does not classify other statuses even when rate-limit headers are present", () => {
    expect(
      decideRateLimitResponse(500, "5", "0", "1050", nowMs),
    ).toEqual({ kind: "not-rate-limited" });
    expect(
      decideRateLimitResponse(200, "5", "0", "1050", nowMs),
    ).toEqual({ kind: "not-rate-limited" });
  });
});

describe("githubRequest — bounded rate-limit handling (F1-S10, factory.md D114)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries a 429 with a Retry-After header, waiting the header's exact value, then succeeds", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "3" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await githubRequest("tok", "POST", "/pulls", undefined, {
      sleepFn,
    });

    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(sleepFn).toHaveBeenCalledExactlyOnceWith(3000);
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "GitHub API POST /pulls rate-limited (status 429); " +
        "retrying in 3000ms from retry-after (attempt 1/5)",
    );
    warnSpy.mockRestore();
  });

  it("retries a 403 WITH Retry-After (secondary rate limit's documented alternate status)", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("secondary rate limited", {
          status: 403,
          headers: { "retry-after": "2" },
        });
      }
      return new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await githubRequest("tok", "POST", "/issues/1/comments", undefined, {
      sleepFn,
    });

    expect(result).toEqual({ id: 1 });
    expect(attempts).toBe(2);
  });

  it("retries a primary-limit 403 at its exact reset time, using the injected clock", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("primary rate limited", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1050",
          },
        });
      }
      return new Response(JSON.stringify({ id: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await githubRequest(
      "tok",
      "POST",
      "/issues/1/comments",
      undefined,
      {
        sleepFn,
        nowFn: () => 1_000_000,
      },
    );

    expect(result).toEqual({ id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledExactlyOnceWith(50_000);
  });

  it("uses the production Date.now default for a primary-reset wait", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("primary rate limited", {
          status: 429,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1050",
          },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      githubRequest("tok", "POST", "/pulls", undefined, { sleepFn }),
    ).resolves.toEqual({ ok: true });

    expect(nowSpy).toHaveBeenCalled();
    expect(sleepFn).toHaveBeenCalledExactlyOnceWith(50_000);
    nowSpy.mockRestore();
  });

  it("waits the documented minimum 60 seconds for a headerless 429", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("secondary rate limited", { status: 429 });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      githubRequest("tok", "POST", "/pulls", undefined, { sleepFn }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledExactlyOnceWith(
      MIN_RATE_LIMIT_FALLBACK_SECONDS * 1000,
    );
  });

  it("gives up on a continued headerless 429 instead of retrying before the doubled wait", async () => {
    const fetchMock = vi.fn(
      async () => new Response("secondary rate limited", { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      githubRequest("tok", "POST", "/pulls", undefined, { sleepFn }),
    ).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledExactlyOnceWith(
      MIN_RATE_LIMIT_FALLBACK_SECONDS * 1000,
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenNthCalledWith(
      2,
      "GitHub API POST /pulls rate-limited (status 429); " +
        "fallback requires 120000ms, exceeding the 60s cap — " +
        "giving up rather than retrying early.",
    );
    warnSpy.mockRestore();
  });

  it("does NOT retry an ordinary 403 with no Retry-After header (unauthorized/expired token must fail immediately)", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);

    await expect(
      githubRequest("tok", "GET", "/error", undefined, { sleepFn }),
    ).rejects.toThrow(/403/);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("does NOT retry a primary reset beyond the cap (never retries before GitHub's reset time)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("primary rate limited", {
          status: 429,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1061",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      githubRequest("tok", "POST", "/pulls", undefined, {
        sleepFn,
        nowFn: () => 1_000_000,
      }),
    ).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      "GitHub API POST /pulls rate-limited (status 429); " +
        "rate-limit-reset requires 61000ms, exceeding the 60s cap — " +
        "giving up rather than retrying early.",
    );
    warnSpy.mockRestore();
  });

  it("gives up immediately — no sleep, no retry — when Retry-After exceeds MAX_RETRY_AFTER_SECONDS (Codex P2, #53: must not retry EARLY against a longer server-requested wait)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "120" }, // Exceeds the 60s cap.
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      githubRequest("tok", "POST", "/pulls", undefined, { sleepFn }),
    ).rejects.toThrow(/429/);

    // Decisive: exactly ONE fetch attempt, and NEVER slept — retrying
    // after waiting only the capped 60s would fire before the server's
    // actual 120s request elapsed, which is exactly the bug this guards.
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("giving up"));
    warnSpy.mockRestore();
  });

  it("gives up after exhausting the retry budget and throws with the final status", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("still limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      githubRequest("tok", "POST", "/pulls", undefined, {
        sleepFn,
        maxRateLimitRetries: 2,
      }),
    ).rejects.toThrow(/429/);

    // The initial attempt plus exactly 2 retries — never a 3rd retry once
    // the budget (maxRateLimitRetries: 2) is exhausted.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it("defaults to MAX_RATE_LIMIT_RETRIES when no override is given", async () => {
    const fetchMock = vi.fn(
      async () => new Response("limited", { status: 429, headers: { "retry-after": "0" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      githubRequest("tok", "POST", "/pulls", undefined, { sleepFn }),
    ).rejects.toThrow(/429/);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_RATE_LIMIT_RETRIES + 1);
  });

  it("never retries a genuinely successful request (no unnecessary sleep/extra fetch on the happy path)", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sleepFn = vi.fn(async () => undefined);

    await githubRequest("tok", "GET", "/ok", undefined, { sleepFn });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("uses the REAL default sleep (no sleepFn override) when retrying — proves production callers (which never pass one) actually wait, not just the test-only override path", async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        // A zero-second wait keeps this real-timer path fast in CI while
        // still exercising the actual `setTimeout`-based sleep() every
        // production call site relies on (none of them pass `sleepFn` —
        // that override exists purely for this test file).
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await githubRequest("tok", "POST", "/pulls");

    expect(result).toEqual({ ok: true });
    expect(attempts).toBe(2);
    warnSpy.mockRestore();
  });
});
