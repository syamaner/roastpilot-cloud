import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoastHeadline } from "../components/RoastHeadline";
import type { Roast } from "@/lib/roast";

function roastFixture(overrides: Partial<Roast> = {}): Roast {
  return {
    public_slug: "demo-roast",
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
    curve: [],
    stats: {
      totalRoastSeconds: 637.106,
      firstCrackSeconds: 541.519,
      developmentTimePercent: 15.003,
      firstCrackTempC: 201.5,
      dropTempC: 205.25,
    },
    ...overrides,
  };
}

function renderHeadline(roast: Roast): string {
  return renderToStaticMarkup(<RoastHeadline roast={roast} />);
}

describe("RoastHeadline", () => {
  it("T-headline-full: renders bean metadata, date, and each supplied stat", () => {
    const markup = renderHeadline(roastFixture());

    expect(markup).toContain("Ethiopia Guji · 74110");
    expect(markup).toContain("Roast level: light");
    expect(markup).toContain(
      '<time dateTime="2026-06-07">2026-06-07</time>',
    );
    expect(markup).not.toContain("1780834787.000000000 1440");
    expect(markup).toContain("Total roast time");
    expect(markup).toContain("10:37");
    expect(markup).toContain("First crack time");
    expect(markup).toContain("9:02");
    expect(markup).toContain("201.5 °C");
    expect(markup).toContain("205.3 °C");
    expect(markup).toContain("15.0 %");
    expect(markup.match(/Total roast time/g)).toHaveLength(1);
  });

  it("T-zero-temp: preserves a real zero-degree first-crack temperature", () => {
    const roast = roastFixture({
      stats: { ...roastFixture().stats, firstCrackTempC: 0 },
    });

    const markup = renderHeadline(roast);

    expect(markup).toContain("0.0 °C");
    expect(markup).not.toContain("—");
  });

  it("T-nullable-meta: handles all nullable metadata without rendering null", () => {
    const markup = renderHeadline(
      roastFixture({
        bean_origin: null,
        bean_varietal: null,
        roast_level: null,
        roasted_at_utc: null,
      }),
    );

    expect(markup).toContain("<h1>Roast</h1>");
    expect(markup).not.toMatch(/null/i);
    expect(markup).not.toContain("Roast level:");
    expect(markup).not.toContain("Roast date:");
  });

  it("T-no-fahrenheit: never labels or converts a temperature as Fahrenheit", () => {
    const markup = renderHeadline(roastFixture());
    const sources = [
      readFileSync(
        new URL("../components/RoastHeadline.tsx", import.meta.url),
        "utf8",
      ),
      readFileSync(new URL("../lib/format.ts", import.meta.url), "utf8"),
    ];

    expect(markup).not.toMatch(/fahrenheit/i);
    expect(markup).not.toMatch(/°\s*F/);
    for (const source of sources) {
      expect(source).not.toMatch(/fahrenheit/i);
      expect(source).not.toMatch(/°\s*F/);
      expect(source).not.toMatch(/\*\s*9\s*\/\s*5/);
    }
  });
});
