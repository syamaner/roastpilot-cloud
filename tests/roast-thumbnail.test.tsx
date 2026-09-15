import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoastThumbnail } from "../components/RoastThumbnail";
import { RoastHeadline } from "../components/RoastHeadline";
import type { Roast } from "@/lib/roast";

const roast: Roast = {
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
    firstCrackTempC: 201.5,
    dropTempC: 205.25,
  },
};

describe("RoastThumbnail", () => {
  it("T-thumbnail-decorative: is a token-backed decorative server render", () => {
    const source = readFileSync(
      new URL("../components/RoastThumbnail.tsx", import.meta.url),
      "utf8",
    );
    const markup = renderToStaticMarkup(<RoastThumbnail />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("<svg");
    expect(markup).toContain("var(--rp-");
    expect(markup).not.toContain("#d97706");
    expect(source).not.toMatch(/["']use client["']/);
    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("Math.random");
    expect(source).not.toContain("toLocaleString");
  });

  it("T-thumbnail-composition: renders the decorative thumbnail in the headline", () => {
    const markup = renderToStaticMarkup(<RoastHeadline roast={roast} />);

    expect(markup).toContain('data-testid="roast-thumbnail"');
  });
});
