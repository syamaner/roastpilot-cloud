import { describe, expect, it } from "vitest";

import {
  computeApprovedRevision,
  isApprovedRevision,
} from "../../scripts/factory/approve-revision.mts";

describe("approve revision", () => {
  it("computes the stable SHA-256 digest of the UTF-8 issue body", () => {
    const expected =
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(computeApprovedRevision("abc")).toBe(expected);
    expect(computeApprovedRevision("abc")).toBe(expected);
    expect(computeApprovedRevision("abcd")).not.toBe(expected);
  });

  it("throws for non-string input", () => {
    expect(() => computeApprovedRevision(null as unknown as string)).toThrow(
      TypeError,
    );
  });

  it.each([
    "",
    "a".repeat(63),
    "a".repeat(65),
    "A".repeat(64),
    `${"a".repeat(63)}g`,
    null,
  ])("rejects malformed approved revision %j", (raw) => {
    expect(isApprovedRevision(raw)).toBe(false);
  });

  it("accepts exactly 64 lowercase hexadecimal characters", () => {
    expect(isApprovedRevision("0123456789abcdef".repeat(4))).toBe(true);
  });
});
