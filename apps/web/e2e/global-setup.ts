/**
 * Boots a disposable Postgres for the e2e suite (needs Docker — same
 * dependency as the vitest DB tests), migrates it, and seeds the fixture
 * run the /runs/[id] page server-renders. The container binds the fixed
 * host port from env.ts so the dev server's static DATABASE_URL reaches it.
 */

import pg from "pg";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { FRAME_ANALYSIS_VERSION, hashManagementToken } from "@heimdall/shared";
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
  e2ePresentTimeProfile,
  e2eRenderedFrameAnalysis,
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
    // §22.12: same story, but `insertRun` deliberately never writes these — the
    // verify worker owns them because there is no client contract for a rendered
    // summary. Seed them directly so the run page gets a real rate toggle.
    await pool.query(
      `update runs
          set rendered_frame_analysis = $2::jsonb,
              present_time_profile = $3::jsonb,
              frame_analysis_version = $4
        where id = $1`,
      [
        e2eFixtureRun.id,
        JSON.stringify(e2eRenderedFrameAnalysis),
        JSON.stringify(e2ePresentTimeProfile),
        FRAME_ANALYSIS_VERSION,
      ],
    );
    await insertRun(e2eVramFixtureRun, pool);
    await insertDiagnostics(e2eVramFixtureRun.id, e2eVramDiagnostics, pool);
    const benchmarkSetSecretHash = await hashManagementToken(E2E_BENCHMARK_SET_SECRET);
    const [gameId, gpuId, cpuId] = await Promise.all([
      resolveGameId(
        e2eBenchmarkSetFixtureRun.captureSource,
        e2eBenchmarkSetFixtureRun.game,
        pool,
      ),
      resolveHardwareId(
        "gpu",
        e2eBenchmarkSetFixtureRun.captureSource,
        e2eBenchmarkSetFixtureRun.hardware.gpu,
        e2eBenchmarkSetFixtureRun.hardware.gpuVendor ?? null,
        pool,
      ),
      resolveHardwareId(
        "cpu",
        e2eBenchmarkSetFixtureRun.captureSource,
        e2eBenchmarkSetFixtureRun.hardware.cpu,
        null,
        pool,
      ),
    ]);
    if (!gameId || !gpuId || !cpuId) {
      throw new Error("could not resolve benchmark e2e fixture ids");
    }
    // The ordinary run is intentionally legacy/unprofiled. Resolve it onto the
    // same public game so the game page proves that older submissions remain
    // individually visible without entering a pooled cohort.
    await pool.query(
      "update runs set game_id = $1, gpu_hardware_id = $2, cpu_hardware_id = $3 where id = $4",
      [gameId, gpuId, cpuId, e2eFixtureRun.id],
    );
    await pool.query(
      `insert into hardware_aliases (
         hardware_id, kind, source, raw_name, normalized_name
       ) values ($1, 'gpu', 'e2e-short', '4070', '4070')
       on conflict (source, normalized_name, kind) do nothing`,
      [gpuId],
    );
    const canonicalizeBenchmarkRun = (run: typeof e2eBenchmarkSetFixtureRun) => ({
      ...run,
      hardware: { ...run.hardware, canonicalGpuId: gpuId, canonicalCpuId: cpuId },
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
