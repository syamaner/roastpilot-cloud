import { readFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Roast } from "@/lib/roast";
import {
  cachedReviewsByRoast,
  cachedRoastBySlug,
} from "@/lib/roast-cache";
import Page, {
  generateStaticParams,
  revalidate,
} from "../app/r/[slug]/page";
import RootLayout from "../app/layout";
import postcssConfig from "../postcss.config.mjs";

vi.mock("@/lib/roast-cache", () => ({
  cachedRoastBySlug: vi.fn(),
  cachedReviewsByRoast: vi.fn(),
  cachedRoastRatingBySlug: vi.fn(),
}));

vi.mock("@/lib/slug", async () => import("../lib/slug"));

vi.mock("@/lib/roast-format", async () => import("../lib/roast-format"));

const roastMock = vi.mocked(cachedRoastBySlug);
const reviewsMock = vi.mocked(cachedReviewsByRoast);
const globalsCssPath = join(process.cwd(), "app/globals.css");
const globalsCss = readFileSync(globalsCssPath, "utf8");
const themeTokenNames = [
  "--rp-bg",
  "--rp-bg-gradient-to",
  "--rp-surface",
  "--rp-surface-muted",
  "--rp-surface-subtle",
  "--rp-foreground",
  "--rp-foreground-muted",
  "--rp-primary",
  "--rp-primary-strong",
  "--rp-primary-strong-hover",
  "--rp-on-primary",
  "--rp-on-amber",
  "--rp-ring",
  "--rp-border",
  "--rp-series-bean",
  "--rp-series-env",
  "--rp-series-ror",
  "--rp-series-heat",
  "--rp-series-fan",
].sort();
const constantThemeTokens = new Set(["--rp-on-amber"]);
const semanticAliases = [
  "background",
  "surface",
  "surface-muted",
  "surface-subtle",
  "primary",
  "primary-strong",
  "primary-strong-hover",
  "on-primary",
  "on-amber",
  "foreground",
  "foreground-muted",
  "border",
  "ring",
] as const;

function declarations(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/(--rp-[\w-]+)\s*:\s*([^;]+);/g)].map(
      ([, name, value]) => [name, value.trim()],
    ),
  );
}

function themeBlocks(): { light: Map<string, string>; dark: Map<string, string> } {
  const lightSource = globalsCss.match(/:root\s*\{([^}]*)\}/)?.[1];
  const darkSource = globalsCss.match(
    /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/,
  )?.[1];

  expect(lightSource).toBeDefined();
  expect(darkSource).toBeDefined();
  return {
    light: declarations(lightSource ?? ""),
    dark: declarations(darkSource ?? ""),
  };
}

function roastFixture(): Roast {
  return {
    public_slug: "demoroastseedone234",
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

beforeEach(() => {
  roastMock.mockReset();
  roastMock.mockResolvedValue(roastFixture());
  reviewsMock.mockReset();
  reviewsMock.mockResolvedValue([]);
});

describe("theme and layout shell", () => {
  it("T-1 defines dark values for every theme token and keeps constant roles stable", () => {
    const { light, dark } = themeBlocks();

    expect(globalsCss).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    for (const [name, lightValue] of light) {
      expect(dark.get(name), `${name} is missing from the dark theme`).toBeDefined();
      if (constantThemeTokens.has(name)) {
        expect(dark.get(name), `${name} must stay constant across themes`).toBe(
          lightValue,
        );
      } else {
        expect(dark.get(name), `${name} must differ in the dark theme`).not.toBe(
          lightValue,
        );
      }
    }
  });

  it("T-2 keeps the light and dark token-name sets identical", () => {
    const { light, dark } = themeBlocks();

    expect([...light.keys()].sort()).toEqual(themeTokenNames);
    expect([...dark.keys()].sort()).toEqual(themeTokenNames);
  });

  it("T-3 applies token-backed body colors and exposes semantic utilities", () => {
    expect(globalsCss).toMatch(
      /body\s*\{[\s\S]*?background:\s*var\(--rp-bg\)/,
    );
    expect(globalsCss).toMatch(
      /body\s*\{[\s\S]*?color:\s*var\(--rp-foreground\)/,
    );
    for (const alias of semanticAliases) {
      expect(globalsCss).toContain(
        `--color-${alias}: var(--rp-${alias === "background" ? "bg" : alias});`,
      );
    }
    for (const radius of ["card", "control", "input"]) {
      expect(globalsCss).toContain(
        `--radius-${radius}: var(--rp-radius-${radius});`,
      );
    }

    const shellMarkup = renderToStaticMarkup(
      <RootLayout>
        <main>Shell content</main>
      </RootLayout>,
    );
    expect(shellMarkup).toContain(
      'class="min-h-screen bg-background text-foreground"',
    );
    expect(shellMarkup).toContain(
      'class="mx-auto min-h-screen max-w-[var(--rp-container)] px-6"',
    );
  });

  it("T-3b compiles the layout shell utilities through Tailwind", async () => {
    expect(postcssConfig.plugins).toHaveProperty("@tailwindcss/postcss");
    const result = await postcss([tailwindcss()]).process(globalsCss, {
      from: globalsCssPath,
    });

    expect(result.css).toContain(".bg-background");
    expect(result.css).toContain(".text-foreground");
    expect(result.css).toContain(".min-h-screen");
    expect(result.css).toContain(".px-6");
    expect(result.css).toContain(
      ".max-w-\\[var\\(--rp-container\\)\\]",
    );
    expect(result.css).toMatch(
      /\.bg-background\s*\{[^}]*background-color:\s*var\(--rp-bg\)/,
    );
    expect(result.css).toMatch(
      /\.text-foreground\s*\{[^}]*color:\s*var\(--rp-foreground\)/,
    );
  });

  it("T-3c keeps Tailwind Preflight disabled", async () => {
    const result = await postcss([tailwindcss()]).process(globalsCss, {
      from: globalsCssPath,
    });

    expect(globalsCss).not.toMatch(/@import\s+["']tailwindcss["']\s*;/);
    expect(globalsCss).not.toMatch(
      /@import\s+["']tailwindcss\/preflight(?:\.css)?["']/,
    );
    expect(result.css).not.toMatch(
      /h1,\s*h2,\s*h3,\s*h4,\s*h5,\s*h6\s*\{[^}]*font-size:\s*inherit;[^}]*font-weight:\s*inherit;/,
    );
    expect(result.css).not.toMatch(
      /button,\s*input,\s*select,\s*optgroup,\s*textarea,[^{]*\{[^}]*border-radius:\s*0;[^}]*background-color:\s*transparent;/,
    );
  });

  it("T-3d keeps the shell width within the border-box cap", async () => {
    const result = await postcss([tailwindcss()]).process(globalsCss, {
      from: globalsCssPath,
    });

    expect(result.css).toMatch(
      /@layer base\s*\{\s*\*,\s*::before,\s*::after\s*\{\s*box-sizing:\s*border-box;/,
    );
  });

  it("T-4 preserves static generation for public roast pages", () => {
    expect(revalidate).toBe(300);
    expect(generateStaticParams()).toEqual([]);
  });

  it("T-6 keeps the shell static and anonymous", () => {
    const layoutSource = readFileSync(
      join(process.cwd(), "app/layout.tsx"),
      "utf8",
    );
    const source = `${layoutSource}\n${globalsCss}`;

    expect(source).not.toMatch(/next-auth/);
    expect(source).not.toMatch(/getServerSession/);
    expect(source).not.toMatch(/cookies\s*\(/);
    expect(source).not.toMatch(/headers\s*\(/);
    expect(source).not.toMatch(/\bsession\b/i);
    expect(source).not.toMatch(/use client/);
    expect(source).not.toMatch(/localStorage/);
    expect(source).not.toMatch(/document\.cookie/);
    expect(layoutSource).not.toMatch(
      /\bfrom\s*["']next\/(?:headers|cookies)["']/,
    );
    expect(layoutSource).not.toMatch(
      /\bimport\s*\(\s*["']next\/(?:headers|cookies)["']\s*\)/,
    );
  });

  it("T-7 preserves public-page heading, time, and curve semantics", async () => {
    const element = await Page({
      params: Promise.resolve({ slug: "demoroastseedone234" }),
    });
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain('aria-label="Roast curve"');
    expect(markup.match(/<h1(?:\s[^>]*)?>/g)).toHaveLength(1);
    expect(markup).toMatch(/<time dateTime=/);
  });

  it("T-9 does not introduce Fahrenheit or invalid values", async () => {
    const element = await Page({
      params: Promise.resolve({ slug: "demoroastseedone234" }),
    });
    const markup = renderToStaticMarkup(element);

    expect(markup).not.toMatch(/°\s*F|null|NaN/);
  });
});
