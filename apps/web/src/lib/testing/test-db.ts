/**
 * Shared Postgres harness for DB-touching test suites.
 *
 * Mirrors the db.test.ts policy: run against `TEST_DATABASE_URL` when set
 * (a DISPOSABLE database), otherwise an ephemeral Testcontainers instance
 * (needs Docker); locally with neither the suite skips loudly, in CI it FAILS —
 * DB coverage must never vanish silently from the gate.
 *
 * Vitest runs test files in parallel, so on the TEST_DATABASE_URL path each
 * suite gets its own uniquely-named schema (via search_path) instead of
 * fighting over `public`; on the Docker path each suite gets its own container.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../../../../../infra/db/migrate.mjs";

const testDbUrl = process.env.TEST_DATABASE_URL;

function dockerAvailable(): boolean {
  try {
    // Collection-time answer for describe.skipIf; short timeout so a wedged
    // daemon can't stall test collection for long.
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether DB suites can run at all; call once at module scope. */
export function testDbAvailable(label: string): boolean {
  const canRun = Boolean(testDbUrl) || dockerAvailable();
  if (!canRun) {
    if (process.env.CI) {
      throw new Error(
        `[${label}] no Postgres available in CI — provide Docker or TEST_DATABASE_URL; ` +
          "refusing to silently skip DB coverage.",
      );
    }
    console.warn(
      `[${label}] SKIPPED: no Postgres available — set TEST_DATABASE_URL to a disposable ` +
        "database or start Docker (Testcontainers).",
    );
  }
  return canRun;
}

export interface TestDb {
  pool: pg.Pool;
  /** Migrations applied while creating this fresh database or schema. */
  appliedMigrations: string[];
  /**
   * URL other code (e.g. route handlers using the default app pool) can use
   * to reach this same database/schema — encodes the search_path when the
   * suite runs on the shared TEST_DATABASE_URL server.
   */
  connectionString: string;
  teardown(): Promise<void>;
}

/** Fresh, fully-migrated database (or schema) for one test suite. */
export async function createTestDb(): Promise<TestDb> {
  if (testDbUrl) {
    const schema = `heimdall_test_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Pool({ connectionString: testDbUrl, max: 1 });
    let pool: pg.Pool | undefined;
    try {
      await admin.query(`create schema "${schema}"`);
      const testPool = new pg.Pool({
        connectionString: testDbUrl,
        max: 2,
        options: `-csearch_path=${schema},public`,
      });
      pool = testPool;
      const appliedMigrations = await migrate(testPool);
      const separator = testDbUrl.includes("?") ? "&" : "?";
      const connectionString = `${testDbUrl}${separator}options=${encodeURIComponent(`-csearch_path=${schema},public`)}`;
      return {
        pool: testPool,
        appliedMigrations,
        connectionString,
        teardown: async () => {
          await testPool.end();
          await admin.query(`drop schema "${schema}" cascade`);
          await admin.end();
        },
      };
    } catch (error) {
      await pool?.end();
      await admin.query(`drop schema if exists "${schema}" cascade`).catch(() => undefined);
      await admin.end();
      throw error;
    }
  }

  const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
  try {
    const appliedMigrations = await migrate(pool);
    return {
      pool,
      appliedMigrations,
      connectionString: container.getConnectionUri(),
      teardown: async () => {
        await pool.end();
        await container.stop();
      },
    };
  } catch (error) {
    await pool.end();
    await container.stop();
    throw error;
  }
}
