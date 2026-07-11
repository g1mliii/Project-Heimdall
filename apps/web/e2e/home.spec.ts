import { expect, test } from "@playwright/test";

test("@visual throwaway page renders @heimdall/ui primitives on the dark canvas", async ({ page }) => {
  await page.goto("/");

  // Primitives mount and are interactive.
  await expect(page.getByRole("heading", { name: "Heimdall design system is wired" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Primary" })).toBeVisible();

  // Dark-first canvas: <body> paints with --bg-base (#0b0e14).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(11, 14, 20)");

  // Visual baseline for future design-fidelity diffs.
  await expect(page).toHaveScreenshot("home.png", { fullPage: true });
});
