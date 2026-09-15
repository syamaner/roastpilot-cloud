import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(
  join(process.cwd(), "app/globals.css"),
  "utf8",
);
const keys = ["bean", "env", "ror", "heat", "fan"] as const;

function values(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/--rp-series-([\w-]+)\s*:\s*([^;]+);/g)].map(
      ([, name, value]) => [name, value.trim()],
    ),
  );
}

describe("roast curve series theme tokens", () => {
  it("T-series-light-parity: preserves the original light series colours", () => {
    const root = globalsCss.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(values(root)).toEqual(
      new Map([
        ["bean", "sienna"],
        ["env", "steelblue"],
        ["ror", "mediumpurple"],
        ["heat", "#c2410c"],
        ["fan", "teal"],
      ]),
    );
  });

  it("T-series-dark-differ: redefines every series in the dark media block", () => {
    const root = globalsCss.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
    const dark = globalsCss.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/,
    )?.[1] ?? "";
    const lightValues = values(root);
    const darkValues = values(dark);
    const expectedDarkValues = new Map([
      ["bean", "#d98a5c"],
      ["env", "#7fb3e0"],
      ["ror", "#c4b0f0"],
      ["heat", "#fb923c"],
      ["fan", "#2dd4bf"],
    ]);

    for (const key of keys) {
      expect(darkValues.get(key)).toBeDefined();
      expect(darkValues.get(key)).not.toBe(lightValues.get(key));
      expect(darkValues.get(key)).toBe(expectedDarkValues.get(key));
      expect(darkValues.get(key)).not.toBe("#292524");
    }
  });
});
