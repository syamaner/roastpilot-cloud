import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReviewsByRoast, getRoastBySlug, type Review, type Roast } from "@/lib/roast";
import { SqlApiError } from "../lib/sqlapi";

const imageResponseMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/roast", () => ({
  getRoastBySlug: vi.fn(),
  getReviewsByRoast: vi.fn(),
}));

vi.mock("@/lib/slug", async () => import("../lib/slug"));

vi.mock("@/lib/roast-cache", async () => import("../lib/roast-cache"));

vi.mock("@/lib/roast-format", async () => import("../lib/roast-format"));

vi.mock("@/lib/format", async () => import("../lib/format"));

vi.mock("next/cache", () => ({
  unstable_cache: vi.fn((read: (slug: string) => unknown) => read),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
}));

vi.mock("next/og", () => ({
  ImageResponse: class {
    constructor(element: unknown, options: unknown) {
      imageResponseMock(element, options);
    }
  },
}));

import Image, {
  contentType,
  roastImageElement,
  size,
} from "../app/r/[slug]/opengraph-image";

const roastMock = vi.mocked(getRoastBySlug);
const reviewsMock = vi.mocked(getReviewsByRoast);

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
    curve: [
      {
        elapsed_s: 0,
        bean_temp_c: 100,
        env_temp_c: null,
        heat_percent: null,
        fan_percent: null,
        ror_c_per_min: null,
      },
      {
        elapsed_s: 600,
        bean_temp_c: 205,
        env_temp_c: null,
        heat_percent: null,
        fan_percent: null,
        ror_c_per_min: null,
      },
    ],
    stats: {
      totalRoastSeconds: 637.106,
      firstCrackSeconds: 541.519,
      developmentTimePercent: 15.003,
      firstCrackTempC: 201.5,
      dropTempC: 205,
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

function expectGeistFontOptions(options: unknown): void {
  expect(options).toMatchObject({
    ...size,
    fonts: [
      {
        name: "Geist",
        weight: 400,
        style: "normal",
      },
    ],
  });
  const typedOptions = options as { fonts: Array<{ data: ArrayBuffer }> };
  expect(typedOptions.fonts[0].data).toBeInstanceOf(ArrayBuffer);
  expect(typedOptions.fonts[0].data.byteLength).toBe(125_956);
}

function bundledGeistFont(): ArrayBuffer {
  const fontFile = readFileSync(
    new URL("../app/r/[slug]/Geist-Regular.ttf", import.meta.url),
  );
  return fontFile.buffer.slice(
    fontFile.byteOffset,
    fontFile.byteOffset + fontFile.byteLength,
  ) as ArrayBuffer;
}

async function renderWithBundledGeist(
  element: ReturnType<typeof roastImageElement>,
): Promise<ArrayBuffer> {
  const { ImageResponse: ActualImageResponse } =
    await vi.importActual<typeof import("next/og")>("next/og");
  const response = new ActualImageResponse(element, {
    ...size,
    fonts: [
      {
        name: "Geist",
        data: bundledGeistFont(),
        weight: 400,
        style: "normal",
      },
    ],
  });
  return response.arrayBuffer();
}

beforeEach(() => {
  roastMock.mockReset();
  reviewsMock.mockReset();
  imageResponseMock.mockClear();
});

describe("roast OpenGraph image", () => {
  it("renders bean, date, aggregate rating, and the finite bean-temperature curve", () => {
    const roast = roastFixture({
      curve: [
        ...(roastFixture().curve ?? []),
        {
          elapsed_s: null,
          bean_temp_c: 999,
          env_temp_c: null,
          heat_percent: null,
          fan_percent: null,
          ror_c_per_min: null,
        },
      ],
    });
    const markup = renderToStaticMarkup(
      roastImageElement(roast, [review(5), review(4)]),
    );

    expect(markup).toContain("Ethiopia Guji · 74110");
    expect(markup).toContain("2026-06-07");
    expect(markup).toContain("4.5 / 5");
    expect(markup.match(/<polyline/g)).toHaveLength(1);
    expect(markup).toContain("100.0 °C");
    expect(markup).toContain("205.0 °C");
    expect(markup).not.toContain("999.0");
  });

  it("T-img-long-bean: truncates the title and renders a healthy real image", async () => {
    const longOrigin = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(46);
    const longRoast = roastFixture({ bean_origin: longOrigin });
    const markup = renderToStaticMarkup(
      roastImageElement(longRoast, [review(5), review(4)]),
    );

    expect(markup).toContain(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUV…",
    );
    expect(markup).not.toContain(longOrigin);
    expect(markup).toContain("2026-06-07");
    expect(markup).toContain("4.5 / 5");
    expect(markup).toContain("<polyline");
    expect(markup).toContain('data-testid="bean-title"');
    expect(markup).toContain("display:flex");
    expect(markup).toContain("flex-wrap:wrap");
    expect(markup).toContain("max-height:135px");
    expect(markup).toContain("max-width:1056px");
    expect(markup).toContain("overflow:hidden");
    expect(markup).toContain("overflow-wrap:anywhere");
    expect(markup).toContain("word-break:break-word");
    expect(markup).not.toContain("-webkit-box");
    expect(markup).not.toContain("-webkit-line-clamp");

    const bytes = await renderWithBundledGeist(
      roastImageElement(longRoast, [review(5), review(4)]),
    );
    expect(bytes.byteLength).toBeGreaterThan(20_000);

    const wideRoast = roastFixture({
      bean_origin: "W".repeat(48),
      bean_varietal: null,
    });
    const wideMarkup = renderToStaticMarkup(roastImageElement(wideRoast, []));
    expect(wideMarkup).toContain("W".repeat(48));
    const wideBytes = await renderWithBundledGeist(
      roastImageElement(wideRoast, []),
    );
    expect(wideBytes.byteLength).toBeGreaterThan(20_000);
  });

  it("renders unsupported CJK with the local fallback and no outbound request", async () => {
    const roast = roastFixture({
      bean_origin: "浅煎りエチオピア",
      bean_varietal: null,
    });
    const markup = renderToStaticMarkup(roastImageElement(roast, []));
    const outboundUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (/^https?:/.test(url)) {
          outboundUrls.push(url);
          return Promise.reject(new Error(`Blocked outbound request: ${url}`));
        }
        return originalFetch(input, init);
      },
    );

    try {
      expect(markup).toContain("????????");
      expect(markup).not.toContain("浅煎りエチオピア");
      const bytes = await renderWithBundledGeist(roastImageElement(roast, []));
      expect(bytes.byteLength).toBeGreaterThan(20_000);
      expect(outboundUrls).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("preserves an interior telemetry gap as two separate curve segments", () => {
    const roast = roastFixture({
      curve: [
        {
          elapsed_s: 0,
          bean_temp_c: 100,
          env_temp_c: null,
          heat_percent: null,
          fan_percent: null,
          ror_c_per_min: null,
        },
        {
          elapsed_s: 60,
          bean_temp_c: 150,
          env_temp_c: null,
          heat_percent: null,
          fan_percent: null,
          ror_c_per_min: null,
        },
        {
          elapsed_s: 120,
          bean_temp_c: null,
          env_temp_c: null,
          heat_percent: null,
          fan_percent: null,
          ror_c_per_min: null,
        },
        {
          elapsed_s: 180,
          bean_temp_c: 190,
          env_temp_c: null,
          heat_percent: null,
          fan_percent: null,
          ror_c_per_min: null,
        },
        {
          elapsed_s: 240,
          bean_temp_c: 205,
          env_temp_c: null,
          heat_percent: null,
          fan_percent: null,
          ror_c_per_min: null,
        },
      ],
    });
    const markup = renderToStaticMarkup(roastImageElement(roast, []));

    expect(markup.match(/<polyline/g)).toHaveLength(2);
    expect(markup).toContain("100.0 °C");
    expect(markup).toContain("205.0 °C");
  });

  it("routes distinct private and unknown slugs to the same brand-only placeholder", async () => {
    roastMock.mockResolvedValue(null);

    await Image({ params: Promise.resolve({ slug: PRIVATE_SLUG }) });
    await Image({ params: Promise.resolve({ slug: UNKNOWN_SLUG }) });

    expect(roastMock).toHaveBeenNthCalledWith(1, PRIVATE_SLUG);
    expect(roastMock).toHaveBeenNthCalledWith(2, UNKNOWN_SLUG);
    expect(reviewsMock).not.toHaveBeenCalled();
    expect(imageResponseMock).toHaveBeenCalledTimes(2);
    for (const call of imageResponseMock.mock.calls) {
      expectGeistFontOptions(call[1]);
    }

    const privateMarkup = renderToStaticMarkup(
      imageResponseMock.mock.calls[0][0],
    );
    const unknownMarkup = renderToStaticMarkup(
      imageResponseMock.mock.calls[1][0],
    );

    expect(privateMarkup).toBe(unknownMarkup);
    expect(privateMarkup).toContain("RoastPilot");
    expect(privateMarkup).not.toMatch(/Guji|2026-06-07|4\.5|polyline|svg/i);
  });

  it("does not read for an invalid slug", async () => {
    await Image({ params: Promise.resolve({ slug: "!!!" }) });

    expect(roastMock).not.toHaveBeenCalled();
    expect(reviewsMock).not.toHaveBeenCalled();
    expect(imageResponseMock).toHaveBeenCalledOnce();
    expectGeistFontOptions(imageResponseMock.mock.calls[0][1]);
  });

  it("propagates read errors", async () => {
    const error = new SqlApiError("not_found", "bounded read failure");
    roastMock.mockRejectedValue(error);

    await expect(
      Image({ params: Promise.resolve({ slug: DEMO_SLUG }) }),
    ).rejects.toBe(error);
    expect(imageResponseMock).not.toHaveBeenCalled();
  });

  it("reads reviews through the shared cache for a visible roast", async () => {
    roastMock.mockResolvedValue(roastFixture());
    reviewsMock.mockResolvedValue([review(3)]);

    await Image({ params: Promise.resolve({ slug: DEMO_SLUG }) });

    expect(reviewsMock).toHaveBeenCalledWith(DEMO_SLUG);
    const markup = renderToStaticMarkup(imageResponseMock.mock.calls[0][0]);
    expect(markup).toContain("3.0 / 5");
    expectGeistFontOptions(imageResponseMock.mock.calls[0][1]);
  });

  it("keeps overflow-scale coordinates finite", () => {
    const markup = renderToStaticMarkup(
      roastImageElement(
        roastFixture({
          curve: [
            {
              elapsed_s: -Number.MAX_VALUE,
              bean_temp_c: -Number.MAX_VALUE,
              env_temp_c: null,
              heat_percent: null,
              fan_percent: null,
              ror_c_per_min: null,
            },
            {
              elapsed_s: Number.MAX_VALUE,
              bean_temp_c: Number.MAX_VALUE,
              env_temp_c: null,
              heat_percent: null,
              fan_percent: null,
              ror_c_per_min: null,
            },
          ],
        }),
        [],
      ),
    );

    expect(markup).toContain("<polyline");
    expect(markup).not.toContain("NaN");
  });

  it("renders no-ratings text and one degenerate, fully finite segment", () => {
    const roast = roastFixture({
      roasted_at_utc: null,
      curve: [
        {
          elapsed_s: 12,
          bean_temp_c: 100,
          env_temp_c: null,
          heat_percent: null,
          fan_percent: null,
          ror_c_per_min: null,
        },
        {
          elapsed_s: 12,
          bean_temp_c: 100,
          env_temp_c: null,
          heat_percent: null,
          fan_percent: null,
          ror_c_per_min: null,
        },
      ],
    });
    const markup = renderToStaticMarkup(roastImageElement(roast, []));

    expect(markup).toContain("No ratings yet");
    expect(markup).not.toContain("0.0 / 5");
    expect(markup).not.toContain("2026-06-07");
    expect(markup.match(/<polyline/g)).toHaveLength(1);
    expect(markup).toContain(
      'points="300.00,100.00 300.00,100.00"',
    );
  });

  it("omits the curve for null or wholly non-finite curve data", () => {
    const nullMarkup = renderToStaticMarkup(
      roastImageElement(roastFixture({ curve: null }), []),
    );
    const emptyMarkup = renderToStaticMarkup(
      roastImageElement(roastFixture({ curve: [] }), []),
    );
    const nonFiniteMarkup = renderToStaticMarkup(
      roastImageElement(
        roastFixture({
          curve: [
            {
              elapsed_s: Number.NaN,
              bean_temp_c: Number.POSITIVE_INFINITY,
              env_temp_c: null,
              heat_percent: null,
              fan_percent: null,
              ror_c_per_min: null,
            },
          ],
        }),
        [],
      ),
    );
    const isolatedRunsMarkup = renderToStaticMarkup(
      roastImageElement(
        roastFixture({
          curve: [
            {
              elapsed_s: 0,
              bean_temp_c: 100,
              env_temp_c: null,
              heat_percent: null,
              fan_percent: null,
              ror_c_per_min: null,
            },
            {
              elapsed_s: 60,
              bean_temp_c: null,
              env_temp_c: null,
              heat_percent: null,
              fan_percent: null,
              ror_c_per_min: null,
            },
            {
              elapsed_s: 120,
              bean_temp_c: 200,
              env_temp_c: null,
              heat_percent: null,
              fan_percent: null,
              ror_c_per_min: null,
            },
          ],
        }),
        [],
      ),
    );

    expect(nullMarkup).not.toContain("<svg");
    expect(emptyMarkup).not.toContain("<svg");
    expect(nonFiniteMarkup).not.toContain("<svg");
    expect(isolatedRunsMarkup).not.toContain("<svg");
  });

  it("declares the expected image contract without an edge runtime", () => {
    const source = readFileSync(
      new URL("../app/r/[slug]/opengraph-image.tsx", import.meta.url),
      "utf8",
    );

    expect(size).toEqual({ width: 1200, height: 630 });
    expect(contentType).toBe("image/png");
    expect(source).toContain(
      'new URL("./Geist-Regular.ttf", import.meta.url)',
    );
    expect(source).toContain("fileURLToPath(");
    expect(source).toContain("function loadGeistFont()");
    expect(source).toContain("await loadGeistFont()");
    expect(source).not.toMatch(/const\s+geistFont\s*=\s*readFile/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/runtime\s*=\s*["']edge["']/);
    expect(source).not.toMatch(/\bemoji\s*:/);
  });

  it("contains no Fahrenheit label or conversion", () => {
    const markup = renderToStaticMarkup(roastImageElement(roastFixture(), []));
    const sources = [
      readFileSync(
        new URL("../app/r/[slug]/opengraph-image.tsx", import.meta.url),
        "utf8",
      ),
      readFileSync(new URL("../lib/roast-format.ts", import.meta.url), "utf8"),
    ];

    expect(markup).not.toMatch(/°\s*F/);
    expect(markup).not.toMatch(/fahrenheit/i);
    expect(markup).not.toMatch(/\*\s*9\s*\/\s*5/);
    for (const source of sources) {
      expect(source).not.toMatch(/°\s*F/);
      expect(source).not.toMatch(/fahrenheit/i);
      expect(source).not.toMatch(/\*\s*9\s*\/\s*5/);
    }
  });
});
