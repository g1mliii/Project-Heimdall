/**
 * Account e2e (§20 regression checklist): sign in with a real Clerk dev
 * instance, upload a run as private, confirm it's listed correctly on
 * /account, toggle it public, wait for server-side verification, and confirm
 * it appears on its game page once public + validated. Skips cleanly when
 * Clerk isn't configured (`CLERK_SECRET_KEY` unset) — this spec is the only
 * one in the suite that needs a real external Clerk instance.
 *
 * Runs against the SAME disposable Postgres every other e2e spec uses
 * (global-setup.ts) and REAL R2 (this file does not mock storage) — the
 * whole point is proving the real upload → finalize → verify-worker →
 * visibility-toggle → game-page pipeline works end to end for a signed-in
 * owner, which no other spec in this suite exercises live.
 */

import { expect, test } from "@playwright/test";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup } from "@clerk/testing/playwright";
import { slugifyGameName } from "@heimdall/shared";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "../../../packages/parsers/fixtures/capframex/csv/nvidia-full-sensors.csv");

/**
 * Next's dev server (the webServer subprocess) loads apps/web/.env.local
 * automatically; this Playwright spec runs as a separate Node process that
 * does not. Load it ourselves so `CLERK_SECRET_KEY` etc. reach `clerkSetup()`
 * and the Clerk Backend API calls below.
 */
const ENV_LOCAL = path.resolve(HERE, "../.env.local");
if (existsSync(ENV_LOCAL)) {
  process.loadEnvFile(ENV_LOCAL);
}

const CLERK_CONFIGURED = Boolean(
  process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
);

test.describe("account (§20 sign-in + ownership)", () => {
  test.skip(!CLERK_CONFIGURED, "CLERK_SECRET_KEY not set — needs a real Clerk dev instance");

  let userId: string | undefined;
  let userEmail: string;

  test.beforeAll(async () => {
    await clerkSetup();
    const backend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
    userEmail = `heimdall-e2e-${Date.now()}+clerk_test@example.com`;
    const user = await backend.users.createUser({
      emailAddress: [userEmail],
      password: `E2e-${Date.now()}-Test-Passw0rd!`,
      skipPasswordChecks: true,
    });
    userId = user.id;
  });

  test.afterAll(async () => {
    if (!userId) return;
    const backend = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
    await backend.users.deleteUser(userId).catch(() => {});
  });

  test("sign in → upload private → toggle public → appears on game page after validation", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const gameName = `Account E2E ${Date.now()}`;

    await page.goto("/");
    await clerk.signIn({ page, emailAddress: userEmail });
    await page.goto("/");
    await expect(page.getByRole("link", { name: "My runs" })).toBeVisible();

    // Upload as Private — only offered once Clerk confirms a session.
    await page.goto("/upload");
    await page.getByRole("textbox", { name: "Game" }).fill(gameName);
    await page.getByRole("button", { name: "Private" }).click();
    await page.locator('input[type="file"]').setInputFiles(FIXTURE);

    const viewRunLink = page.getByRole("link", { name: "View run" });
    await expect(viewRunLink).toBeVisible({ timeout: 15_000 });
    const runHref = await viewRunLink.getAttribute("href");
    const runId = runHref?.split("/").filter(Boolean).pop();
    if (!runId) throw new Error("could not read the uploaded run id from the View run link");

    // /account: the run is listed, Private selected.
    await page.goto("/account");
    const visibilitySelect = page.getByRole("combobox", { name: `Visibility for ${gameName}` });
    await expect(visibilitySelect).toHaveValue("private");

    // Toggle to public.
    await visibilitySelect.selectOption("public");
    await expect(visibilitySelect).toHaveValue("public");

    // Server-side verification runs via finalize's best-effort drain kick,
    // in-process in the same dev server — generous timeout, not instant.
    await page.goto(`/runs/${runId}`);
    await expect(page.getByText("Validated")).toBeVisible({ timeout: 30_000 });

    // Public + validated: now shows up on its game page.
    const gameSlug = slugifyGameName(gameName);
    await page.goto(`/games/${gameSlug}`);
    await expect(page.getByRole("heading", { name: gameName })).toBeVisible();
    await expect(page.getByText("93.5").first()).toBeVisible();

    // Cleanup: delete the run via the account page.
    await page.goto("/account");
    await page.getByRole("button", { name: `Delete ${gameName}` }).click();
    await expect(page.getByRole("combobox", { name: `Visibility for ${gameName}` })).toHaveCount(0);
  });
});
