import { defineConfig, devices } from "@playwright/test";

// Visual-snapshot harness (IMPLEMENTATION_PLAN §3a.4). Phase 1 establishes it
// against the throwaway page; Phases 5/7 diff their screens vs design/ui_kits.
export default defineConfig({
  testDir: "./e2e",
  snapshotDir: "./e2e/__screenshots__",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  expect: {
    // Allow a little antialiasing/font-rendering drift across machines.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // CI has already run the production build, so reuse it for browser tests.
    command: process.env.CI
      ? "pnpm --dir ../.. --filter @heimdall/web start"
      : "pnpm --dir ../.. dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
