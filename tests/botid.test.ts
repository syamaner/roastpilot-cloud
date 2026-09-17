import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkBotId: vi.fn(),
  checkRateLimit: vi.fn(),
  submitReview: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("botid/server", () => ({ checkBotId: mocks.checkBotId }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("../lib/ratelimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ratelimit")>()),
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("../lib/review-submit", () => ({ submitReview: mocks.submitReview }));

import { verifyWriteRequest } from "../lib/botid";
import { POST } from "../app/api/r/[slug]/reviews/route";

const SLUG = "23456789ABCDEFGHJK";
const IP = "203.0.113.12";

function submit() {
  return POST(
    new Request(`https://example.test/api/r/${SLUG}/reviews`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": IP },
      body: JSON.stringify({ score: 5 }),
    }),
    { params: Promise.resolve({ slug: SLUG }) },
  );
}

beforeEach(() => {
  mocks.checkRateLimit.mockResolvedValue({ allowed: true });
  mocks.submitReview.mockResolvedValue({ reviewId: "review-id" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("BotID write decision", () => {
  it.each([false, true])("denies isBot:true regardless of isVerifiedBot:%s", async (verified) => {
    mocks.checkBotId.mockResolvedValue({ isBot: true, isVerifiedBot: verified });

    expect(await verifyWriteRequest()).toEqual({ allowed: false, reason: "bot" });
    const response = await submit();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.submitReview).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("denies a verified crawler even when isBot is false", async () => {
    mocks.checkBotId.mockResolvedValue({ isBot: false, isVerifiedBot: true });

    expect(await verifyWriteRequest()).toEqual({ allowed: false, reason: "bot" });
    const response = await submit();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.submitReview).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ["throw", () => mocks.checkBotId.mockRejectedValue(new Error("secret detector failure"))],
    ["unknown", () => mocks.checkBotId.mockResolvedValue({ isBot: undefined })],
    ["partial", () => mocks.checkBotId.mockResolvedValue({ isBot: false, isVerifiedBot: undefined })],
  ])("fails closed on %s without submitting or leaking the error", async (_name, arrange) => {
    arrange();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await submit();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("retry-after")).toBe(false);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.submitReview).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0]).toEqual([
      JSON.stringify({ event: "botid_fail_closed", reason: "fail_closed" }),
    ]);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("secret detector failure");
  });

  it("admits a known-good human through the limiter to a successful submission", async () => {
    mocks.checkBotId.mockResolvedValue({ isBot: false, isVerifiedBot: false });

    expect(await verifyWriteRequest()).toEqual({ allowed: true });
    const response = await submit();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(IP);
    expect(mocks.submitReview).toHaveBeenCalledWith(SLUG, { score: 5 }, IP);
  });
});
