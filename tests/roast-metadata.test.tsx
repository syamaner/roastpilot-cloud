import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReviewsByRoast, getRoastBySlug, type Review, type Roast } from "@/lib/roast";
import { SqlApiError } from "../lib/sqlapi";
import { unstable_cache } from "next/cache";
import { generateMetadata } from "../app/r/[slug]/page";

vi.mock("@/lib/roast", () => ({
  getRoastBySlug: vi.fn(),
  getReviewsByRoast: vi.fn(),
}));

vi.mock("@/lib/slug", async () => import("../lib/slug"));

vi.mock("@/lib/roast-cache", async () => import("../lib/roast-cache"));

vi.mock("@/lib/roast-format", async () => import("../lib/roast-format"));

vi.mock("next/cache", () => ({
  unstable_cache: vi.fn((read: (slug: string) => unknown) => read),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

const roastMock = vi.mocked(getRoastBySlug);
const reviewsMock = vi.mocked(getReviewsByRoast);
const unstableCacheMock = vi.mocked(unstable_cache);

const DEMO_SLUG = "demoroastseedone234";
const UNKNOWN_SLUG = "unknownroastseed123";
const PRIVATE_SLUG = "privateroastseed123";

function roastFixture(overrides: Partial<Roast> = {}): Roast {
  return {
    public_slug: DEMO_SLUG,
    bean_origin: "Ethiopia Guji",
    bean_varietal: "74110",
    bean_weight_g: 250,
    profile_name: "Filter 01",
    roast_level: "light",
    roasted_at_utc: "1780834787.000000000 1440",
    created_at: "2026-06-07T12:25:50.249395+00:00",
    summary: {
      started_at_utc: "2026-06-07T12:00:00+00:00",
      first_crack_at_utc: "2026-06-07T12:09:01.519+00:00",
      beans_added_at_utc: "2026-06-07T12:00:00+00:00",
      beans_dropped_at_utc: "2026-06-07T12:10:37.106+00:00",
      total_roast_seconds: 637.106,
      development_time_percent: 15.003,
    },
    curve: null,
    stats: {
      totalRoastSeconds: 637.106,
      firstCrackSeconds: 541.519,
      developmentTimePercent: 15.003,
      firstCrackTempC: null,
      dropTempC: null,
    },
    ...overrides,
  };
}

function review(score: number): Review {
  return {
    public_slug: DEMO_SLUG,
    reviewer_name: null,
    score,
    aroma: null,
    acidity: null,
    sweetness: null,
    body: null,
    aftertaste: null,
    brew_method: null,
    notes: null,
    created_at: "2026-06-08T12:00:00+00:00",
  };
}

function metadataFor(slug: string) {
  return generateMetadata({ params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  roastMock.mockReset();
  reviewsMock.mockReset();
});

describe("roast OpenGraph metadata", () => {
  it("builds full OpenGraph and Twitter metadata from the shared cached reads", async () => {
    roastMock.mockResolvedValue(roastFixture());
    reviewsMock.mockResolvedValue([review(5), review(4)]);

    const metadata = await metadataFor(DEMO_SLUG);

    expect(metadata).toEqual({
      title: "Ethiopia Guji · 74110",
      description: "2026-06-07 · 4.5 / 5",
      openGraph: {
        title: "Ethiopia Guji · 74110",
        description: "2026-06-07 · 4.5 / 5",
      },
      twitter: {
        card: "summary_large_image",
        title: "Ethiopia Guji · 74110",
        description: "2026-06-07 · 4.5 / 5",
      },
    });
    expect(roastMock).toHaveBeenCalledWith(DEMO_SLUG);
    expect(reviewsMock).toHaveBeenCalledWith(DEMO_SLUG);
    expect(unstableCacheMock).toHaveBeenCalledTimes(2);
    expect(unstableCacheMock.mock.calls.map((call) => call[1])).toEqual([
      ["roast-by-slug"],
      ["reviews-by-roast"],
    ]);
  });

  it("uses the no-ratings treatment and omits a missing date", async () => {
    roastMock.mockResolvedValue(roastFixture({ roasted_at_utc: null }));
    reviewsMock.mockResolvedValue([]);

    const metadata = await metadataFor(DEMO_SLUG);

    expect(metadata.description).toBe("No ratings yet");
    expect(JSON.stringify(metadata)).not.toContain("0.0");
  });

  it("returns byte-identical minimal metadata for private and unknown slugs", async () => {
    roastMock.mockResolvedValue(null);

    const privateMetadata = await metadataFor(PRIVATE_SLUG);
    const unknownMetadata = await metadataFor(UNKNOWN_SLUG);

    expect(JSON.stringify(privateMetadata)).toBe(JSON.stringify(unknownMetadata));
    expect(privateMetadata).toEqual({ title: "RoastPilot Cloud" });
    expect(JSON.stringify(privateMetadata)).not.toMatch(/bean|date|rating|Guji/i);
    expect(roastMock).toHaveBeenNthCalledWith(1, PRIVATE_SLUG);
    expect(roastMock).toHaveBeenNthCalledWith(2, UNKNOWN_SLUG);
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it("returns minimal metadata for an invalid slug without reading", async () => {
    await expect(metadataFor("!!!")).resolves.toEqual({
      title: "RoastPilot Cloud",
    });
    expect(roastMock).not.toHaveBeenCalled();
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it("propagates read errors instead of laundering them into metadata", async () => {
    const error = new SqlApiError("not_found", "bounded read failure");
    roastMock.mockRejectedValue(error);

    await expect(metadataFor(DEMO_SLUG)).rejects.toBe(error);
    expect(reviewsMock).not.toHaveBeenCalled();
  });
});
