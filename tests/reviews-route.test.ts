import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  verifyWriteRequest: vi.fn(),
  checkRateLimit: vi.fn(),
  submitReview: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("../lib/botid", () => ({
  verifyWriteRequest: routeMocks.verifyWriteRequest,
}));

vi.mock("next/cache", () => ({
  revalidatePath: routeMocks.revalidatePath,
}));

vi.mock("../lib/ratelimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ratelimit")>();
  return { ...actual, checkRateLimit: routeMocks.checkRateLimit };
});

vi.mock("../lib/review-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/review-submit")>();
  return { ...actual, submitReview: routeMocks.submitReview };
});

import { POST } from "../app/api/r/[slug]/reviews/route";
import { ReviewSubmitError } from "../lib/review-submit";

const VALID_SLUG = "23456789ABCDEFGHJK";
const CLIENT_IP = "203.0.113.12";
const SECRET_VALUES = [
  CLIENT_IP,
  "super-secret-pepper",
  "super-secret-kv-token",
  "Snowflake SQL compilation error",
];

function postRequest(body: string, headers: HeadersInit = {}) {
  return new Request("https://example.test/api/reviews", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": CLIENT_IP,
      ...headers,
    },
    body,
  });
}

function postJson(body: unknown, headers?: HeadersInit) {
  return postRequest(JSON.stringify(body), headers);
}

function callPost(request: Request, slug = VALID_SLUG) {
  return POST(request, { params: Promise.resolve({ slug }) });
}

function expectAnonymous(response: Response) {
  expect(response.headers.has("set-cookie")).toBe(false);
}

async function expectSanitized(response: Response, spies: ReturnType<typeof vi.spyOn>[]) {
  const body = await response.text();
  const logged = spies.flatMap((spy) => spy.mock.calls.flat()).join(" ");
  for (const secret of SECRET_VALUES) {
    expect(body).not.toContain(secret);
    expect(logged).not.toContain(secret);
  }
}

describe("POST /api/r/[slug]/reviews", () => {
  beforeEach(() => {
    routeMocks.verifyWriteRequest.mockResolvedValue({ allowed: true });
    routeMocks.checkRateLimit.mockResolvedValue({ allowed: true });
    routeMocks.submitReview.mockResolvedValue({ reviewId: "review-id" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("returns field errors for an invalid body without echoing raw payload", async () => {
    const rawSecret = "raw-payload-must-not-be-echoed";
    const response = await callPost(postJson({ score: 6, notes: rawSecret }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid request");
    expect(body.fieldErrors.score).toBeDefined();
    expect(JSON.stringify(body)).not.toContain(rawSecret);
    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.verifyWriteRequest).toHaveBeenCalledOnce();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await callPost(postRequest("{"));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request" });
    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.verifyWriteRequest).not.toHaveBeenCalled();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("rejects text/plain before reading or processing a valid JSON body", async () => {
    const request = new Request("https://example.test/api/reviews", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ score: 5 }),
    });
    const response = await callPost(request);

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Unsupported Media Type" });
    expect(request.bodyUsed).toBe(false);
    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.verifyWriteRequest).not.toHaveBeenCalled();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expect(routeMocks.revalidatePath).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("rejects a missing Content-Type before reading or processing the body", async () => {
    const request = new Request("https://example.test/api/reviews", {
      method: "POST",
      body: JSON.stringify({ score: 5 }),
    });
    const response = await callPost(request);

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ error: "Unsupported Media Type" });
    expect(request.bodyUsed).toBe(false);
    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.verifyWriteRequest).not.toHaveBeenCalled();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expect(routeMocks.revalidatePath).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("returns 400 for a non-object JSON body without side effects", async () => {
    const response = await callPost(postJson(42));

    expect(response.status).toBe(400);
    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.verifyWriteRequest).toHaveBeenCalledOnce();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expect(routeMocks.revalidatePath).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("makes honeypot rejection byte-identical to success without side effects", async () => {
    const honeypot = await callPost(
      postJson({ score: 5, website: "https://spam.test" }),
    );
    const honeypotBody = await honeypot.text();
    const honeypotHeaders = [...honeypot.headers.entries()];

    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.verifyWriteRequest).not.toHaveBeenCalled();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expect(routeMocks.revalidatePath).not.toHaveBeenCalled();

    const success = await callPost(postJson({ score: 5 }));
    expect(honeypot.status).toBe(200);
    expect(honeypot.status).toBe(success.status);
    expect(honeypotBody).toBe(await success.text());
    expect(honeypotHeaders).toEqual([...success.headers.entries()]);
    expectAnonymous(honeypot);
    expectAnonymous(success);
  });

  it("returns 429 with Retry-After when rate limited", async () => {
    routeMocks.checkRateLimit.mockResolvedValue({
      allowed: false,
      reason: "rate_limited",
      retryAfterSeconds: 47,
    });
    const response = await callPost(postJson({ score: 4 }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("47");
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("uses a zero Retry-After fallback when the limiter omits a delay", async () => {
    routeMocks.checkRateLimit.mockResolvedValue({
      allowed: false,
      reason: "rate_limited",
    });
    const response = await callPost(postJson({ score: 4 }));

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("0");
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("returns 429 without Retry-After on a fail-closed decision", async () => {
    routeMocks.checkRateLimit.mockResolvedValue({
      allowed: false,
      reason: "fail_closed",
    });
    const response = await callPost(postJson({ score: 4 }));

    expect(response.status).toBe(429);
    expect(response.headers.has("retry-after")).toBe(false);
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("passes the parsed submission and the same extracted IP downstream", async () => {
    const submission = { score: 5, aroma: 71, reviewerName: "Ada" };
    const response = await callPost(postJson(submission));

    expect(response.status).toBe(200);
    expect(routeMocks.checkRateLimit).toHaveBeenCalledWith(CLIENT_IP);
    expect(routeMocks.submitReview).toHaveBeenCalledWith(
      VALID_SLUG,
      submission,
      CLIENT_IP,
    );
    expect(routeMocks.submitReview.mock.calls[0]?.[1]).not.toBe(submission);
  });

  it("rejects an invalid slug before parsing, limiting, or submission", async () => {
    const request = postRequest("not-json");
    const response = await callPost(request, "short");

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
    expect(request.bodyUsed).toBe(false);
    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.verifyWriteRequest).not.toHaveBeenCalled();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("denies a bot before validation, rate limiting, SQL, and revalidation", async () => {
    routeMocks.verifyWriteRequest.mockResolvedValue({ allowed: false, reason: "bot" });
    const response = await callPost(postJson({ score: 0 }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(response.headers.has("retry-after")).toBe(false);
    expectAnonymous(response);
    expect(routeMocks.verifyWriteRequest).toHaveBeenCalledOnce();
    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expect(routeMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("denies a fail-closed detector decision before downstream work without leaking secrets", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    routeMocks.verifyWriteRequest.mockResolvedValue({ allowed: false, reason: "fail_closed" });
    const response = await callPost(postJson({ score: 5, notes: SECRET_VALUES.join(" ") }));

    expect(response.status).toBe(403);
    expectAnonymous(response);
    expect(response.headers.has("retry-after")).toBe(false);
    await expectSanitized(response, [errorSpy, logSpy]);
    expect(routeMocks.checkRateLimit).not.toHaveBeenCalled();
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expect(routeMocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("calls BotID before the limiter and submission on an admitted write", async () => {
    const response = await callPost(postJson({ score: 5 }));

    expect(response.status).toBe(200);
    expect(routeMocks.verifyWriteRequest).toHaveBeenCalledOnce();
    expect(routeMocks.verifyWriteRequest.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.checkRateLimit.mock.invocationCallOrder[0],
    );
    expect(routeMocks.checkRateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      routeMocks.submitReview.mock.invocationCallOrder[0],
    );
    expectAnonymous(response);
  });

  it("returns minimal success and revalidates the specific roast path", async () => {
    const response = await callPost(postJson({ score: 3 }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(routeMocks.revalidatePath).toHaveBeenCalledOnce();
    expect(routeMocks.revalidatePath).toHaveBeenCalledWith(`/r/${VALID_SLUG}`);
    expectAnonymous(response);
  });

  it("maps a transient submission error to 503", async () => {
    routeMocks.submitReview.mockRejectedValue(new ReviewSubmitError("transient"));
    const response = await callPost(postJson({ score: 5 }));

    expect(response.status).toBe(503);
    expect(routeMocks.revalidatePath).not.toHaveBeenCalled();
    expectAnonymous(response);
  });

  it("maps unknown submission failures to a sanitized 503", async () => {
    routeMocks.submitReview.mockRejectedValue(
      new Error("Snowflake SQL compilation error super-secret-kv-token"),
    );
    const response = await callPost(postJson({ score: 5 }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Review submission is temporarily unavailable.",
    });
    expectAnonymous(response);
  });

  it("does not expose secrets in bodies or logs across 400, 429, and 503 paths", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const invalid = await callPost(postJson({ score: 0, notes: SECRET_VALUES.join(" ") }));
    await expectSanitized(invalid, [errorSpy, logSpy]);

    routeMocks.checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      reason: "fail_closed",
    });
    const limited = await callPost(postJson({ score: 5 }));
    await expectSanitized(limited, [errorSpy, logSpy]);

    routeMocks.checkRateLimit.mockResolvedValueOnce({ allowed: true });
    routeMocks.submitReview.mockRejectedValueOnce(
      new Error(SECRET_VALUES.join(" ")),
    );
    const unavailable = await callPost(postJson({ score: 5 }));
    await expectSanitized(unavailable, [errorSpy, logSpy]);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});
