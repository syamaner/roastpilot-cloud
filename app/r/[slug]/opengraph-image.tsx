import type { ReactElement } from "react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ImageResponse } from "next/og";
import { cachedReviewsByRoast, cachedRoastBySlug } from "@/lib/roast-cache";
import { formatCelsius } from "@/lib/format";
import type { Review, Roast } from "@/lib/roast";
import {
  aggregateRating,
  beanLabel,
  roastDateLabel,
  truncateLabel,
} from "@/lib/roast-format";
import { isValidSlug } from "@/lib/slug";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "RoastPilot roast preview";

let fontPromise: Promise<ArrayBuffer> | null = null;

function loadGeistFont(): Promise<ArrayBuffer> {
  if (fontPromise === null) {
    fontPromise = readFile(
      fileURLToPath(new URL("./Geist-Regular.ttf", import.meta.url)),
    ).then((font) => Uint8Array.from(font).buffer);
  }
  return fontPromise;
}

type CurvePoint = { elapsed: number; temperature: number };
type CurveDomain = {
  minElapsed: number;
  maxElapsed: number;
  minTemperature: number;
  maxTemperature: number;
};

// Keep dynamic text inside the exact cmap of the vendored Geist file. The
// next/og wrapper otherwise attempts remote fallback-font and emoji requests
// for missing glyphs even when an explicit font is supplied.
const GEIST_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x20, 0x7e],
  [0xa0, 0xac],
  [0xae, 0x113],
  [0x116, 0x12b],
  [0x12e, 0x137],
  [0x139, 0x13e],
  [0x141, 0x148],
  [0x14a, 0x14d],
  [0x150, 0x17e],
  [0x18f, 0x18f],
  [0x192, 0x192],
  [0x1a0, 0x1a1],
  [0x1af, 0x1b0],
  [0x1cd, 0x1ce],
  [0x1e4, 0x1e9],
  [0x218, 0x21b],
  [0x237, 0x237],
  [0x259, 0x259],
  [0x2b9, 0x2b9],
  [0x2bc, 0x2bc],
  [0x2c6, 0x2c8],
  [0x2d8, 0x2dd],
  [0x300, 0x304],
  [0x306, 0x30c],
  [0x312, 0x312],
  [0x31b, 0x31b],
  [0x323, 0x323],
  [0x326, 0x328],
  [0x335, 0x338],
  [0x39b, 0x39b],
  [0x3a9, 0x3a9],
  [0x3bb, 0x3bc],
  [0x3c0, 0x3c0],
  [0x3c9, 0x3c9],
  [0x400, 0x45f],
  [0x462, 0x463],
  [0x46a, 0x46b],
  [0x472, 0x475],
  [0x490, 0x493],
  [0x496, 0x497],
  [0x49a, 0x49b],
  [0x4a2, 0x4a3],
  [0x4ae, 0x4b3],
  [0x4b6, 0x4b7],
  [0x4ba, 0x4bb],
  [0x4c0, 0x4c0],
  [0x4cf, 0x4cf],
  [0x4d8, 0x4d9],
  [0x4e2, 0x4e3],
  [0x4e8, 0x4e9],
  [0x4ee, 0x4ef],
  [0xe3f, 0xe3f],
  [0x1e20, 0x1e21],
  [0x1e80, 0x1e85],
  [0x1e9e, 0x1e9e],
  [0x1ea0, 0x1ef9],
  [0x2013, 0x2014],
  [0x2018, 0x201a],
  [0x201c, 0x201e],
  [0x2020, 0x2022],
  [0x2026, 0x2026],
  [0x2030, 0x2030],
  [0x2032, 0x2033],
  [0x2039, 0x203a],
  [0x2044, 0x2044],
  [0x2070, 0x2070],
  [0x2074, 0x2079],
  [0x2080, 0x2089],
  [0x20aa, 0x20aa],
  [0x20ac, 0x20ac],
  [0x20b1, 0x20b1],
  [0x20b4, 0x20b4],
  [0x20b9, 0x20b9],
  [0x20bd, 0x20bd],
  [0x2116, 0x2117],
  [0x2122, 0x2122],
  [0x2153, 0x2155],
  [0x215b, 0x215e],
  [0x2190, 0x2199],
  [0x219d, 0x219d],
  [0x21a9, 0x21aa],
  [0x21b0, 0x21b1],
  [0x21b3, 0x21b5],
  [0x21e4, 0x21e5],
  [0x21e7, 0x21e7],
  [0x2202, 0x2202],
  [0x2206, 0x2206],
  [0x220f, 0x220f],
  [0x2211, 0x2212],
  [0x221a, 0x221a],
  [0x221e, 0x221e],
  [0x222b, 0x222b],
  [0x2236, 0x2236],
  [0x2248, 0x2248],
  [0x2260, 0x2260],
  [0x2264, 0x2265],
  [0x2460, 0x2468],
  [0x24ea, 0x24ea],
  [0x24ff, 0x24ff],
  [0x25b2, 0x25b3],
  [0x25b6, 0x25b7],
  [0x25bc, 0x25bd],
  [0x25c0, 0x25c1],
  [0x25ca, 0x25cc],
  [0x25cf, 0x25cf],
  [0x2639, 0x263a],
  [0x2776, 0x277e],
  [0x3003, 0x3003],
  [0x301c, 0x301c],
  [0xa78b, 0xa78c],
  [0xf8ff, 0xf8ff],
  [0xfb01, 0xfb02],
];

function geistSafeLabel(label: string): string {
  return Array.from(label, (character) => {
    const codePoint = character.codePointAt(0)!;
    return GEIST_CODE_POINT_RANGES.some(
      ([first, last]) => codePoint >= first && codePoint <= last,
    )
      ? character
      : "?";
  }).join("");
}

function drawableCurveSegments(roast: Roast): CurvePoint[][] {
  const segments: CurvePoint[][] = [];
  let current: CurvePoint[] = [];

  for (const sample of roast.curve ?? []) {
    if (
      sample.elapsed_s !== null &&
      Number.isFinite(sample.elapsed_s) &&
      sample.bean_temp_c !== null &&
      Number.isFinite(sample.bean_temp_c)
    ) {
      current.push({
        elapsed: sample.elapsed_s,
        temperature: sample.bean_temp_c,
      });
    } else {
      if (current.length >= 2) segments.push(current);
      current = [];
    }
  }

  if (current.length >= 2) segments.push(current);
  return segments;
}

function curveDomain(points: CurvePoint[]): CurveDomain {
  const elapsed = points.map((point) => point.elapsed);
  const temperatures = points.map((point) => point.temperature);
  return {
    minElapsed: Math.min(...elapsed),
    maxElapsed: Math.max(...elapsed),
    minTemperature: Math.min(...temperatures),
    maxTemperature: Math.max(...temperatures),
  };
}

function polylinePoints(points: CurvePoint[], domain: CurveDomain): string {
  return points
    .map((point) => {
      let x = 300;
      if (domain.minElapsed !== domain.maxElapsed) {
        const ratio =
          (point.elapsed - domain.minElapsed) /
          (domain.maxElapsed - domain.minElapsed);
        const scaled = 20 + ratio * 560;
        if (Number.isFinite(scaled)) x = scaled;
      }

      let y = 100;
      if (domain.minTemperature !== domain.maxTemperature) {
        const ratio =
          (point.temperature - domain.minTemperature) /
          (domain.maxTemperature - domain.minTemperature);
        const scaled = 180 - ratio * 160;
        if (Number.isFinite(scaled)) y = scaled;
      }

      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

export function roastImageElement(
  roast: Roast | null,
  reviews: Review[],
): ReactElement {
  if (roast === null) {
    return (
      <div
        style={{
          alignItems: "center",
          background: "#17120f",
          color: "#f8efe7",
          display: "flex",
          fontSize: 72,
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        RoastPilot
      </div>
    );
  }

  const date = roastDateLabel(roast);
  const rating = aggregateRating(reviews);
  const segments = drawableCurveSegments(roast);
  const drawablePoints = segments.flatMap((segment) => segment);
  const domain = segments.length === 0 ? null : curveDomain(drawablePoints);
  const temperatures = drawablePoints.map((point) => point.temperature);

  return (
    <div
      style={{
        background: "#17120f",
        color: "#f8efe7",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: "64px 72px",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ color: "#d8a46d", display: "flex", fontSize: 28 }}>
          RoastPilot
        </div>
        <div
          data-testid="bean-title"
          style={{
            display: "flex",
            flexWrap: "wrap",
            fontSize: 64,
            fontWeight: 700,
            lineHeight: 1.05,
            marginTop: 20,
            maxHeight: 135,
            maxWidth: 1056,
            overflow: "hidden",
            overflowWrap: "anywhere",
            width: "100%",
            wordBreak: "break-word",
          }}
        >
          {geistSafeLabel(truncateLabel(beanLabel(roast)))}
        </div>
        <div
          style={{ display: "flex", fontSize: 28, gap: 24, marginTop: 18 }}
        >
          {date === null ? null : <span>{date}</span>}
          <span>
            {rating === null ? "No ratings yet" : `${rating.toFixed(1)} / 5`}
          </span>
        </div>
      </div>
      {domain === null ? null : (
        <div
          style={{
            alignItems: "flex-end",
            display: "flex",
            gap: 24,
            width: "100%",
          }}
        >
          <svg
            aria-label="Bean temperature roast curve"
            height="200"
            role="img"
            viewBox="0 0 600 200"
            width="840"
          >
            {segments.map((segment, index) => (
              <polyline
                fill="none"
                key={index}
                points={polylinePoints(segment, domain)}
                stroke="#d8a46d"
                strokeWidth="6"
              />
            ))}
          </svg>
          <div style={{ display: "flex", fontSize: 22 }}>
            {formatCelsius(Math.min(...temperatures))}–
            {formatCelsius(Math.max(...temperatures))}
          </div>
        </div>
      )}
    </div>
  );
}

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const fontData = await loadGeistFont();
  const imageOptions = {
    ...size,
    fonts: [
      {
        name: "Geist",
        data: fontData,
        weight: 400 as const,
        style: "normal" as const,
      },
    ],
  };

  if (!isValidSlug(slug)) {
    return new ImageResponse(roastImageElement(null, []), imageOptions);
  }

  const roast = await cachedRoastBySlug(slug);
  if (roast === null) {
    return new ImageResponse(roastImageElement(null, []), imageOptions);
  }

  const reviews = await cachedReviewsByRoast(slug);
  return new ImageResponse(roastImageElement(roast, reviews), imageOptions);
}
