import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReviewsByRoast, getRoastBySlug, type Roast } from "@/lib/roast";
import { SqlApiError } from "../lib/sqlapi";
import { unstable_cache } from "next/cache";
import { notFound } from "next/navigation";
import NotFound from "../app/r/[slug]/not-found";
import Page, {
  generateStaticParams,
  revalidate,
} from "../app/r/[slug]/page";
import { ReportProblemLink } from "../components/ReportProblemLink";

const notFoundSentinel = vi.hoisted(
  () => new Error("recognizable not-found sentinel"),
);

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
  notFound: vi.fn(() => {
    throw notFoundSentinel;
  }),
}));

const roastMock = vi.mocked(getRoastBySlug);
const reviewsMock = vi.mocked(getReviewsByRoast);
const unstableCacheMock = vi.mocked(unstable_cache);
const notFoundMock = vi.mocked(notFound);

const DEMO_SLUG = "demoroastseedone234";
const UNKNOWN_SLUG = "unknownroastseed123";
const PRIVATE_SLUG = "privateroastseed123";
const OUTAGE_SLUG = "outageroastseed1234";
const TASTER_REPORT_URL =
  "https://github.com/syamaner/roastpilot-cloud/issues/new?template=taster-report.yml";

function reportHref(markup: string): string {
  const encodedHref = markup.match(/<a href="([^"]+)"/)?.[1];
  expect(encodedHref).toBeDefined();
  return encodedHref!.replaceAll("&amp;", "&");
}

function roastFixture(overrides: Partial<Roast> = {}): Roast {
  return {
    public_slug: "demo-roast",
    bean_origin: "Ethiopia Guji",
    bean_varietal: "74110",
    bean_weight_g: 250,
    profile_name: "Filter 01",
    roast_level: "light",
    roasted_at_utc: "2026-06-07T12:19:47.297516+00:00",
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

async function renderPage(slug: string): Promise<string> {
  const element = await Page({ params: Promise.resolve({ slug }) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  roastMock.mockReset();
  reviewsMock.mockReset();
  reviewsMock.mockResolvedValue([]);
  notFoundMock.mockClear();
});

describe("public roast page control flow", () => {
  it("T-404-unknown: sends an unknown roast through the segment not-found path", async () => {
    roastMock.mockResolvedValue(null);

    await expect(renderPage(UNKNOWN_SLUG)).rejects.toBe(notFoundSentinel);
    expect(notFoundMock).toHaveBeenCalledOnce();
    expect(reviewsMock).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<NotFound />)).toBe("<p>Not found</p>");
  });

  it("T-404-private: makes a private roast indistinguishable from an unknown roast", async () => {
    roastMock.mockResolvedValue(null);

    await expect(renderPage(PRIVATE_SLUG)).rejects.toBe(notFoundSentinel);
    expect(notFoundMock).toHaveBeenCalledOnce();
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it("T-error-not-404: propagates a roast read error", async () => {
    const error = new SqlApiError("not_found", "bounded read failure");
    roastMock.mockRejectedValue(error);

    await expect(renderPage(OUTAGE_SLUG)).rejects.toBe(error);
    expect(notFoundMock).not.toHaveBeenCalled();
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it("T-reviews-error: propagates a reviews read error without rendering an empty state", async () => {
    const error = new SqlApiError("not_found", "bounded reviews failure");
    roastMock.mockResolvedValue(roastFixture());
    reviewsMock.mockRejectedValue(error);

    await expect(renderPage(DEMO_SLUG)).rejects.toBe(error);
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("T-null-curve: renders unavailable temperatures without losing other stats", async () => {
    roastMock.mockResolvedValue(roastFixture());

    const markup = await renderPage(DEMO_SLUG);

    expect(roastMock).toHaveBeenCalledWith(DEMO_SLUG);
    expect(reviewsMock).toHaveBeenCalledWith(DEMO_SLUG);
    expect(markup.match(/<dd>—<\/dd>/g)).toHaveLength(2);
    expect(markup).toContain("10:37");
    expect(markup).toContain("9:02");
    expect(markup).toContain("15.0 %");
    expect(markup).toContain('aria-label="Roast curve"');
    expect(markup).not.toContain("0.0 °C");
    expect(markup).not.toMatch(/°\s*F|null|NaN/);
    expect(unstableCacheMock).toHaveBeenCalledTimes(3);
  });

  it("T-ssg-flags: preserves ISR and on-demand static generation", () => {
    expect(revalidate).toBe(300);
    expect(generateStaticParams()).toEqual([]);
  });

  it("T-link-render: shows the report link after reviews", async () => {
    roastMock.mockResolvedValue(roastFixture());

    const markup = await renderPage(DEMO_SLUG);

    expect(markup).toContain("Report a problem with this page");
    expect(markup.indexOf("Report a problem with this page")).toBeGreaterThan(
      markup.indexOf("Taster reviews"),
    );
    expect(reportHref(markup)).toBe(TASTER_REPORT_URL);
    expect(markup).toMatch(/<a [^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it("T-link-no-slug: leaves the roast's access slug out of the report URL", async () => {
    roastMock.mockResolvedValue(roastFixture());

    const href = reportHref(await renderPage(DEMO_SLUG));

    expect(href).toBe(TASTER_REPORT_URL);
    expect(href).not.toContain(DEMO_SLUG);
    expect(href).not.toContain("title=");
    expect(href).not.toContain("/r/");
  });

  it("T-no-request-api: keeps the link a request-independent server component", () => {
    const source = readFileSync(
      join(process.cwd(), "components/ReportProblemLink.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:headers|cookies|fetch|useState|useEffect)\s*\(/);
    expect(source).not.toMatch(/["']use client["']/);
    expect(source).not.toMatch(/\bonClick\b|\bformAction\b/);
  });

  it("T-link-no-prefill: emits only the constant template URL", () => {
    const href = reportHref(renderToStaticMarkup(<ReportProblemLink />));

    expect(href).toBe(TASTER_REPORT_URL);
    expect(href).not.toContain("title=");
    expect(href).not.toContain("/r/");
  });

  it("T-invalid-slug: rejects a malformed slug before querying Snowflake", async () => {
    await expect(renderPage("!!!")).rejects.toBe(notFoundSentinel);

    expect(notFoundMock).toHaveBeenCalledOnce();
    expect(roastMock).not.toHaveBeenCalled();
    expect(reviewsMock).not.toHaveBeenCalled();
  });

  it("T-anon-source: has no authentication or request-scoped API in the anonymous path", () => {
    const paths = [
      "app/r/[slug]/page.tsx",
      "app/r/[slug]/opengraph-image.tsx",
      "app/r/[slug]/not-found.tsx",
      "components/RoastHeadline.tsx",
      "components/RoastThumbnail.tsx",
      "components/ReviewsList.tsx",
      "components/RoastCurve.tsx",
      "components/StarRating.tsx",
      "components/FlavorSliders.tsx",
      "components/ReviewForm.tsx",
      "components/ReviewSection.tsx",
      "components/ReportProblemLink.tsx",
      "components/review-form-logic.ts",
      "lib/format.ts",
      "lib/roast-format.ts",
    ];
    const source = paths
      .map((path) => readFileSync(join(process.cwd(), path), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/next-auth/);
    expect(source).not.toMatch(/getServerSession/);
    expect(source).not.toMatch(/cookies\s*\(/);
    expect(source).not.toMatch(/\bheaders\s*\(/);
    expect(source).not.toMatch(/\bsession\b/i);
    expect(source).not.toMatch(/localStorage/);
    expect(source).not.toMatch(/sessionStorage/);
    expect(source).not.toMatch(/document\.cookie/);
    expect(source).not.toMatch(/indexedDB/);
  });
});
