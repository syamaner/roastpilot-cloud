import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const upstash = vi.hoisted(() => ({
  fromEnv: vi.fn(),
  limit: vi.fn(),
  construct: vi.fn(),
  slidingWindow: vi.fn(() => ({ kind: "sliding-window" })),
  executeStatement: vi.fn(),
}));

vi.mock("@upstash/redis", () => ({
  Redis: { fromEnv: upstash.fromEnv },
}));

vi.mock("@upstash/ratelimit", () => {
  class MockRatelimit {
    static slidingWindow = upstash.slidingWindow;

    constructor(options: unknown) {
      upstash.construct(options);
    }

    limit(identifier: string) {
      return upstash.limit(identifier);
    }
  }

  return { Ratelimit: MockRatelimit };
});

vi.mock("../lib/sqlapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sqlapi")>();
  return { ...actual, executeStatement: upstash.executeStatement };
});

import { checkHoneypot, checkRateLimit } from "../lib/ratelimit";
import { submitReview } from "../lib/review-submit";

const TEST_URL = "https://example.upstash.test";
const TEST_TOKEN = "secret-upstash-token";
const TEST_PEPPER = "test-review-pepper";
const TEST_IP = "203.0.113.9";
const STORED_IP_HASH =
  "5fdd55bd1730a0ccd0f1bc23a24aedddab3ebf6385e86d791ff769aa6fb73fca";

function limitResult(
  success: boolean,
  reset = Date.now() + 60_000,
  pending: Promise<unknown> | undefined = Promise.resolve(),
) {
  return { success, limit: 5, remaining: success ? 4 : 0, reset, pending };
}

describe("checkHoneypot", () => {
  it("T1 allows an empty honeypot", () => {
    expect(checkHoneypot("")).toEqual({ allowed: true });
  });

  it("T2 allows an absent honeypot", () => {
    expect(checkHoneypot(undefined)).toEqual({ allowed: true });
  });

  it("T3 rejects a populated honeypot without calling Upstash", () => {
    expect(checkHoneypot("http://spam")).toEqual({
      allowed: false,
      reason: "honeypot",
    });
    expect(upstash.fromEnv).not.toHaveBeenCalled();
    expect(upstash.limit).not.toHaveBeenCalled();
  });

  it("T4 rejects whitespace without trimming", () => {
    expect(checkHoneypot("  ")).toEqual({
      allowed: false,
      reason: "honeypot",
    });
  });
});

describe("checkRateLimit", () => {
  beforeEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = TEST_URL;
    process.env.UPSTASH_REDIS_REST_TOKEN = TEST_TOKEN;
    process.env.REVIEW_IP_HASH_PEPPER = TEST_PEPPER;
    upstash.fromEnv.mockReturnValue({ redis: true });
    upstash.limit.mockResolvedValue(limitResult(true));
    upstash.executeStatement.mockResolvedValue({
      columns: [{ name: "SUBMIT_REVIEW", type: "TEXT" }],
      rows: [["review-id"]],
      rowCount: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    delete process.env.REVIEW_IP_HASH_PEPPER;
  });

  it("T5 allows a successful limit result and contains pending rejection", async () => {
    const genuineAllow = limitResult(
      true,
      Date.now() + 60_000,
      Promise.reject(new Error("late")),
    );
    expect(genuineAllow).not.toHaveProperty("reason");
    upstash.limit.mockResolvedValue(genuineAllow);

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({ allowed: true });
    expect(upstash.fromEnv).toHaveBeenCalledWith();
    expect(upstash.slidingWindow).toHaveBeenCalledWith(5, "10 m");
    expect(upstash.construct).toHaveBeenCalledWith({
      redis: { redis: true },
      limiter: { kind: "sliding-window" },
      prefix: "rl:review",
    });
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
    ["malformed", "not-an-ip"],
  ])("fails closed on a %s client IP", async (_case, clientIp) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(checkRateLimit(clientIp)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "ratelimit_fail_closed",
      reason: "invalid_client_ip",
    });
    expect(upstash.fromEnv).not.toHaveBeenCalled();
    expect(upstash.limit).not.toHaveBeenCalled();
  });

  it("allows a valid IPv6 address to reach the limiter", async () => {
    const clientIp = "2001:db8::1";
    const expected = createHmac("sha256", TEST_PEPPER)
      .update("ratelimit:v1:" + clientIp)
      .digest("hex");

    await expect(checkRateLimit(clientIp)).resolves.toEqual({ allowed: true });
    expect(upstash.limit).toHaveBeenCalledWith(expected);
  });

  it("T6 returns an approximately 45-second retry delay", async () => {
    upstash.limit.mockResolvedValue(limitResult(false, Date.now() + 45_000));

    const decision = await checkRateLimit(TEST_IP);

    expect(decision).toEqual({
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: expect.any(Number),
    });
    if (!decision.allowed) {
      expect([44, 45]).toContain(decision.retryAfterSeconds);
    }
  });

  it("fails closed when Upstash resolves with its timeout fallback", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    upstash.limit.mockResolvedValue({
      success: true,
      reason: "timeout",
      limit: 0,
      remaining: 0,
      reset: 0,
      pending: Promise.resolve(),
    });

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "ratelimit_fail_closed",
      reason: "upstash_timeout",
    });
  });

  it("fails closed on an unexpected success-shaped fallback", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    upstash.limit.mockResolvedValue({
      success: true,
      reason: "cacheBlock",
      limit: 5,
      remaining: 0,
      reset: Date.now() + 60_000,
      pending: Promise.resolve(),
    });

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "ratelimit_fail_closed",
      reason: "upstash_unexpected_success",
    });
  });

  it("T7 clamps a past reset time to zero", async () => {
    upstash.limit.mockResolvedValue(limitResult(false, Date.now() - 1_000));

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: 0,
    });
  });

  it("T8 fails closed before client construction when the URL is absent", async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
    expect(upstash.fromEnv).not.toHaveBeenCalled();
  });

  it("T9 fails closed when the token is absent", async () => {
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
    expect(upstash.fromEnv).not.toHaveBeenCalled();
  });

  it("T10 fails closed when the token is blank", async () => {
    process.env.UPSTASH_REDIS_REST_TOKEN = "   ";

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
    expect(upstash.fromEnv).not.toHaveBeenCalled();
  });

  it("T11 fails closed when the pepper is absent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.REVIEW_IP_HASH_PEPPER;

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
    expect(upstash.fromEnv).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "ratelimit_fail_closed",
      reason: "missing_ip_hash_pepper",
    });
  });

  it("T12 fails closed when client or limiter construction throws", async () => {
    upstash.fromEnv.mockImplementationOnce(() => {
      throw new Error("client construction failed");
    });
    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });

    upstash.construct.mockImplementationOnce(() => {
      throw new Error("limiter construction failed");
    });
    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
  });

  it("T13 fails closed when limit rejects", async () => {
    upstash.limit.mockRejectedValue(new Error("network failure"));

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({
      allowed: false,
      reason: "fail_closed",
    });
  });

  it("T14 emits one sanitized structured alarm for each fail-closed path", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rawIp = "198.51.100.27";
    const identifier = createHmac("sha256", TEST_PEPPER)
      .update("ratelimit:v1:" + rawIp.trim().toLowerCase())
      .digest("hex");

    delete process.env.UPSTASH_REDIS_REST_URL;
    await checkRateLimit(rawIp);
    process.env.UPSTASH_REDIS_REST_URL = TEST_URL;
    delete process.env.REVIEW_IP_HASH_PEPPER;
    await checkRateLimit(rawIp);
    process.env.REVIEW_IP_HASH_PEPPER = TEST_PEPPER;
    upstash.limit.mockRejectedValueOnce(new Error("remote body with secrets"));
    await checkRateLimit(rawIp);

    expect(error).toHaveBeenCalledTimes(3);
    for (const [payload] of error.mock.calls) {
      expect(JSON.parse(String(payload))).toMatchObject({
        event: "ratelimit_fail_closed",
      });
      expect(String(payload)).not.toContain(rawIp);
      expect(String(payload)).not.toContain(identifier);
      expect(String(payload)).not.toContain(TEST_PEPPER);
      expect(String(payload)).not.toContain(TEST_TOKEN);
    }
  });

  it("T15 sends only the expected 64-character domain-separated HMAC", async () => {
    await checkRateLimit(TEST_IP);

    const expected = createHmac("sha256", TEST_PEPPER)
      .update("ratelimit:v1:" + TEST_IP.trim().toLowerCase())
      .digest("hex");
    expect(upstash.limit).toHaveBeenCalledWith(expected);
    expect(expected).not.toBe(TEST_IP);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("T16 normalizes trailing whitespace before hashing", async () => {
    await checkRateLimit(`${TEST_IP} `);
    const spacedIdentifier = upstash.limit.mock.calls[0]?.[0];
    upstash.limit.mockClear();

    await checkRateLimit(TEST_IP);

    expect(upstash.limit).toHaveBeenCalledWith(spacedIdentifier);
  });

  it("T17 domain-separates the rate-limit key from the stored-IP hash", async () => {
    await checkRateLimit(TEST_IP);

    const bareHash = createHmac("sha256", TEST_PEPPER)
      .update(TEST_IP.trim().toLowerCase())
      .digest("hex");
    expect(upstash.limit).not.toHaveBeenCalledWith(bareHash);
  });

  it("T18 matches the real review submission's bare normalized IP hash", async () => {
    await checkRateLimit(TEST_IP);
    const rateLimitIdentifier = upstash.limit.mock.calls[0]?.[0];
    const bareHash = createHmac("sha256", TEST_PEPPER)
      .update(TEST_IP.trim().toLowerCase())
      .digest("hex");

    await submitReview("roast-slug", { score: 5 }, TEST_IP);
    const bindings = upstash.executeStatement.mock.calls[0]?.[1] as Record<
      string,
      { type: string; value: string | null }
    >;

    const labeledHash = createHmac("sha256", TEST_PEPPER)
      .update("ratelimit:v1:" + TEST_IP.trim().toLowerCase())
      .digest("hex");

    expect(rateLimitIdentifier).toBe(labeledHash);
    expect(bareHash).toBe(STORED_IP_HASH);
    expect(bindings["11"].value).toBe(bareHash);
    expect(rateLimitIdentifier).not.toBe(bareHash);
  });

  it("fails closed when runtime input violates the clientIp type", async () => {
    await expect(
      checkRateLimit(null as unknown as string),
    ).resolves.toEqual({ allowed: false, reason: "fail_closed" });
    expect(upstash.fromEnv).not.toHaveBeenCalled();
  });

  it("guards an absent pending promise", async () => {
    upstash.limit.mockResolvedValue(limitResult(true, Date.now(), undefined));

    await expect(checkRateLimit(TEST_IP)).resolves.toEqual({ allowed: true });
  });

  it("fails closed when the URL or pepper is blank", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.UPSTASH_REDIS_REST_URL = " ";
    await expect(checkRateLimit(TEST_IP)).resolves.toMatchObject({
      allowed: false,
      reason: "fail_closed",
    });

    error.mockClear();
    process.env.UPSTASH_REDIS_REST_URL = TEST_URL;
    process.env.REVIEW_IP_HASH_PEPPER = " ";
    await expect(checkRateLimit(TEST_IP)).resolves.toMatchObject({
      allowed: false,
      reason: "fail_closed",
    });
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "ratelimit_fail_closed",
      reason: "missing_ip_hash_pepper",
    });
  });
});
