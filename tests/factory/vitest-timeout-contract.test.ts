import { expect, it } from "vitest";

import config from "../../vitest.config.ts";

it("keeps the global Vitest timeout contract", () => {
  expect(config.test).toBeDefined();
  expect(config.test?.testTimeout).toBe(20_000);
  expect(config.test?.hookTimeout).toBe(20_000);
});
