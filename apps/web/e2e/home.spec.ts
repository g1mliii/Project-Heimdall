import { expect, test } from "@playwright/test";

test("@visual home page renders the upload CTA on the dark canvas", async ({ page }) => {
  await page.goto("/");

  // Hero + primary CTA render.
  await expect(
    page.getByRole("heading", { name: "Is your PC running this game well?" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Upload a benchmark log" })).toBeVisible();

  // Dark-first canvas: <body> paints with --bg-base (#0b0e14).
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(11, 14, 20)");

  // Visual baseline for future design-fidelity diffs.
  await expect(page).toHaveScreenshot("home.png", { fullPage: true });
});
