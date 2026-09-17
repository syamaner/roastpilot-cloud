import { afterEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  submitReview: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: routeMocks.revalidatePath,
}));

vi.mock("botid/server", () => ({
  checkBotId: vi.fn(async () => ({ isBot: false })),
}));

vi.mock("../lib/review-submit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/review-submit")>();
  return { ...actual, submitReview: routeMocks.submitReview };
});

import { POST } from "../app/api/r/[slug]/reviews/route";
import { extractClientIp } from "../lib/client-ip";

const VALID_SLUG = "23456789ABCDEFGHJK";

function requestWithHeaders(headers?: HeadersInit) {
  return new Request("https://example.test/review", { headers });
}

describe("extractClientIp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.REVIEW_IP_HASH_PEPPER;
  });

  it("returns a valid trimmed x-real-ip", () => {
    expect(
      extractClientIp(requestWithHeaders({ "x-real-ip": " 203.0.113.4 " })),
    ).toBe("203.0.113.4");
  });

  it("falls back to the leftmost x-forwarded-for entry", () => {
    expect(
      extractClientIp(
        requestWithHeaders({
          "x-forwarded-for": "198.51.100.8, 203.0.113.9",
        }),
      ),
    ).toBe("198.51.100.8");
  });

  it("never selects an attacker-appended x-forwarded-for entry", () => {
    expect(
      extractClientIp(
        requestWithHeaders({
          "x-forwarded-for": "192.0.2.10, 6.6.6.6, 198.51.100.20",
        }),
      ),
    ).toBe("192.0.2.10");
  });

  it.each([
    ["absent", undefined],
    ["garbage", { "x-forwarded-for": "not-an-ip" }],
    ["empty", { "x-forwarded-for": "   " }],
  ])("returns an empty string when the header is %s", (_case, headers) => {
    expect(extractClientIp(requestWithHeaders(headers))).toBe("");
  });

  it("falls back to x-forwarded-for when x-real-ip is malformed", () => {
    expect(
      extractClientIp(
        requestWithHeaders({
          "x-real-ip": "invalid",
          "x-forwarded-for": "2001:db8::5, 198.51.100.2",
        }),
      ),
    ).toBe("2001:db8::5");
  });

  it("fails the real limiter closed through the route when forwarding data is malformed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await POST(
      new Request("https://example.test/api/reviews", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "attacker-controlled-garbage",
        },
        body: JSON.stringify({ score: 5 }),
      }),
      { params: Promise.resolve({ slug: VALID_SLUG }) },
    );

    expect(response.status).toBe(429);
    expect(response.headers.has("retry-after")).toBe(false);
    expect(routeMocks.submitReview).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  });
});
