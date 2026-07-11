/**
 * Minimal idempotent migration runner (IMPLEMENTATION_PLAN §4.3).
 *
 * Applies `migrations/*.sql` in lexical order, tracking applied files in a
 * `schema_migrations` table — re-running is a no-op. Each file runs inside its
 * own transaction; a session advisory lock serializes concurrent runners (two
 * CI jobs against the same Neon branch won't race).
 *
 * CLI:   DATABASE_URL=postgres://… pnpm migrate
 * Tests: import { migrate } and pass a pg.Pool.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Arbitrary but fixed app-wide key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 0x4865696d; // "Heim"

/**
 * Run all pending migrations. Returns the filenames applied by THIS invocation
 * (empty array = everything was already applied), so callers can assert
 * idempotence.
 *
 * @param {pg.Pool} pool
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {Promise<string[]>}
 */
export async function migrate(pool, { log = () => {} } = {}) {
  const client = await pool.connect();
  const applied = [];
  let broken = false;
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`
      create table if not exists schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query("select version from schema_migrations");
    const alreadyApplied = new Set(rows.map((row) => row.version));

    for (const file of files) {
      if (alreadyApplied.has(file)) {
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (version) values ($1)", [file]);
        await client.query("commit");
      } catch (error) {
        // Guarded: if the connection died, an unguarded rollback would replace
        // the informative "migration X failed" error with a bare network error.
        await client.query("rollback").catch(() => {
          broken = true;
        });
        throw new Error(`migration ${file} failed: ${error.message}`, { cause: error });
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    return applied;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {
      broken = true;
    });
    // A client whose rollback/unlock failed may sit in an aborted transaction
    // or still hold the advisory lock — destroy it instead of recycling it.
    client.release(broken);
  }
}

// CLI entry point.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set — see .env.example.");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const applied = await migrate(pool, { log: console.log });
    console.log(
      applied.length === 0
        ? "already up to date — nothing to apply"
        : `applied ${applied.length} migration(s)`,
    );
  } finally {
    await pool.end();
  }
}
