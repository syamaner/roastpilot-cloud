import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RoastCurve from "../components/RoastCurve";
import type { CurveSample } from "@/lib/roast";

function sample(overrides: Partial<CurveSample> = {}): CurveSample {
  return {
    elapsed_s: 0,
    bean_temp_c: 100,
    env_temp_c: 120,
    heat_percent: 50,
    fan_percent: 20,
    ror_c_per_min: 12,
    ...overrides,
  };
}

function fullFixture(): CurveSample[] {
  return [
    sample(),
    sample({
      elapsed_s: 10,
      bean_temp_c: 110,
      env_temp_c: 130,
      heat_percent: 80,
      fan_percent: 30,
      ror_c_per_min: 10,
    }),
  ];
}

function renderCurve(curve: CurveSample[] | null): string {
  return renderToStaticMarkup(<RoastCurve curve={curve} />);
}

function path(markup: string, testId: string): string {
  return markup.match(
    new RegExp(`data-testid="${testId}" d="([^"]+)"`),
  )?.[1] ?? "";
}

describe("RoastCurve", () => {
  it("T-five-series: renders a stable path identifier for every full-fixture series", () => {
    const markup = renderCurve(fullFixture());

    for (const testId of [
      "series-bean",
      "series-env",
      "series-ror",
      "series-heat",
      "series-fan",
    ]) {
      expect(markup).toContain(`data-testid="${testId}"`);
    }
  });

  it("T-legend: always names all five series on the chart path", () => {
    const markup = renderCurve(fullFixture());

    for (const name of ["Bean temp", "Env temp", "RoR", "Heat", "Fan"]) {
      expect(markup).toContain(`${name}</li>`);
    }
  });

  it("renders a scrollable minimum-width plot with its landmark and complete legend", () => {
    const markup = renderCurve(fullFixture());
    const textElements = markup.match(/<text\b[^>]*>/g) ?? [];
    const legend = markup.match(
      /<ul aria-label="Roast curve legend">([\s\S]*?)<\/ul>/,
    )?.[1] ?? "";

    expect(markup).toMatch(/^<section aria-label="Roast curve">/);
    expect(markup).toMatch(
      /<div[^>]*data-testid="roast-curve-scroll"[^>]*style="[^"]*overflow-x:auto/,
    );
    expect(markup).toMatch(/<svg\b[^>]*width="100%"/);
    expect(markup).toContain("max-width:800px");
    expect(markup).toContain("min-width:640px");
    expect(markup).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(markup).not.toContain('stroke="black"');
    expect(markup.match(/stroke="currentColor"/g)).toHaveLength(4);
    expect(markup).toContain('stroke-width="2.5"');
    expect(textElements.length).toBeGreaterThan(0);
    for (const textElement of textElements) {
      expect(textElement).toContain('fill="currentColor"');
      expect(textElement).toContain('font-size="16"');
    }
    expect(legend.match(/<li>/g)).toHaveLength(5);
  });

  it("renders a matching colour swatch for every legend series", () => {
    const markup = renderCurve(fullFixture());
    const swatches = [
      ["bean", "sienna"],
      ["env", "steelblue"],
      ["ror", "mediumpurple"],
      ["heat", "#c2410c"],
      ["fan", "teal"],
    ];

    for (const [series, colour] of swatches) {
      expect(markup).toMatch(
        new RegExp(
          `data-testid="legend-swatch-${series}"[^>]*background-color:${colour}`,
        ),
      );
    }
    expect(markup).toMatch(
      /data-testid="series-ror"[^>]*stroke="mediumpurple"/,
    );
    expect(markup).toMatch(
      /data-testid="series-heat"[^>]*stroke="#c2410c"/,
    );
  });

  it("right-anchors the RoR and percent labels inside the viewBox", () => {
    const markup = renderCurve(fullFixture());

    expect(markup).toMatch(
      /<text\b[^>]*x="635.00"[^>]*text-anchor="end"[^>]*>RoR \(°C\/min\):/,
    );
    expect(markup).toMatch(
      /<text\b[^>]*x="795.00"[^>]*text-anchor="end"[^>]*>Percent: 100%/,
    );
  });

  it("T-celsius-labels: labels temperature, rate, and elapsed-seconds axes", () => {
    const markup = renderCurve(fullFixture());

    expect(markup).toContain("°C");
    expect(markup).toContain("RoR (°C/min)");
    expect(markup).toContain("Temperature (°C): 130.0 °C");
    expect(markup).toContain("RoR (°C/min): 12.0 °C/min");
    expect(markup).toContain("Elapsed time (seconds)");
  });

  it("T-elapsed-axis: formats elapsed ticks with the shared seconds formatter", () => {
    expect(renderCurve(fullFixture())).toContain(">0:10</text>");
  });

  it("T-step-not-linear: holds heat constant until the next x coordinate", () => {
    const heat = path(renderCurve(fullFixture()), "series-heat");

    expect(heat).toContain(
      "M 80.00 180.00 L 640.00 180.00 L 640.00 96.00",
    );
    expect(heat).not.toBe("M 80.00 180.00 L 640.00 96.00");
  });

  it("T-fan-step-not-linear: holds fan constant until the next x coordinate", () => {
    const fanFixture = [
      sample({ elapsed_s: 0, fan_percent: 20 }),
      sample({ elapsed_s: 10, fan_percent: 70 }),
    ];
    const fan = path(renderCurve(fanFixture), "series-fan");

    expect(fan).toContain(
      "M 80.00 264.00 L 640.00 264.00 L 640.00 124.00",
    );
    expect(fan).not.toBe("M 80.00 264.00 L 640.00 124.00");
  });

  it("T-null-curve-placeholder: fails closed without an SVG", () => {
    const markup = renderCurve(null);

    expect(markup).toBe(
      '<section aria-label="Roast curve"><p>Curve not shared</p></section>',
    );
    expect(markup).not.toContain("<svg");
    expect(markup).not.toMatch(/NaN|null|°\s*F/);
  });

  it("T-empty-array-placeholder: treats an empty curve as unshared", () => {
    const markup = renderCurve([]);

    expect(markup).toContain("Curve not shared");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toMatch(/NaN|null|°\s*F/);
  });

  it("T-no-plottable-placeholder: rejects a curve without finite elapsed values", () => {
    const markup = renderCurve([
      sample({ elapsed_s: null }),
      sample({ elapsed_s: Number.POSITIVE_INFINITY }),
    ]);

    expect(markup).toContain("Curve not shared");
    expect(markup).not.toContain("<svg");
    expect(markup).not.toMatch(/NaN|null|°\s*F/);
  });

  it("T-all-null-series: omits an empty bean line but retains other lines and its legend entry", () => {
    const curve = fullFixture().map((point) => ({
      ...point,
      bean_temp_c: null,
    }));
    const markup = renderCurve(curve);

    expect(markup).not.toContain('data-testid="series-bean"');
    expect(markup).toContain('data-testid="series-env"');
    expect(markup).toContain("Bean temp</li>");
    expect(markup).not.toContain("NaN");
  });

  it("uses finite fallback domains without fabricating empty scale labels", () => {
    const curve = fullFixture().map((point) => ({
      ...point,
      bean_temp_c: null,
      env_temp_c: null,
      ror_c_per_min: null,
    }));
    const markup = renderCurve(curve);

    expect(markup).toContain("<svg");
    expect(markup).not.toContain("Temperature (°C):");
    expect(markup).not.toContain("RoR (°C/min):");
    expect(markup).not.toMatch(/NaN|Infinity/);
  });

  it("suppresses RoR values when no RoR segment is drawable", () => {
    const curve = fullFixture().map((point) => ({
      ...point,
      ror_c_per_min: null,
    }));
    const markup = renderCurve(curve);

    expect(markup).toContain("Temperature (°C): 130.0 °C");
    expect(markup).not.toContain("RoR (°C/min):");
    expect(markup).toContain("RoR</li>");
    expect(markup).toContain('data-testid="legend-swatch-ror"');
  });

  it("suppresses temperature values when no temperature segment is drawable", () => {
    const curve = fullFixture().map((point) => ({
      ...point,
      bean_temp_c: null,
      env_temp_c: null,
    }));
    const markup = renderCurve(curve);

    expect(markup).not.toContain("Temperature (°C):");
    expect(markup).toContain("RoR (°C/min): 12.0 °C/min");
    expect(markup).toContain("Bean temp</li>");
    expect(markup).toContain("Env temp</li>");
  });

  it("ignores non-finite elapsed samples when deriving temperature domains", () => {
    const markup = renderCurve([
      sample({ elapsed_s: null, bean_temp_c: 500, env_temp_c: 600 }),
      ...fullFixture(),
    ]);

    expect(markup).toContain("<svg");
    expect(markup).toContain('data-testid="series-bean"');
    expect(markup).toContain("Temperature (°C): 130.0 °C");
    expect(markup).not.toContain("600.0 °C");
    expect(markup).not.toContain("NaN");
  });

  it("does not stretch temperature or rate domains with isolated undrawn points", () => {
    const drawableCurve = [
      sample({
        elapsed_s: 0,
        bean_temp_c: 100,
        env_temp_c: null,
        ror_c_per_min: 5,
      }),
      sample({
        elapsed_s: 10,
        bean_temp_c: 200,
        env_temp_c: null,
        ror_c_per_min: 10,
      }),
      sample({
        elapsed_s: 20,
        bean_temp_c: null,
        env_temp_c: null,
        ror_c_per_min: null,
      }),
      sample({
        elapsed_s: 30,
        bean_temp_c: null,
        env_temp_c: null,
        ror_c_per_min: null,
      }),
    ];
    const isolatedOutlierCurve = drawableCurve.map((point, index) =>
      index === 3
        ? { ...point, bean_temp_c: 1_000, ror_c_per_min: 1_000 }
        : point,
    );

    const markupWithoutOutlier = renderCurve(drawableCurve);
    const markupWithIsolatedOutlier = renderCurve(isolatedOutlierCurve);
    const beanWithoutOutlier = path(markupWithoutOutlier, "series-bean");
    const beanWithIsolatedOutlier = path(
      markupWithIsolatedOutlier,
      "series-bean",
    );
    const rateWithoutOutlier = path(markupWithoutOutlier, "series-ror");
    const rateWithIsolatedOutlier = path(
      markupWithIsolatedOutlier,
      "series-ror",
    );

    expect(beanWithIsolatedOutlier).toBe(beanWithoutOutlier);
    expect(rateWithIsolatedOutlier).toBe(rateWithoutOutlier);
    expect(beanWithIsolatedOutlier).toBe(
      "M 80.00 320.00 L 266.67 40.00",
    );
    expect(rateWithIsolatedOutlier).toBe(
      "M 80.00 320.00 L 266.67 40.00",
    );
  });

  it("omits paths with fewer than two points while retaining the complete legend", () => {
    const markup = renderCurve([
      sample(),
      sample({
        elapsed_s: 10,
        bean_temp_c: null,
        env_temp_c: 130,
        heat_percent: null,
        fan_percent: null,
        ror_c_per_min: null,
      }),
    ]);

    expect(markup).toContain("<svg");
    expect(markup).not.toContain('data-testid="series-bean"');
    expect(markup).toContain('data-testid="series-env"');
    expect(markup).not.toContain('data-testid="series-ror"');
    expect(markup).not.toContain('data-testid="series-heat"');
    expect(markup).not.toContain('data-testid="series-fan"');
    for (const name of ["Bean temp", "Env temp", "RoR", "Heat", "Fan"]) {
      expect(markup).toContain(`${name}</li>`);
    }
  });

  it("T-gaps: starts a new sub-path after a non-plottable sample", () => {
    const markup = renderCurve([
      sample({ elapsed_s: 0, bean_temp_c: 100 }),
      sample({ elapsed_s: 10, bean_temp_c: 110 }),
      sample({ elapsed_s: 20, bean_temp_c: null }),
      sample({ elapsed_s: 30, bean_temp_c: 120 }),
      sample({ elapsed_s: 40, bean_temp_c: 130 }),
    ]);
    const bean = path(markup, "series-bean");

    expect(bean.match(/\bM\b/g)).toHaveLength(2);
    expect(bean).not.toContain("NaN");
  });

  it("T-single-x-safe: maps a degenerate elapsed domain to finite coordinates", () => {
    const markup = renderCurve([
      sample({ elapsed_s: 7, bean_temp_c: 100 }),
      sample({ elapsed_s: 7, bean_temp_c: 100 }),
    ]);

    expect(markup).not.toMatch(/NaN|Infinity/);
    expect(markup).toContain('viewBox="0 0 800 400"');
  });

  it("T-no-nan-in-path: mixed nulls and extreme finite values remain finite", () => {
    const markup = renderCurve([
      sample({
        elapsed_s: -Number.MAX_VALUE,
        bean_temp_c: null,
        env_temp_c: null,
        ror_c_per_min: null,
      }),
      sample({
        elapsed_s: Number.MAX_VALUE / 2,
        bean_temp_c: null,
        env_temp_c: null,
        ror_c_per_min: null,
      }),
      sample({
        elapsed_s: Number.MAX_VALUE,
        bean_temp_c: null,
        env_temp_c: null,
        ror_c_per_min: null,
      }),
      sample({ elapsed_s: 5, heat_percent: null, fan_percent: null }),
    ]);

    expect(markup).not.toMatch(/NaN|Infinity/);
    expect(markup).toContain('viewBox="0 0 800 400"');
  });

  it("keeps extreme finite y values inside finite SVG coordinates", () => {
    const markup = renderCurve([
      sample({
        elapsed_s: 0,
        bean_temp_c: -Number.MAX_VALUE,
        heat_percent: Number.MAX_VALUE,
      }),
      sample({
        elapsed_s: 10,
        bean_temp_c: Number.MAX_VALUE / 2,
        heat_percent: Number.MAX_VALUE / 2,
      }),
      sample({
        elapsed_s: 20,
        bean_temp_c: Number.MAX_VALUE,
        heat_percent: Number.MAX_VALUE,
      }),
    ]);

    expect(markup).toContain('data-testid="series-bean"');
    expect(markup).toContain('data-testid="series-heat"');
    expect(markup).not.toMatch(/NaN|Infinity/);
  });

  it("T-no-fahrenheit: neither output nor component source contains a forbidden label or conversion", () => {
    const markup = renderCurve(fullFixture());
    const source = readFileSync(
      new URL("../components/RoastCurve.tsx", import.meta.url),
      "utf8",
    );

    for (const content of [markup, source]) {
      expect(content).not.toMatch(/fahrenheit/i);
      expect(content).not.toMatch(/°\s*F/);
      expect(content).not.toMatch(/\*\s*9\s*\/\s*5/);
    }
  });

  it("T-ssr-determinism: is a pure server render with byte-stable output", () => {
    const source = readFileSync(
      new URL("../components/RoastCurve.tsx", import.meta.url),
      "utf8",
    );
    const fixture = fullFixture();

    expect(source).not.toContain("Date.now");
    expect(source).not.toContain("Math.random");
    expect(source).not.toContain("toLocaleString");
    expect(source).not.toMatch(/["']use client["']/);
    expect(renderCurve(fixture)).toBe(renderCurve(fixture));
  });
});
