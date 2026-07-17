import { expect, test } from "@playwright/test";

test("dev server boots and renders the placeholder page", async ({
  page,
}) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "RoastPilot Cloud" }),
  ).toBeVisible();
});
