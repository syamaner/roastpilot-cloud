import { describe, expect, it } from "vitest";
import {
  formatCelsius,
  formatPercent,
  formatReviewerName,
  formatSeconds,
} from "../lib/format";

describe("public roast formatters", () => {
  it("formats roast durations and percentages", () => {
    expect(formatSeconds(637.106)).toBe("10:37");
    expect(formatPercent(15.003)).toBe("15.0 %");
    expect(formatPercent(0)).toBe("0.0 %");
    expect(formatPercent(100)).toBe("100.0 %");
  });

  it("formats null, zero, and measured Celsius values without conversion", () => {
    expect(formatCelsius(null)).toBe("—");
    expect(formatCelsius(Number.NaN)).toBe("—");
    expect(formatCelsius(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatCelsius(Number.NEGATIVE_INFINITY)).toBe("—");
    expect(formatCelsius(0)).toBe("0.0 °C");
    expect(formatCelsius(201.5)).toBe("201.5 °C");
  });

  it("formats anonymous and first-token reviewer names", () => {
    expect(formatReviewerName(null)).toBe("Anonymous");
    expect(formatReviewerName("")).toBe("Anonymous");
    expect(formatReviewerName("   \t ")).toBe("Anonymous");
    expect(formatReviewerName("  Jane   Smith ")).toBe("Jane");
    expect(formatReviewerName("Ari")).toBe("Ari");
  });
});
