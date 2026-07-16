/**
 * Minimal idempotent migration runner (IMPLEMENTATION_PLAN §4.3).
 *
 * Applies `migrations/*.sql` in lexical order, tracking applied files in a
 * `schema_migrations` table — re-running is a no-op. Each file runs inside its
 * own transaction; a session advisory lock serializes concurrent runners (two
 * CI jobs against the same Neon branch won't race).
 *
 * That lock spans every migration's transaction, so it REQUIRES a direct
 * connection — see {@link assertDirectConnection}. The CLI derives the direct
 * endpoint for you; callers passing their own pool must supply an unpooled one.
 *
 * CLI:   DATABASE_URL=postgres://… pnpm migrate
 * Tests: import { migrate } and pass a pg.Pool.
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/** Arbitrary but fixed app-wide key for the migration advisory lock. */
const MIGRATION_LOCK_KEY = 0x4865696d; // "Heim"

/** Give up rather than block a CI job forever behind a stuck lock. */
const LOCK_TIMEOUT_MS = 30_000;
const LOCK_POLL_MS = 250;

/**
 * Rewrite a Neon pooled host to its direct equivalent (`-pooler` is PgBouncer;
 * dropping it reaches the same database over a plain connection). Returns the
 * input unchanged when it is already direct or is not a parseable URL.
 */
export function directConnectionString(connectionString) {
  if (typeof connectionString !== "string") return connectionString;
  try {
    const url = new URL(connectionString);
    if (!url.hostname.includes("-pooler.")) return connectionString;
    url.hostname = url.hostname.replace("-pooler.", ".");
    return url.toString();
  } catch {
    return connectionString;
  }
}

/**
 * Refuse to migrate through a transaction pooler.
 *
 * This runner holds ONE session-level advisory lock across every migration's
 * transaction, which only works if all of them reach the same backend. A pooler
 * (Neon's `-pooler` endpoint is PgBouncer in transaction mode) hands out
 * whichever backend is free per transaction, so `pg_advisory_lock` would be
 * taken on one backend and stay held there while that connection is handed to
 * someone else, and the `pg_advisory_unlock` below would no-op on a different
 * backend. The lock leaks, and the next run blocks on a lock whose session
 * nobody can reach. DDL belongs on the direct endpoint regardless.
 */
function assertDirectConnection(pool) {
  const connectionString = pool?.options?.connectionString;
  if (typeof connectionString !== "string") return;
  let hostname;
  try {
    ({ hostname } = new URL(connectionString));
  } catch {
    return;
  }
  if (hostname.includes("-pooler.")) {
    throw new Error(
      `refusing to migrate through the connection pooler at ${hostname}: a pooled ` +
        `connection cannot hold the session advisory lock across each migration's ` +
        `transaction, so the lock would leak and block later runs. Use the direct ` +
        `endpoint instead (drop "-pooler" from the host).`,
    );
  }
}

/**
 * Take the migration lock, or fail with a diagnosis.
 *
 * `pg_advisory_lock` waits forever, which turns any stuck or leaked lock into a
 * silent hang. Poll the non-blocking variant to a deadline so a concurrent (or
 * abandoned) runner surfaces as an error instead.
 */
async function acquireMigrationLock(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await client.query("select pg_try_advisory_lock($1) as locked", [
      MIGRATION_LOCK_KEY,
    ]);
    if (rows[0].locked) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for the migration advisory lock — ` +
          `another runner may still be applying migrations, or a previous run leaked ` +
          `the lock (see assertDirectConnection).`,
      );
    }
    await delay(LOCK_POLL_MS);
  }
}

/**
 * Run all pending migrations. Returns the filenames applied by THIS invocation
 * (empty array = everything was already applied), so callers can assert
 * idempotence.
 *
 * @param {pg.Pool} pool
 * @param {{ log?: (message: string) => void, lockTimeoutMs?: number }} [options]
 * @returns {Promise<string[]>}
 */
export async function migrate(pool, { log = () => {}, lockTimeoutMs = LOCK_TIMEOUT_MS } = {}) {
  assertDirectConnection(pool);
  const client = await pool.connect();
  const applied = [];
  let broken = false;
  let locked = false;
  try {
    await acquireMigrationLock(client, lockTimeoutMs);
    locked = true;
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
    // Only release what this session actually took — unlocking a lock we never
    // acquired would no-op noisily and, worse, read as if it had been held.
    if (locked) {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {
        broken = true;
      });
    }
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
  // DATABASE_URL is the app's pooled endpoint; DDL wants the direct one, and the
  // session advisory lock REQUIRES it. Derive it rather than making every
  // operator keep a second URL around just for migrations.
  const connectionString = directConnectionString(databaseUrl);
  if (connectionString !== databaseUrl) {
    console.log(`using the direct endpoint for DDL: ${new URL(connectionString).hostname}`);
  }
  const pool = new pg.Pool({ connectionString, max: 1 });
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
