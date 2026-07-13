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
import { E2E_DB_HOST_PORT } from "./env";
import {
  e2eBenchmarkSetFixtureRun,
  e2eBenchmarkSetPeerRuns,
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
    await insertRun(e2eBenchmarkSetFixtureRun, pool, { benchmarkSetSecretHash });
    await Promise.all(
      e2eBenchmarkSetPeerRuns.map((run) => insertRun(run, pool, { benchmarkSetSecretHash })),
    );
    setupComplete = true;
  } finally {
    await pool.end();
    if (!setupComplete) await container.stop();
  }

  return async () => {
    await container.stop();
  };
}
