/**
 * Boots a disposable Postgres for the e2e suite (needs Docker — same
 * dependency as the vitest DB tests), migrates it, and seeds the fixture
 * run the /runs/[id] page server-renders. The container binds the fixed
 * host port from env.ts so the dev server's static DATABASE_URL reaches it.
 */

import pg from "pg";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { hashManagementToken } from "@heimdall/shared";
import { migrate } from "../../../infra/db/migrate.mjs";
import { insertDiagnostics, insertRun } from "../src/lib/db";
import { resolveGameId, resolveHardwareId } from "../src/lib/repo/catalog";
import { E2E_DB_HOST_PORT } from "./env";
import {
  e2eBenchmarkSetFixtureRun,
  e2eBenchmarkSetPeerRuns,
  E2E_BENCHMARK_SET_ID,
  E2E_BENCHMARK_SET_SECRET,
  e2eDiagnostics,
  e2eFixtureRun,
  e2eVramDiagnostics,
  e2eVramFixtureRun,
} from "./run-fixture";

export default async function globalSetup() {
  const container = await new PostgreSqlContainer("postgres:17-alpine")
    .withExposedPorts({ container: 5432, host: E2E_DB_HOST_PORT })
    .start();

  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  let setupComplete = false;
  try {
    await migrate(pool);
    await insertRun(e2eFixtureRun, pool);
    // Diagnostics are written by the verification worker in production; seed the
    // same engine output here so the SSR run page renders real findings.
    await insertDiagnostics(e2eFixtureRun.id, e2eDiagnostics, pool);
    await insertRun(e2eVramFixtureRun, pool);
    await insertDiagnostics(e2eVramFixtureRun.id, e2eVramDiagnostics, pool);
    const benchmarkSetSecretHash = await hashManagementToken(E2E_BENCHMARK_SET_SECRET);
    const gameId = await resolveGameId(
      e2eBenchmarkSetFixtureRun.captureSource,
      e2eBenchmarkSetFixtureRun.game,
      pool,
    );
    const gpuId = await resolveHardwareId(
      "gpu",
      e2eBenchmarkSetFixtureRun.captureSource,
      e2eBenchmarkSetFixtureRun.hardware.gpu,
      e2eBenchmarkSetFixtureRun.hardware.gpuVendor ?? null,
      pool,
    );
    if (!gameId || !gpuId) throw new Error("could not resolve benchmark e2e fixture ids");
    const canonicalizeBenchmarkRun = (run: typeof e2eBenchmarkSetFixtureRun) => ({
      ...run,
      hardware: { ...run.hardware, canonicalGpuId: gpuId },
    });
    await insertRun(canonicalizeBenchmarkRun(e2eBenchmarkSetFixtureRun), pool, {
      benchmarkSetSecretHash,
    });
    await Promise.all(
      e2eBenchmarkSetPeerRuns.map((run) =>
        insertRun(canonicalizeBenchmarkRun(run), pool, { benchmarkSetSecretHash }),
      ),
    );
    await pool.query("update runs set game_id = $1 where benchmark_set_id = $2", [
      gameId,
      E2E_BENCHMARK_SET_ID,
    ]);
    setupComplete = true;
  } finally {
    await pool.end();
    if (!setupComplete) await container.stop();
  }

  return async () => {
    await container.stop();
  };
}
