import { describe, expect, it } from "vitest";
import { isValidSlug, MIN_SLUG_LENGTH } from "../lib/slug";

describe("MIN_SLUG_LENGTH", () => {
  it("is long enough to guarantee at least 96 bits of base58 entropy", () => {
    // log2(58) ~= 5.858 bits/char; 96 bits needs at least ceil(96/5.858)
    // = 17 characters. Assert the concrete number so a future edit to the
    // alphabet or the entropy floor has to consciously update this too.
    expect(MIN_SLUG_LENGTH).toBe(17);
  });
});

describe("isValidSlug", () => {
  it("accepts a slug at exactly the minimum length", () => {
    expect(isValidSlug("A".repeat(MIN_SLUG_LENGTH))).toBe(true);
  });

  it("accepts a realistic mixed-case base58 slug", () => {
    expect(isValidSlug("8vFge5R2wPq7ZbXnK9m")).toBe(true);
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
