import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewsList } from "../components/ReviewsList";
import { RoastHeadline } from "../components/RoastHeadline";
import type { Review, Roast } from "@/lib/roast";

function reviewFixture(overrides: Partial<Review> = {}): Review {
  return {
    public_slug: "demo-roast",
    reviewer_name: "Ari Example",
    score: 5,
    aroma: 5,
    acidity: 4,
    sweetness: 5,
    body: 4,
    aftertaste: 5,
    brew_method: "V60",
    notes: "Peach and jasmine",
    created_at: "2026-06-09T10:00:00+00:00",
    ...overrides,
  };
}

function roastFixture(): Roast {
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
  };
}

describe("ReviewsList", () => {
  it("T-reviews-list: renders each review in the supplied order", () => {
    const reviews = [
      reviewFixture(),
      reviewFixture({
        reviewer_name: "Bo Second",
        score: 4,
        notes: "Chocolate finish",
        created_at: "2026-06-08T10:00:00+00:00",
      }),
    ];

    const markup = renderToStaticMarkup(<ReviewsList reviews={reviews} />);

    expect(markup.match(/data-testid="review-row"/g)).toHaveLength(2);
    expect(markup).toContain("Ari");
    expect(markup).toContain("Score: 5");
    expect(markup).toContain("Peach and jasmine");
    expect(markup).toContain("Bo");
    expect(markup).toContain("Score: 4");
    expect(markup).toContain("Chocolate finish");
    expect(markup.indexOf("Ari")).toBeLessThan(markup.indexOf("Bo"));
  });

  it("T-anon: treats null and whitespace-only reviewer names as anonymous", () => {
    const reviews = [
      reviewFixture({ reviewer_name: null, notes: null }),
      reviewFixture({
        reviewer_name: "  ",
        created_at: "2026-06-08T10:00:00+00:00",
      }),
    ];

    const markup = renderToStaticMarkup(<ReviewsList reviews={reviews} />);

    expect(markup.match(/Anonymous/g)).toHaveLength(2);
    expect(markup).not.toMatch(/null/i);
  });

  it("T-firstname: reveals only the first whitespace-delimited name token", () => {
    const markup = renderToStaticMarkup(
      <ReviewsList
        reviews={[reviewFixture({ reviewer_name: "Jane Smith" })]}
      />,
    );

    expect(markup).toContain("Jane");
    expect(markup).not.toContain("Jane Smith");
    expect(markup).not.toContain("Smith");
  });

  it("T-empty-reviews: renders only the warm empty state", () => {
    const markup = renderToStaticMarkup(<ReviewsList reviews={[]} />);

    expect(markup).toContain("Be the first to taste this roast");
    expect(markup).not.toContain("data-testid=\"review-row\"");
  });

  it("T-no-pii: headline and reviews expose no private boundary fields", () => {
    const markup = renderToStaticMarkup(
      <main>
        <RoastHeadline roast={roastFixture()} />
        <ReviewsList reviews={[reviewFixture()]} />
      </main>,
    );

    expect(markup).not.toMatch(/hashed[_ ]?ip/i);
    expect(markup).not.toMatch(/\bvisibility\b/i);
    expect(markup).not.toMatch(/\bowner\b/i);
    expect(markup).not.toMatch(/private\b/i);
    expect(markup).not.toMatch(/[0-9a-f]{64}/);
  });
});
