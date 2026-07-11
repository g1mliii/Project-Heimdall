/**
 * Boots a disposable Postgres for the e2e suite (needs Docker — same
 * dependency as the vitest DB tests), migrates it, and seeds the fixture
 * run the /runs/[id] page server-renders. The container binds the fixed
 * host port from env.ts so the dev server's static DATABASE_URL reaches it.
 */

import pg from "pg";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate } from "../../../infra/db/migrate.mjs";
import { insertRun } from "../src/lib/db";
import { E2E_DB_HOST_PORT } from "./env";
import { e2eFixtureRun } from "./run-fixture";

export default async function globalSetup() {
  const container = await new PostgreSqlContainer("postgres:17-alpine")
    .withExposedPorts({ container: 5432, host: E2E_DB_HOST_PORT })
    .start();

  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  try {
    await migrate(pool);
    await insertRun(e2eFixtureRun, pool);
  } finally {
    await pool.end();
  }

  return async () => {
    await container.stop();
  };
}
