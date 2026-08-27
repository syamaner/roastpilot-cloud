import { describe, expect, it } from "vitest";
import {
  clampTriageReadiness,
  validateTriageMode,
} from "../../scripts/factory/triage-mode.mts";
import type { ReadinessLabel } from "../../scripts/factory/triage-verdict-schema.mts";

describe("validateTriageMode", () => {
  it("accepts both exact trusted mode values", () => {
    expect(validateTriageMode("readiness")).toBe("readiness");
    expect(validateTriageMode("pre-filter")).toBe("pre-filter");
  });

  it.each([undefined, "", "readines", "PRE-FILTER", "ready-to-implement"])(
    "fails closed to pre-filter for %j",
    (raw) => {
      expect(validateTriageMode(raw)).toBe("pre-filter");
    },
  );
});

describe("clampTriageReadiness", () => {
  it.each([
    "ready-to-implement",
    "ready-for-conventional-implementation",
    "wait-to-implement",
  ] as const)("clamps pre-filter %s to ready-to-spec", (readiness) => {
    const result = clampTriageReadiness("pre-filter", readiness);

    expect(result).toEqual({
      effectiveReadiness: "ready-to-spec",
      clamped: true,
      clampNotice: expect.stringContaining(
        `readiness reduced from \`${readiness}\` to \`ready-to-spec\``,
      ),
    });
    expect(result.clampNotice).toContain(
      "A raw issue must be specced before it can authorize implementation.",
    );
    expect(result.clampNotice).not.toMatch(/[\u2019'\u2014]/u);
  });

  it.each([
    "ready-to-spec",
    "needs-info",
    "needs-triage",
    "wontfix",
  ] as const)("passes through pre-filter %s", (readiness) => {
    expect(clampTriageReadiness("pre-filter", readiness)).toEqual({
      effectiveReadiness: readiness,
      clamped: false,
      clampNotice: null,
    });
  });

  it.each([
    "ready-to-implement",
    "ready-for-conventional-implementation",
    "ready-to-spec",
    "needs-info",
    "needs-triage",
    "wait-to-implement",
    "wontfix",
  ] as const)("preserves readiness-mode label %s", (readiness) => {
    expect(clampTriageReadiness("readiness", readiness)).toEqual({
      effectiveReadiness: readiness as ReadinessLabel,
      clamped: false,
      clampNotice: null,
    });
  });

  it("keeps factory and conventional readiness distinct", () => {
    expect(
      clampTriageReadiness("readiness", "ready-to-implement")
        .effectiveReadiness,
    ).toBe("ready-to-implement");
    expect(
      clampTriageReadiness(
        "readiness",
        "ready-for-conventional-implementation",
      ).effectiveReadiness,
    ).toBe("ready-for-conventional-implementation");
  });
});
