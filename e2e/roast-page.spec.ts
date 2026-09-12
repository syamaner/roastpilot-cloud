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

test.describe("public roast page", () => {
  test.skip(
    !hasPreviewBaseURL && !hasSnowflakeEnvironment,
    "requires a configured preview or local SNOWFLAKE_WEB_* credentials",
  );

  test("renders the seeded public roast", async ({ page }) => {
    const response = await page.goto("/r/demoroastseedone234");

    expect(response?.ok()).toBe(true);
    await expect(page.getByText("Total roast time")).toBeVisible();
    await expect(page.getByText("First crack temp")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/°\s*F/);
  });

  test("returns the segment 404 for an unknown roast", async ({ page }) => {
    const response = await page.goto("/r/unknownroastseed123");

    expect(response?.status()).toBe(404);
    await expect(page.getByText("Not found", { exact: true })).toBeVisible();
  });
});
