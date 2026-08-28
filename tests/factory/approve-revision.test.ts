import { describe, expect, it } from "vitest";

import {
  computeApprovedRevision,
  isApprovedRevision,
} from "../../scripts/factory/approve-revision.mts";

describe("approved issue-body revision digest", () => {
  it("is deterministic and emits lowercase SHA-256 hex", () => {
    const first = computeApprovedRevision("reviewed body");
    expect(computeApprovedRevision("reviewed body")).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes different issue bodies", () => {
    expect(computeApprovedRevision("body one")).not.toBe(
      computeApprovedRevision("body two"),
    );
  });

  it("rejects non-string input", () => {
    expect(() => computeApprovedRevision(42 as unknown as string)).toThrow(
      TypeError,
    );
  });

  it("recognizes only canonical 64-character lowercase hex", () => {
    expect(isApprovedRevision("a".repeat(64))).toBe(true);
    expect(isApprovedRevision("A".repeat(64))).toBe(false);
    expect(isApprovedRevision("a".repeat(63))).toBe(false);
    expect(isApprovedRevision("junk")).toBe(false);
    expect(isApprovedRevision(null)).toBe(false);
  });
});
