/**
 * Storage regression coverage — Postgres (IMPLEMENTATION_PLAN §6.1/§6.2).
 *
 * Runs against a real Postgres: `TEST_DATABASE_URL` when set (a DISPOSABLE
 * database — its public schema is dropped), otherwise an ephemeral
 * Testcontainers instance (needs Docker). Locally with neither available the
 * suite skips loudly; in CI it FAILS instead — migration coverage must never
 * vanish silently from the gate.
 */

import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { VerificationJobStatus } from "@heimdall/shared";
import {
  RUN_STATUS,
  RUN_VISIBILITY,
  captureSourceSchema,
  confidenceLevelSchema,
  diagnosticSeveritySchema,
  generatedFrameTechSchema,
  gpuVendorSchema,
  validRun,
} from "@heimdall/shared";
import { migrate } from "../../../../infra/db/migrate.mjs";
import { insertRun, readRun } from "./db";

const testDbUrl = process.env.TEST_DATABASE_URL;

function fixtureRunWithId(id: string): typeof validRun {
  return {
    ...validRun,
    id,
    framesObjectKey: `runs/${id}.parquet`,
  };
}

function dockerAvailable(): boolean {
  try {
    // Module-level (describe.skipIf needs a collection-time answer); keep the
    // timeout short so a wedged daemon can't stall test collection for long.
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

const canRun = Boolean(testDbUrl) || dockerAvailable();
if (!canRun) {
  if (process.env.CI) {
    throw new Error(
      "[db.test] no Postgres available in CI — provide Docker or TEST_DATABASE_URL; " +
        "refusing to silently skip migration coverage.",
    );
  }
  console.warn(
    "[db.test] SKIPPED: no Postgres available — set TEST_DATABASE_URL to a disposable " +
      "database or start Docker (Testcontainers).",
  );
}

describe.skipIf(!canRun)("postgres migrations + round-trip (§6)", () => {
  let pool: pg.Pool;
  let stopContainer: (() => Promise<unknown>) | undefined;
  let appliedOnFresh: string[];

  beforeAll(async () => {
    if (testDbUrl) {
      pool = new pg.Pool({ connectionString: testDbUrl, max: 2 });
      // TEST_DATABASE_URL is documented-disposable: reset to a fresh state.
      await pool.query("drop schema public cascade; create schema public;");
    } else {
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      const container = await new PostgreSqlContainer("postgres:17-alpine").start();
      stopContainer = () => container.stop();
      pool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });
    }
    appliedOnFresh = await migrate(pool);
  }, 240_000); // first run may pull the postgres image

  afterAll(async () => {
    await pool?.end();
    await stopContainer?.();
  });

  it("applies all migrations cleanly on a fresh DB (§6.1)", async () => {
    expect(appliedOnFresh).toEqual([
      "0001_dictionaries.sql",
      "0002_runs.sql",
      "0003_verification_comparisons.sql",
      "0004_indexes.sql",
      "0005_numeric_integrity.sql",
      "0006_scale_hardening.sql",
      "0007_rate_limits.sql",
      "0008_generated_frame_unknown.sql",
      "0009_staging_cleanup_jobs.sql",
      "0010_verification_job_backoff.sql",
    ]);

    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(
      [
        "comparisons",
        "diagnostics",
        "game_aliases",
        "games",
        "hardware",
        "hardware_aliases",
        "rate_limits",
        "run_summaries",
        "runs",
        "schema_migrations",
        "staging_cleanup_jobs",
        "users",
        "verification_jobs",
        "verifications",
      ].sort(),
    );
  });

  it("creates the §4.2 indexes", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public'",
    );
    const names = rows.map((r) => r.indexname);
    for (const expected of [
      "runs_game_gpu_idx",
      "runs_created_at_idx",
      "runs_status_visibility_idx",
      "runs_frames_object_key_idx",
      "runs_anonymous_management_token_hash_idx",
      "hardware_kind_canonical_name_idx",
      "hardware_gpu_pci_identity_idx",
      "game_aliases_game_id_idx",
      "hardware_aliases_hardware_id_idx",
      "runs_user_id_idx",
      "runs_gpu_hardware_id_idx",
      "runs_cpu_hardware_id_idx",
      "diagnostics_run_id_idx",
      "comparisons_user_id_idx",
      "comparisons_before_run_id_idx",
      "comparisons_after_run_id_idx",
      "verifications_verified_by_idx",
      "verification_jobs_run_id_idx",
      "verification_jobs_status_locked_at_idx",
      "staging_cleanup_jobs_not_before_idx",
    ]) {
      expect(names).toContain(expected);
    }
  });

  it("keeps staging cleanup durable after anonymous run deletion", async () => {
    const { rows } = await pool.query(
      `select 1
         from pg_constraint
        where conrelid = 'staging_cleanup_jobs'::regclass
          and contype = 'f'`,
    );
    expect(rows).toEqual([]);
  });

  it("keeps aggregate and queue hot-path indexes scale-oriented", async () => {
    const { rows } = await pool.query<{
      name: string;
      definition: string;
      predicate: string | null;
    }>(
      `select idx.indexrelid::regclass::text as name,
              pg_get_indexdef(idx.indexrelid) as definition,
              pg_get_expr(idx.indpred, idx.indrelid) as predicate
         from pg_index idx
        where idx.indexrelid::regclass::text in (
          'runs_game_gpu_idx',
          'runs_created_at_idx',
          'runs_status_visibility_idx',
          'runs_user_id_idx',
          'verification_jobs_status_locked_at_idx'
        )`,
    );
    const byName = new Map(rows.map((row) => [row.name, row]));

    expect(byName.get("runs_game_gpu_idx")?.predicate).toMatch(/status = 'validated'::text/);
    expect(byName.get("runs_game_gpu_idx")?.predicate).toMatch(/visibility = 'public'::text/);
    expect(byName.get("runs_game_gpu_idx")?.definition).toContain("created_at DESC");
    expect(byName.get("runs_created_at_idx")?.definition).toContain("id DESC");
    expect(byName.get("runs_status_visibility_idx")?.definition).toContain("created_at DESC");
    expect(byName.get("runs_user_id_idx")?.definition).toContain("created_at DESC");
    expect(byName.get("runs_user_id_idx")?.definition).toContain("id DESC");
    expect(byName.get("verification_jobs_status_locked_at_idx")?.definition).toContain(
      "created_at",
    );
    expect(byName.get("verification_jobs_status_locked_at_idx")?.definition).toContain(
      "not_before",
    );
    const queuePredicate = byName.get("verification_jobs_status_locked_at_idx")?.predicate ?? "";
    expect(queuePredicate).toContain("'pending'");
    expect(queuePredicate).toContain("'running'");
  });

  it("CHECK constraints stay in lockstep with the shared enum constants", async () => {
    // The SQL files can't import TS, so this test is the drift guard: every
    // value of each shared enum must appear in its CHECK constraint, and the
    // constraint must not allow extras (checked via count of quoted literals).
    // The Record trick keeps the job-status list compile-time exhaustive.
    const verificationJobStatuses = Object.keys({
      pending: 1,
      running: 1,
      succeeded: 1,
      failed: 1,
    } satisfies Record<VerificationJobStatus, 1>);
    const cases: Array<[constraint: string, values: string[]]> = [
      ["runs_visibility_check", Object.values(RUN_VISIBILITY)],
      ["runs_status_check", Object.values(RUN_STATUS)],
      ["runs_capture_source_check", [...captureSourceSchema.options]],
      ["runs_generated_frame_tech_check", [...generatedFrameTechSchema.options]],
      ["runs_gpu_vendor_check", [...gpuVendorSchema.options]],
      ["run_summaries_p01_low_confidence_check", [...confidenceLevelSchema.options]],
      ["diagnostics_severity_check", [...diagnosticSeveritySchema.options]],
      ["verification_jobs_status_check", verificationJobStatuses],
    ];
    for (const [constraint, values] of cases) {
      // API/worker/repo suites migrate isolated schemas in parallel in CI; this
      // suite owns public, so inspect only its constraints.
      const { rows } = await pool.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def
           from pg_constraint
          where conname = $1
            and connamespace = 'public'::regnamespace`,
        [constraint],
      );
      expect(rows, `constraint ${constraint} exists`).toHaveLength(1);
      const def = rows[0]?.def ?? "";
      for (const value of values) {
        expect(def, `${constraint} allows '${value}'`).toContain(`'${value}'`);
      }
      expect(def.match(/'[^']*'/g), `${constraint} allows nothing extra`).toHaveLength(
        values.length,
      );
    }
  });

  it("re-running the runner is a no-op (idempotent, §4.3/§6.1)", async () => {
    const applied = await migrate(pool);
    expect(applied).toEqual([]);
  });

  it("has NO per-frame table — frames are Parquet in R2 (invariant §4.3)", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name ~* 'frame'`,
    );
    expect(rows).toEqual([]);
  });

  it("round-trips a fixture run + summary through the domain mappers (§6.2)", async () => {
    await insertRun(validRun, pool);
    const roundTripped = await readRun(validRun.id, pool);
    expect(roundTripped).toEqual(validRun);
  });

  it("rejects non-numeric canonical hardware ids with a clear error", async () => {
    const bad = {
      ...fixtureRunWithId("run_bad_canonical"),
      hardware: { ...validRun.hardware, canonicalGpuId: "nvidia-rtx4070" },
    };
    await expect(insertRun(bad, pool)).rejects.toThrow(/canonicalGpuId.*numeric/);
  });

  it("rejects rows that violate the shared enum constraints", async () => {
    await expect(
      pool.query(
        `insert into runs (id, game_raw, capture_source, visibility, status,
                           cpu_model, gpu_model, schema_version, parser_version)
         values ('run_bad', 'x', 'fraps', 'unlisted', 'pending', 'c', 'g', 1, 'p')`,
      ),
    ).rejects.toThrow(/runs_capture_source_check/);
  });

  it("rejects impossible summary/job metrics at the DB layer", async () => {
    const badSummaryRun = {
      ...fixtureRunWithId("run_bad_negative_summary"),
      summary: { ...validRun.summary, avgFps: -1 },
    };
    await expect(insertRun(badSummaryRun, pool)).rejects.toThrow(
      /run_summaries_nonnegative_metrics_check/,
    );

    const zeroSampleRun = {
      ...fixtureRunWithId("run_bad_zero_sample"),
      summary: { ...validRun.summary, sampleCount: 0 },
    };
    await expect(insertRun(zeroSampleRun, pool)).rejects.toThrow(
      /run_summaries_nonnegative_metrics_check/,
    );

    const badJobRun = fixtureRunWithId("run_bad_job_attempts");
    await insertRun(badJobRun, pool);
    await expect(
      pool.query("insert into verification_jobs (run_id, attempts) values ($1, -1)", [
        badJobRun.id,
      ]),
    ).rejects.toThrow(/verification_jobs_attempts_nonnegative_check/);
    await expect(
      pool.query(
        `insert into staging_cleanup_jobs (run_id, object_key, not_before, attempts)
         values ('run_bad_cleanup_attempts', 'staging/runs/run_bad_cleanup_attempts.parquet', now(), -1)`,
      ),
    ).rejects.toThrow(/staging_cleanup_jobs_attempts_nonnegative_check/);
    await pool.query("delete from runs where id = $1", [badJobRun.id]);
  });

  it("touches verification_jobs.updated_at on every UPDATE (trigger)", async () => {
    const triggerRun = fixtureRunWithId("run_trigger_0001");
    await insertRun(triggerRun, pool);
    const inserted = await pool.query<{ id: string }>(
      "insert into verification_jobs (run_id) values ($1) returning id",
      [triggerRun.id],
    );
    // Compare in SQL (µs precision) — the JS driver truncates to milliseconds.
    const updated = await pool.query<{ touched: boolean }>(
      `update verification_jobs set status = 'running' where id = $1
       returning (updated_at > created_at) as touched`,
      [inserted.rows[0]?.id],
    );
    expect(updated.rows[0]?.touched).toBe(true);
    await pool.query("delete from runs where id = $1", [triggerRun.id]);
  });

  it("cascades run deletion to summary/diagnostics/jobs rows", async () => {
    // Self-contained: inserts its own run so it can run in isolation.
    const cascadeRun = fixtureRunWithId("run_cascade_0001");
    await insertRun(cascadeRun, pool);
    await pool.query("insert into verification_jobs (run_id) values ($1)", [cascadeRun.id]);
    await pool.query("delete from runs where id = $1", [cascadeRun.id]);
    const summaries = await pool.query(
      "select 1 from run_summaries where run_id = $1",
      [cascadeRun.id],
    );
    const jobs = await pool.query(
      "select 1 from verification_jobs where run_id = $1",
      [cascadeRun.id],
    );
    expect(summaries.rows).toEqual([]);
    expect(jobs.rows).toEqual([]);
  });
});
