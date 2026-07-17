/**
 * Phase 7.0 discovery proof: real Postgres search → top-bar typeahead → SSR
 * game page → individual submissions. No run API is mocked in this spec.
 */

import { expect, test } from "@playwright/test";

import {
  E2E_GAME_LEGACY_RUN_ID,
  E2E_GAME_NAME,
  E2E_GAME_URL,
  E2E_HARDWARE_ALIAS,
} from "./game-fixture";

test("search opens the game page with honest individual-run states (§17a.1)", async ({ page }) => {
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Search games and hardware" });
  await search.fill("Cyberpunk");

  const gameOption = page.getByRole("option").filter({ hasText: E2E_GAME_NAME }).first();
  await expect(gameOption).toBeVisible();
  await gameOption.click();
  await expect(page).toHaveURL(E2E_GAME_URL);

  await expect(page.getByRole("heading", { level: 1, name: E2E_GAME_NAME })).toBeVisible();
  await expect(page.getByRole("table", { name: /Individual public and validated/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "NVIDIA GeForce RTX 4070" }).first()).toHaveAttribute(
    "href",
    `/runs/${E2E_GAME_LEGACY_RUN_ID}`,
  );
  await expect(page.getByText("Profile incomplete")).toBeVisible();
  await expect(page.getByText("Warm-up")).toBeVisible();
  await expect(page.getByText("Set member").first()).toBeVisible();
  await expect(page.getByText("Driver below game minimum").first()).toBeVisible();
  await expect(page.getByText("Insufficient comparable data")).toBeVisible();
  await expect(page.locator("svg[data-chart], canvas")).toHaveCount(0);

  await page.getByRole("button", { name: "Submitted" }).click();
  await expect(page).toHaveURL(/sortDirection=asc/);

  await page.getByRole("button", { name: "Gameplay" }).click();
  await expect(page).toHaveURL(/sceneType=gameplay/);
  await expect(page.getByText("0 shown")).toBeVisible();
  await expect(page.getByText("No public, validated submissions match this view yet.")).toBeVisible();
});

test("GPU alias search is clearly non-navigating context (§17.6)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Search games and hardware" }).fill(E2E_HARDWARE_ALIAS);

  const hardware = page.getByRole("group", { name: "Hardware" });
  await expect(hardware.getByText("NVIDIA GeForce RTX 4070")).toBeVisible();
  await expect(hardware.getByRole("link")).toHaveCount(0);
  await expect(hardware.getByRole("option")).toHaveCount(0);
  await expect(
    hardware.getByText("Hardware pages are coming — search a game to see its runs."),
  ).toBeVisible();
});

test("@visual game page matches the Phase 7.0 design boundary", async ({ page }) => {
  await page.goto(E2E_GAME_URL);
  await expect(page.getByRole("heading", { level: 1, name: E2E_GAME_NAME })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot("game-page.png", { fullPage: true });
});
