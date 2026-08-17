import { describe, expect, it } from "vitest";
import {
  FACTORY_EVAL_ENABLED_VARIABLE,
  isEvalEnabled,
} from "../../scripts/factory/eval/eval-gating.mts";

describe("recorded evaluation gating", () => {
  it("T123 enables only the byte-exact true string", () => {
    expect(FACTORY_EVAL_ENABLED_VARIABLE).toBe("FACTORY_EVAL_ENABLED");
    expect(isEvalEnabled("true")).toBe(true);
    for (const value of [
      undefined,
      null,
      "",
      "TRUE",
      "True",
      " true",
      "true ",
      "1",
      "yes",
      "false",
      true,
      1,
      {},
      [],
    ]) {
      expect(isEvalEnabled(value), String(value)).toBe(false);
    }
  });
});
