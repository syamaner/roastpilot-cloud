import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeBackoffMs,
  githubRequest,
  isRateLimitedResponse,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RETRY_AFTER_SECONDS,
  parseRetryAfterMs,
  requireEnv,
  shouldGiveUpOnRateLimit,
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
});

describe("isRateLimitedResponse (F1-S10, factory.md §13 point 8)", () => {
  it("treats a bare 429 as rate limited regardless of headers", () => {
    expect(isRateLimitedResponse(429, null)).toBe(true);
    expect(isRateLimitedResponse(429, "5")).toBe(true);
  });

  it("treats a 403 WITH a Retry-After header as rate limited (GitHub's documented secondary-limit shape)", () => {
    expect(isRateLimitedResponse(403, "10")).toBe(true);
  });

  it("does NOT treat a 403 WITHOUT a Retry-After header as rate limited (an ordinary permissions/auth 403 must fail immediately, not be retried into a slow timeout)", () => {
    expect(isRateLimitedResponse(403, null)).toBe(false);
  });

  it("does not treat other statuses as rate limited even with a Retry-After header", () => {
    expect(isRateLimitedResponse(500, "5")).toBe(false);
    expect(isRateLimitedResponse(200, "5")).toBe(false);
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

  it("returns null for a missing, non-numeric, or negative value", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("not-a-number")).toBeNull();
    expect(parseRetryAfterMs("-5")).toBeNull();
    // The HTTP-date form is valid per RFC 9110 but GitHub never sends it —
    // Number() on a date string is NaN, so this correctly falls through to
    // null (the caller's own backoff), not a nonsensical wait.
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });
});

describe("computeBackoffMs", () => {
  it("prefers a parseable Retry-After header over exponential backoff", () => {
    expect(computeBackoffMs("7", 0)).toBe(7000);
    expect(computeBackoffMs("7", 3)).toBe(7000); // Header wins regardless of attempt number.
  });

  it("falls back to capped exponential backoff when the header is absent or unparseable", () => {
    expect(computeBackoffMs(null, 0)).toBe(500);
    expect(computeBackoffMs(null, 1)).toBe(1000);
    expect(computeBackoffMs(null, 2)).toBe(2000);
    expect(computeBackoffMs("garbage", 0)).toBe(500);
  });

  it("caps exponential backoff at MAX_RETRY_AFTER_SECONDS even for a large attempt number", () => {
    expect(computeBackoffMs(null, 20)).toBe(MAX_RETRY_AFTER_SECONDS * 1000);
  });
});

describe("shouldGiveUpOnRateLimit (Codex P2, #53)", () => {
  it("is false for a wait within MAX_RETRY_AFTER_SECONDS", () => {
    expect(shouldGiveUpOnRateLimit(String(MAX_RETRY_AFTER_SECONDS))).toBe(false);
    expect(shouldGiveUpOnRateLimit("5")).toBe(false);
    expect(shouldGiveUpOnRateLimit("0")).toBe(false);
  });

  it("is true for a wait exceeding MAX_RETRY_AFTER_SECONDS — the caller must give up, not clamp-and-retry-early", () => {
    expect(shouldGiveUpOnRateLimit(String(MAX_RETRY_AFTER_SECONDS + 1))).toBe(true);
    expect(shouldGiveUpOnRateLimit("120")).toBe(true);
  });

  it("is false for a missing or unparseable header (that case falls to computeBackoffMs's own exponential fallback instead, never a reason to give up)", () => {
    expect(shouldGiveUpOnRateLimit(null)).toBe(false);
    expect(shouldGiveUpOnRateLimit("garbage")).toBe(false);
    expect(shouldGiveUpOnRateLimit("-5")).toBe(false);
  });
});

describe("githubRequest — 429/Retry-After backoff (F1-S10, factory.md §13 point 8)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
