import { describe, expect, it } from "vitest";
import {
  assertNonProdTarget,
  ProdGuardError,
} from "../scripts/seed/prod-guard";

describe("assertNonProdTarget", () => {
  it.each([
    "ROASTPILOT",
    undefined,
    "",
    "   ",
    "ROASTPILOT_PROD",
    '"ROASTPILOT"',
    "ROASTPILOT\n",
    "  roastpilot  ",
  ])("rejects non-allowlisted target %j with ProdGuardError", (target) => {
    expect(() => assertNonProdTarget(target)).toThrow(ProdGuardError);
    try {
      assertNonProdTarget(target);
    } catch (error) {
      expect(error).toBeInstanceOf(ProdGuardError);
      expect(error).toHaveProperty("name", "ProdGuardError");
    }
  });

  it.each([
    ["ROASTPILOT_PREVIEW", "ROASTPILOT_PREVIEW"],
    ["roastpilot_preview", "ROASTPILOT_PREVIEW"],
    ["ROASTPILOT_DEV ", "ROASTPILOT_DEV"],
  ])("normalises and returns allowed target %s", (target, expected) => {
    expect(assertNonProdTarget(target)).toBe(expected);
  });
});
