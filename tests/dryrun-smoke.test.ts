import { describe, expect, it } from "vitest";
import { dryRunSmoke } from "../lib/dryrun-smoke";

describe("dryRunSmoke", () => {
  it("prefixes a normal label", () => {
    expect(dryRunSmoke("hello")).toBe("[dry-run] hello");
  });

  it("trims a whitespace-padded label", () => {
    expect(dryRunSmoke("  hello  ")).toBe("[dry-run] hello");
  });

  it("returns the empty marker for an empty or whitespace-only label", () => {
    expect(dryRunSmoke("")).toBe("[dry-run] (empty)");
    expect(dryRunSmoke("   ")).toBe("[dry-run] (empty)");
  });
});
