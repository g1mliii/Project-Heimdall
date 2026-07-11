import { expect, test, type Route } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/parsers/fixtures",
);

function fulfillR2Cors(route: Route) {
  return route.fulfill({
    status: route.request().method() === "OPTIONS" ? 204 : 200,
    headers: {
      "access-control-allow-origin": "http://localhost:3000",
      "access-control-allow-methods": "PUT, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}

test("@visual upload page renders the ingest flow (idle state)", async ({ page }) => {
  await page.goto("/upload");

  await expect(page.getByRole("heading", { name: "Upload a benchmark log" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Upload benchmark logs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Unlisted" })).toBeVisible();
  await expect(page.getByText("Link only — excluded from public averages.")).toBeVisible();

  // Visual baseline for design-fidelity diffs (matches ui_kits/web/extras.jsx).
  await expect(page).toHaveScreenshot("upload-idle.png", { fullPage: true });
});

test("client-side parse rejects a malformed log without any API round trip (12.1)", async ({
  page,
}) => {
  // The engine must fail BEFORE any network call — block /api to prove it.
  let apiCalls = 0;
  await page.route("**/api/**", (route) => {
    apiCalls += 1;
    return route.abort();
  });

  await page.goto("/upload");
  await page.getByRole("textbox", { name: "Game" }).fill("Cyberpunk 2077");
  await page
    .locator('input[type="file"]')
    .setInputFiles(path.join(FIXTURES, "malformed", "binary-garbage.bin"));

  await expect(page.getByText(/Could not ingest/)).toBeVisible();
  expect(apiCalls).toBe(0);
});

test("single-file upload flow reaches done with mocked ingest APIs", async ({ page }) => {
  await page.route("**/api/runs", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "run_e2e_0001",
        uploadUrl: "https://r2.invalid/put",
        uploadObjectKey: "staging/runs/run_e2e_0001.parquet",
      }),
    }),
  );
  await page.route("https://r2.invalid/put", fulfillR2Cors);
  await page.route("**/api/runs/run_e2e_0001/finalize", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "run_e2e_0001", status: "pending" }),
    }),
  );

  await page.goto("/upload");
  await page.getByRole("textbox", { name: "Game" }).fill("Cyberpunk 2077");
  await page
    .locator('input[type="file"]')
    .setInputFiles(path.join(FIXTURES, "capframex", "csv", "nvidia-full-sensors.csv"));

  await expect(page.getByText(/Uploaded — /)).toBeVisible();
  await expect(page.getByText("Save your delete token — it's shown once")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to benchmarks" })).toHaveAttribute("href", "/");
});

test("ambiguous finalize failures keep the delete token visible", async ({ page }) => {
  await page.route("**/api/runs", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: "run_e2e_recovery",
        uploadUrl: "https://r2.invalid/recovery-put",
        uploadObjectKey: "staging/runs/run_e2e_recovery.parquet",
      }),
    }),
  );
  await page.route("https://r2.invalid/recovery-put", fulfillR2Cors);
  await page.route("**/api/runs/run_e2e_recovery/finalize", (route) =>
    route.abort("connectionreset"),
  );

  await page.goto("/upload");
  await page.getByRole("textbox", { name: "Game" }).fill("Cyberpunk 2077");
  await page
    .locator('input[type="file"]')
    .setInputFiles(path.join(FIXTURES, "capframex", "csv", "nvidia-full-sensors.csv"));

  await expect(page.getByText("Finalization may have completed.")).toBeVisible();
  await expect(page.getByText("/runs/run_e2e_recovery")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Recovery delete token" })).not.toHaveValue("");
});

test("batch upload: per-file status, one bad file never blocks the rest (§11.8)", async ({
  page,
}) => {
  let created = 0;
  await page.route("**/api/runs", (route) => {
    created += 1;
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        id: `run_e2e_b${created}`,
        uploadUrl: `https://r2.invalid/put/${created}`,
        uploadObjectKey: `staging/runs/run_e2e_b${created}.parquet`,
      }),
    });
  });
  await page.route("https://r2.invalid/put/**", fulfillR2Cors);
  await page.route("**/api/runs/*/finalize", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "x", status: "pending" }),
    }),
  );

  await page.goto("/upload");
  await page.getByRole("textbox", { name: "Game" }).fill("Cyberpunk 2077");
  await page.locator('input[type="file"]').setInputFiles([
    path.join(FIXTURES, "capframex", "csv", "nvidia-full-sensors.csv"),
    path.join(FIXTURES, "malformed", "binary-garbage.bin"),
    path.join(FIXTURES, "presentmon", "v2-basic.csv"),
  ]);

  await expect(page.getByText("Batch progress")).toBeVisible();
  await expect(page.getByText("2 / 3 done")).toBeVisible();
  await expect(page.getByText("One bad file never blocks the rest — each succeeds or fails on its own.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save delete tokens (.txt)" })).toBeVisible();
});
