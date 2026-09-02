import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isValidSlug,
  MAX_SLUG_LENGTH,
  MIN_SLUG_LENGTH,
} from "../lib/slug";

const UPSERT_ROAST_SQL = readFileSync(
  new URL("../snowflake/migrations/R__proc_upsert_roast.sql", import.meta.url),
  "utf8",
);

describe("MIN_SLUG_LENGTH", () => {
  it("is long enough to guarantee at least 96 bits of base58 entropy", () => {
    // log2(58) ~= 5.858 bits/char; 96 bits needs at least ceil(96/5.858)
    // = 17 characters. Assert the concrete number so a future edit to the
    // alphabet or the entropy floor has to consciously update this too.
    expect(MIN_SLUG_LENGTH).toBe(17);
  });
});

describe("slug length contract", () => {
  it("byte-matches both bounds in the Snowflake upsert regex literal", () => {
    const grammar = UPSERT_ROAST_SQL.match(
      /regexp_like\s*\(\s*v_payload:public_slug::string\s*,\s*'(\^[^']+\$)'/i,
    )?.[1];

    expect(grammar).toBe(
      `^[1-9A-HJ-NP-Za-km-z]{${MIN_SLUG_LENGTH},${MAX_SLUG_LENGTH}}$`,
    );
  });
});

describe("isValidSlug", () => {
  it("accepts a slug at exactly the minimum length", () => {
    expect(isValidSlug("A".repeat(MIN_SLUG_LENGTH))).toBe(true);
  });

  it("accepts a realistic mixed-case base58 slug", () => {
    expect(isValidSlug("8vFge5R2wPq7ZbXnK9m")).toBe(true);
  });

  it("accepts the maximum length and rejects one character above it", () => {
    expect(isValidSlug("A".repeat(MAX_SLUG_LENGTH))).toBe(true);
    expect(isValidSlug("A".repeat(MAX_SLUG_LENGTH + 1))).toBe(false);
  });

  it("rejects a slug one character short of the minimum", () => {
    expect(isValidSlug("A".repeat(MIN_SLUG_LENGTH - 1))).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidSlug("")).toBe(false);
  });

  it.each(["0", "O", "I", "l"])(
    "rejects slugs containing the excluded base58 character %s",
    (excluded) => {
      const candidate = excluded + "A".repeat(MIN_SLUG_LENGTH - 1);
      expect(isValidSlug(candidate)).toBe(false);
    },
  );

  it("rejects slugs with non-alphanumeric characters", () => {
    const candidate = "A".repeat(MIN_SLUG_LENGTH - 1) + "-";
    expect(isValidSlug(candidate)).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidSlug(undefined as unknown as string)).toBe(false);
    expect(isValidSlug(null as unknown as string)).toBe(false);
    expect(isValidSlug(12345 as unknown as string)).toBe(false);
  });
});
