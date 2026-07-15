/**
 * Run-page e2e (§13 Verify + §14.2): the seeded fixture run server-renders;
 * the browser-side frames flow (signed-URL JSON + parquet bytes) is mocked
 * with page.route, exercising the REAL client path — typed client → fetch →
 * hyparquet decode → chart. Contexts carry no auth state, which is exactly
 * the "share link works unauthenticated" claim.
 */

import { expect, test, type Page, type Route } from "@playwright/test";
import {
  E2E_BENCHMARK_SET_RUN_ID,
  E2E_RUN_ID,
  E2E_VRAM_RUN_ID,
  e2eDiagnostics,
  e2eFixtureRun,
  e2eParquetBytes,
  e2eVramDiagnostics,
  e2eVramFrames,
} from "./run-fixture";

const RUN_URL = `/runs/${E2E_RUN_ID}`;
const VRAM_RUN_URL = `/runs/${E2E_VRAM_RUN_ID}`;
const BENCHMARK_SET_RUN_URL = `/runs/${E2E_BENCHMARK_SET_RUN_ID}`;
const FRAMES_OBJECT_URL = "https://r2.invalid/frames.parquet";

const R2_CORS = { "access-control-allow-origin": "http://localhost:3000" };

async function mockFramesFlow(
  page: Page,
  runId = E2E_RUN_ID,
  getParquet = e2eParquetBytes,
) {
  await page.route(`**/api/runs/${runId}/frames`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: FRAMES_OBJECT_URL, expiresInSeconds: 300 }),
    }),
  );
  const parquet = await getParquet();
  await page.route(FRAMES_OBJECT_URL, (route: Route) =>
    route.fulfill({
      status: 200,
      body: parquet,
      contentType: "application/octet-stream",
      headers: R2_CORS,
    }),
  );
}

const chart = (page: Page) => page.locator("[data-chart-state]");
const readyChart = (page: Page) =>
  expect(chart(page)).toHaveAttribute("data-chart-state", "ready", { timeout: 20_000 });

test("fixture run renders: badges, tiles, confidence, chart, stubs (§13)", async ({ page }) => {
  await mockFramesFlow(page);
  await page.goto(RUN_URL);

  // Title block: game + status/tech/visibility badges.
  await expect(page.getByRole("heading", { name: e2eFixtureRun.game })).toBeVisible();
  await expect(page.getByText("Validated")).toBeVisible();
  await expect(page.getByText("DLSS 3")).toBeVisible();
  await expect(page.getByText("Public")).toBeVisible();

  // Tier tiles show the computed summary; generated tile is fraction ×100.
  const { summary } = e2eFixtureRun;
  await expect(page.getByText(summary.avgFps.toFixed(1)).first()).toBeVisible();
  await expect(page.getByText(summary.onePercentLowFps.toFixed(1)).first()).toBeVisible();
  await expect(
    page.getByText(String(Math.round(summary.generatedFramePct * 100)), { exact: true }),
  ).toBeVisible();

  // 0.1%-low confidence pill (7200 frames → high).
  await expect(page.getByText("high", { exact: true })).toBeVisible();

  // Chart paints for real (canvas ready flag) with axis labels in the DOM.
  await readyChart(page);
  await expect(page.locator('[data-axis="x"]').first()).toBeVisible();

  // Coming-soon stubs are visible but disabled — no dead buttons (§13.6).
  await expect(page.getByRole("button", { name: /Compare/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Export video/ })).toBeDisabled();

  // Hardware panel: RAM warn row + frame-derived sensor aggregates.
  await expect(page.getByText("4800 / 6000 MT/s")).toBeVisible();
  await expect(page.getByText("Avg GPU load")).toBeVisible();
  await expect(page.getByText("Peak VRAM")).toBeVisible();

  // The card counts actionable warn/bad findings, while retaining informational
  // driver-currency context in the rendered diagnostic list.
  const issueCount = e2eDiagnostics.filter(
    (diagnostic) => diagnostic.severity === "warn" || diagnostic.severity === "bad",
  ).length;
  await expect(page.getByText(`${issueCount} issue${issueCount === 1 ? "" : "s"}`)).toBeVisible();
  await expect(page.getByText("RAM is running below its rated speed")).toBeVisible();
  await expect(page.getByText("GPU driver is older than recommended")).toBeVisible();
  await expect(page.getByText("GPU driver update available")).toBeVisible();
  await expect(page.getByText("Coming soon")).toHaveCount(0);
});

test("VRAM-stutter fixture surfaces its warning on the run page (§15.1, §16)", async ({ page }) => {
  await mockFramesFlow(page, E2E_VRAM_RUN_ID, () => e2eParquetBytes(e2eVramFrames));
  await page.goto(VRAM_RUN_URL);
  await readyChart(page);

  await expect(page.getByText("VRAM saturation is causing stutters")).toBeVisible();
  await expect(
    page.getByText("Lower texture quality or resolution to free up VRAM headroom."),
  ).toBeVisible();
  await expect(page.getByText(`${e2eVramDiagnostics.length} issue`)).toBeVisible();
});

test("public benchmark sets show repeatability without promoting warm-ups (§16c.2)", async ({ page }) => {
  await mockFramesFlow(page, E2E_BENCHMARK_SET_RUN_ID);
  await page.goto(BENCHMARK_SET_RUN_URL);

  await expect(page.getByLabel("Benchmark set repeatability")).toBeVisible();
  await expect(page.getByText("3 measured runs · 1 warm-up pass excluded")).toBeVisible();
  await expect(page.getByText("High confidence")).toBeVisible();
  await expect(page.getByText("Mean avg FPS")).toBeVisible();
  await expect(page.getByText("Relative variation (CV)")).toBeVisible();
});

test("ms/FPS toggle re-labels the y axis through the same scale (§13.1)", async ({ page }) => {
  await mockFramesFlow(page);
  await page.goto(RUN_URL);
  await readyChart(page);

  const yLabels = page.locator('[data-axis="y"]');
  const msTicks = (await yLabels.allTextContents()).join(",");

  await page.getByRole("button", { name: "FPS" }).click();
  await expect(async () => {
    expect((await yLabels.allTextContents()).join(",")).not.toBe(msTicks);
  }).toPass();
  // ~120 FPS capture: the FPS axis reaches triple digits; the ms axis never did.
  expect((await yLabels.allTextContents()).some((t) => Number(t) >= 100)).toBe(true);
});

test("wheel zoom over the plot narrows the x-axis window (§13.1)", async ({ page }) => {
  await mockFramesFlow(page);
  await page.goto(RUN_URL);
  await readyChart(page);

  const xLabels = page.locator('[data-axis="x"]');
  const before = (await xLabels.allTextContents()).join(",");

  const overlay = page.locator("[data-chart-overlay]");
  const box = await overlay.boundingBox();
  if (!box) throw new Error("chart overlay has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -600);

  await expect(async () => {
    expect((await xLabels.allTextContents()).join(",")).not.toBe(before);
  }).toPass();
});

test("share copies the run URL and confirms (§13.6)", async ({ page, context, baseURL }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockFramesFlow(page);
  await page.goto(RUN_URL);

  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("button", { name: "Link copied" })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`${baseURL}${RUN_URL}`);
});

test("not-finalized frames show the processing state, tiles intact (§13.5)", async ({ page }) => {
  await page.route(`**/api/runs/${E2E_RUN_ID}/frames`, (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "not-finalized", message: "run has no uploaded frames yet" },
      }),
    }),
  );
  await page.goto(RUN_URL);

  await expect(page.getByText("Frames still processing")).toBeVisible();
  await expect(page.getByText(e2eFixtureRun.summary.avgFps.toFixed(1)).first()).toBeVisible();
});

test("frames failure shows the error state and Retry recovers (§13.5)", async ({ page }) => {
  let framesCalls = 0;
  await page.route(`**/api/runs/${E2E_RUN_ID}/frames`, async (route) => {
    framesCalls += 1;
    if (framesCalls === 1) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal", message: "frames url failed" } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: FRAMES_OBJECT_URL, expiresInSeconds: 300 }),
    });
  });
  const parquet = await e2eParquetBytes();
  await page.route(FRAMES_OBJECT_URL, (route) =>
    route.fulfill({ status: 200, body: parquet, headers: R2_CORS }),
  );

  await page.goto(RUN_URL);
  await expect(page.getByText("Could not load frame data")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await readyChart(page);
});

test("missing/hidden runs 404 with the generic not-found page (§13.5)", async ({ page }) => {
  await page.goto("/runs/run_does_not_exist");
  await expect(page.getByRole("heading", { name: "Run not found" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Upload a benchmark log" })).toBeVisible();
});

test("small screens reflow without horizontal overflow (§13)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await mockFramesFlow(page);
  await page.goto(RUN_URL);
  await readyChart(page);

  await expect(page.locator("nav[aria-label='Primary navigation']")).toBeHidden();
  await expect(page.getByRole("link", { name: "Heimdall home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Upload log" })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBe(true);
});

test("@visual run page matches the design reference layout", async ({ page }) => {
  await mockFramesFlow(page);
  await page.goto(RUN_URL);
  await readyChart(page);
  await page.evaluate(() => document.fonts.ready);

  // Baseline is eyeballed against design/ui_kits/web/RunPage.jsx. The
  // diagnostics card now renders the real Phase 6 findings; regenerate this
  // baseline with `playwright test --update-snapshots` (needs Docker for the
  // e2e Postgres) whenever the fixture's findings change.
  await expect(page).toHaveScreenshot("run-page.png", { fullPage: true });
});
