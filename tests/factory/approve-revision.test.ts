import { describe, expect, it } from "vitest";

import {
  canonicalIssueRevision,
  isApprovedRevision,
} from "../../scripts/factory/approve-revision.mts";

describe("canonical approved issue revision digest", () => {
  it("is deterministic and emits lowercase SHA-256 hex", () => {
    const first = canonicalIssueRevision("Reviewed title", "reviewed body");
    expect(canonicalIssueRevision("Reviewed title", "reviewed body")).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes title-only and body-only changes", () => {
    expect(canonicalIssueRevision("title one", "body")).not.toBe(
      canonicalIssueRevision("title two", "body"),
    );
    expect(canonicalIssueRevision("title", "body one")).not.toBe(
      canonicalIssueRevision("title", "body two"),
    );
  });

  it("is injective across field order and newline-concatenation traps", () => {
    expect(canonicalIssueRevision("A", "B")).not.toBe(
      canonicalIssueRevision("B", "A"),
    );
    expect(canonicalIssueRevision("a", "b\nc")).not.toBe(
      canonicalIssueRevision("a\nb", "c"),
    );
  });

  it("normalizes null fields exactly like empty strings", () => {
    expect(canonicalIssueRevision(null, "body")).toBe(
      canonicalIssueRevision("", "body"),
    );
    expect(canonicalIssueRevision("title", null)).toBe(
      canonicalIssueRevision("title", ""),
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
