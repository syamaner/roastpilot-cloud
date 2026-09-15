import { expect, test } from "@playwright/test";

const requiredSnowflakeEnvironment = [
  "SNOWFLAKE_WEB_ACCOUNT",
  "SNOWFLAKE_WEB_USER",
  "SNOWFLAKE_WEB_PRIVATE_KEY",
  "SNOWFLAKE_WEB_WAREHOUSE",
] as const;
const hasSnowflakeEnvironment = requiredSnowflakeEnvironment.every(
  (name) => process.env[name] !== undefined && process.env[name]?.trim() !== "",
);
const hasPreviewBaseURL = process.env.PLAYWRIGHT_BASE_URL?.trim() !== "" &&
  process.env.PLAYWRIGHT_BASE_URL !== undefined;

test.describe("mobile layout shell", () => {
  test.skip(
    !hasPreviewBaseURL && !hasSnowflakeEnvironment,
    "requires a configured preview or local SNOWFLAKE_WEB_* credentials",
  );

  test.use({ viewport: { width: 375, height: 812 } });

  test("T-8 keeps the public roast page within the viewport", async ({ page }) => {
    const response = await page.goto("/r/demoroastseedone234");

    expect(response?.ok()).toBe(true);
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
  });
});
