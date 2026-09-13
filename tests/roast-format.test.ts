import { describe, expect, it } from "vitest";
import {
  beanLabel,
  roastDateLabel,
  truncateLabel,
} from "../lib/roast-format";

describe("roast formatting", () => {
  it("formats every nullable bean-label combination", () => {
    expect(beanLabel({ bean_origin: null, bean_varietal: null })).toBe("Roast");
    expect(beanLabel({ bean_origin: "Kenya", bean_varietal: null })).toBe(
      "Kenya",
    );
    expect(beanLabel({ bean_origin: null, bean_varietal: "SL28" })).toBe(
      "SL28",
    );
    expect(beanLabel({ bean_origin: "Kenya", bean_varietal: "SL28" })).toBe(
      "Kenya · SL28",
    );
    expect(beanLabel({ bean_origin: "", bean_varietal: "Heirloom" })).toBe(
      "Heirloom",
    );
    expect(beanLabel({ bean_origin: "", bean_varietal: "   " })).toBe(
      "Roast",
    );
    expect(
      beanLabel({ bean_origin: "  Ethiopia Guji  ", bean_varietal: null }),
    ).toBe("Ethiopia Guji");
  });

  it("formats Snowflake epoch and ISO roast dates as UTC calendar dates", () => {
    expect(
      roastDateLabel({ roasted_at_utc: "1780834787.000000000 1440" }),
    ).toBe("2026-06-07");
    expect(
      roastDateLabel({ roasted_at_utc: "1780834787.000000000" }),
    ).toBe("2026-06-07");
    expect(roastDateLabel({ roasted_at_utc: "2026-06-07T12:19:47Z" })).toBe(
      "2026-06-07",
    );
    expect(roastDateLabel({ roasted_at_utc: null })).toBeNull();
    expect(roastDateLabel({ roasted_at_utc: "not-a-date" })).toBeNull();
    expect(roastDateLabel({ roasted_at_utc: "1780834787junk" })).toBeNull();
    expect(roastDateLabel({ roasted_at_utc: "123oops" })).toBeNull();
    expect(roastDateLabel({ roasted_at_utc: "2026-13-45" })).toBeNull();
  });

  it("leaves bounded labels unchanged and truncates longer labels deterministically", () => {
    expect(truncateLabel("Ethiopia Guji")).toBe("Ethiopia Guji");
    expect(truncateLabel("123456789 ", 5)).toBe("12345…");
    expect(truncateLabel("1234 6789", 5)).toBe("1234…");
  });

  it("truncates on grapheme boundaries without splitting emoji or combining marks", () => {
    const emojiLabel = `${"a".repeat(47)}😀more`;
    const combiningLabel = `${"a".repeat(47)}e\u0301more`;

    expect(truncateLabel(emojiLabel)).toBe(`${"a".repeat(47)}😀…`);
    expect(truncateLabel(combiningLabel)).toBe(`${"a".repeat(47)}é…`);
    expect(truncateLabel(emojiLabel)).not.toContain("�");
    expect(truncateLabel(combiningLabel)).not.toContain("�");
  });

  it("falls back to code-point truncation without splitting surrogate pairs", () => {
    const segmenter = Intl.Segmenter;
    Object.defineProperty(Intl, "Segmenter", {
      configurable: true,
      value: undefined,
    });

    try {
      const label = `${"a".repeat(47)}😀more`;
      expect(truncateLabel(label)).toBe(`${"a".repeat(47)}😀…`);
      expect(truncateLabel(label)).not.toContain("�");
    } finally {
      Object.defineProperty(Intl, "Segmenter", {
        configurable: true,
        value: segmenter,
      });
    }
  });
});
