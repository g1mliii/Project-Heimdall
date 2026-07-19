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
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
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
const BENCHMARK_SET_ID = "57ba4bd4-8b3e-4a2b-a0d0-92fb48367d5d";
const BENCHMARK_SET_SECRET_HASH = "a".repeat(64);

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
      "0011_maintenance_hot_path_indexes.sql",
      "0012_seed_required_drivers.sql",
      "0013_diagnostics_columns.sql",
      "0015_hardware_alias_kind_aware.sql",
      "0016_capability_manifest.sql",
      "0017_methodology_manifest.sql",
      "0018_comparability_index.sql",
      "0019_comparability_frame_pacing_index.sql",
      "0020_benchmark_set_scope.sql",
      "0021_graphics_api_comparability.sql",
      "0022_scene_preset_comparability.sql",
      "0023_driver_currency.sql",
      "0024_driver_currency_fuzzy_lookup_indexes.sql",
      "0025_runs_game_fk_index.sql",
      "0026_reprocess_jobs.sql",
      "0027_catalog_search_and_game_recency_indexes.sql",
      "0028_game_scene_recency_index.sql",
      "0029_cohort_assessment.sql",
      "0030_diagnostics_watermark.sql",
      "0031_cohort_assessment_queue.sql",
      "0032_cohort_assessment_enqueue.sql",
    ]);

    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual(
      [
        "benchmark_sets",
        "cohort_assessment_jobs",
        "cohort_assessment_scan_state",
        "comparisons",
        "diagnostics",
        "driver_catalog",
        "game_aliases",
        "game_driver_requirements",
        "games",
        "hardware",
        "hardware_aliases",
        "rate_limits",
        "reprocess_jobs",
        "reprocess_watermarks",
        "run_cohort_assessments",
        "run_summaries",
        "runs",
        "schema_migrations",
        "staging_cleanup_jobs",
        "users",
        "verification_jobs",
        "verifications",
      ].sort(),
    );

    const diagnosticColumns = await pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'diagnostics'`,
    );
    const names = diagnosticColumns.rows.map((row) => row.column_name);
    expect(names).toContain("title");
    expect(names).toContain("detail");
    expect(names).not.toContain("message");

    const gameColumns = await pool.query<{ column_name: string }>(
      `select column_name
         from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'games'`,
    );
    expect(gameColumns.rows.map((row) => row.column_name)).not.toContain("required_driver");

    const coverage = await pool.query<{ vendor: string; os: string; component: string }>(
      `select vendor, os, component
         from driver_catalog
        order by vendor, os, component`,
    );
    expect(coverage.rows).toEqual([
      { vendor: "amd", os: "linux", component: "mesa" },
      { vendor: "amd", os: "windows", component: "gpu" },
      { vendor: "intel", os: "linux", component: "mesa" },
      { vendor: "intel", os: "windows", component: "gpu" },
      { vendor: "nvidia", os: "linux", component: "gpu" },
      { vendor: "nvidia", os: "windows", component: "gpu" },
    ]);
  });

  it("applies 0026 cleanly to an already-populated 0025 database", async () => {
    const schema = "phase_6_7_populated_migration";
    await pool.query(`drop schema if exists "${schema}" cascade; create schema "${schema}"`);
    const populated = new pg.Pool({
      connectionString: pool.options.connectionString,
      max: 1,
      options: `-csearch_path=${schema}`,
    });
    try {
      await populated.query(
        `create table schema_migrations (
           version text primary key,
           applied_at timestamptz not null default now()
         )`,
      );
      const migrationsDir = path.resolve(
        import.meta.dirname,
        "../../../../infra/db/migrations",
      );
      const files = (await readdir(migrationsDir))
        .filter((file) => file.endsWith(".sql") && file !== "0026_reprocess_jobs.sql")
        .sort();
      for (const file of files) {
        await populated.query(await readFile(path.join(migrationsDir, file), "utf8"));
        await populated.query("insert into schema_migrations (version) values ($1)", [file]);
      }
      await populated.query(
        `insert into runs (
           id, game_raw, capture_source, visibility, status,
           cpu_model, gpu_model, gpu_vendor, gpu_driver,
           frames_object_key, schema_version, parser_version
         ) values (
           'run_legacy_populated', 'Legacy Game', 'capframex', 'public', 'validated',
           'Legacy CPU', 'Legacy GPU', 'nvidia', '500.00',
           'runs/legacy-populated.parquet', 1, 'legacy'
         )`,
      );
      await populated.query(
        `insert into diagnostics (run_id, code, severity, title, detail, rule_version)
         values (
           'run_legacy_populated', 'driver-update-available', 'info',
           'Old driver finding', 'Legacy finding', '1.0.0'
         )`,
      );

      expect(await migrate(populated)).toEqual(["0026_reprocess_jobs.sql"]);
      const run = await populated.query<{
        status: string;
        capability_manifest_version: number | null;
        driver_evaluated_at: Date | null;
      }>(
        `select status, capability_manifest_version, driver_evaluated_at
           from runs where id = 'run_legacy_populated'`,
      );
      expect(run.rows[0]).toEqual({
        status: RUN_STATUS.validated,
        capability_manifest_version: null,
        driver_evaluated_at: null,
      });
      const diagnostic = await populated.query<{ evaluated_at: Date | null }>(
        "select evaluated_at from diagnostics where run_id = 'run_legacy_populated'",
      );
      expect(diagnostic.rows[0]?.evaluated_at).toBeNull();
      expect(await migrate(populated)).toEqual([]);
    } finally {
      await populated.end();
      await pool.query(`drop schema if exists "${schema}" cascade`);
    }
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
      "verification_jobs_active_claim_idx",
      "staging_cleanup_jobs_not_before_idx",
      "runs_pending_unfinalized_created_at_idx",
      "runs_public_benchmark_set_profile_idx",
      "runs_game_id_idx",
      "games_normalized_name_tokens_gin_idx",
      "game_aliases_normalized_name_tokens_gin_idx",
      "games_name_trgm_idx",
      "games_slug_trgm_idx",
      "game_aliases_normalized_name_trgm_idx",
      "hardware_canonical_name_trgm_idx",
      "hardware_aliases_normalized_name_trgm_idx",
      "runs_game_recent_idx",
      "runs_game_scene_recent_idx",
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

  it("gives legacy worker claims a lease during a rolling deploy", async () => {
    const run = fixtureRunWithId("run_legacy_lease_0001");
    await insertRun(run, pool);
    const inserted = await pool.query<{ id: string }>(
      "insert into verification_jobs (run_id) values ($1) returning id",
      [run.id],
    );
    const verificationLease = await pool.query<{ lease_safe: boolean }>(
      `update verification_jobs
          set status = 'running', locked_at = clock_timestamp()
        where id = $1
        returning not_before > locked_at as lease_safe`,
      [inserted.rows[0]?.id],
    );
    expect(verificationLease.rows[0]?.lease_safe).toBe(true);

    await pool.query(
      `insert into staging_cleanup_jobs (run_id, object_key, not_before)
       values ($1, $2, now())`,
      [run.id, `staging/runs/${run.id}.parquet`],
    );
    const stagingLease = await pool.query<{ lease_safe: boolean }>(
      `update staging_cleanup_jobs
          set locked_at = clock_timestamp()
        where run_id = $1
        returning not_before > locked_at as lease_safe`,
      [run.id],
    );
    expect(stagingLease.rows[0]?.lease_safe).toBe(true);

    await pool.query("delete from staging_cleanup_jobs where run_id = $1", [run.id]);
    await pool.query("delete from runs where id = $1", [run.id]);
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
          'verification_jobs_active_claim_idx',
          'runs_pending_unfinalized_created_at_idx',
          'runs_public_benchmark_set_profile_idx',
          'runs_game_id_idx',
          'reprocess_jobs_claim_idx',
          'runs_reprocess_capability_idx',
          'diagnostics_rule_version_run_idx',
          'runs_driver_evaluated_at_idx',
          'driver_catalog_fetched_at_idx',
          'game_driver_requirements_fetched_at_idx',
          'games_normalized_name_tokens_gin_idx',
          'game_aliases_normalized_name_tokens_gin_idx',
          'games_name_trgm_idx',
          'games_slug_trgm_idx',
          'game_aliases_normalized_name_trgm_idx',
          'hardware_canonical_name_trgm_idx',
          'hardware_aliases_normalized_name_trgm_idx',
          'runs_game_recent_idx',
          'runs_game_scene_recent_idx'
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
    expect(byName.get("runs_game_id_idx")?.definition).toContain("game_id");
    expect(byName.get("runs_game_id_idx")?.predicate).toContain("game_id IS NOT NULL");
    expect(byName.get("runs_game_recent_idx")?.definition).toContain(
      "game_id, created_at DESC, id DESC",
    );
    expect(byName.get("runs_game_recent_idx")?.predicate).toContain(
      "status = 'validated'::text",
    );
    expect(byName.get("runs_game_recent_idx")?.predicate).toContain(
      "visibility = 'public'::text",
    );
    expect(byName.get("runs_game_recent_idx")?.predicate).toContain("game_id IS NOT NULL");
    expect(byName.get("runs_game_scene_recent_idx")?.definition).toContain(
      "game_id, scene_type, created_at DESC, id DESC",
    );
    expect(byName.get("runs_game_scene_recent_idx")?.predicate).toContain(
      "status = 'validated'::text",
    );
    expect(byName.get("runs_game_scene_recent_idx")?.predicate).toContain(
      "visibility = 'public'::text",
    );
    expect(byName.get("runs_game_scene_recent_idx")?.predicate).toContain("game_id IS NOT NULL");
    expect(byName.get("runs_game_scene_recent_idx")?.predicate).toContain("scene_type IS NOT NULL");
    expect(byName.get("reprocess_jobs_claim_idx")?.definition).toContain("not_before");
    expect(byName.get("reprocess_jobs_claim_idx")?.definition).toContain("kind");
    expect(byName.get("reprocess_jobs_claim_idx")?.predicate).toContain("failed_at IS NULL");
    expect(byName.get("runs_reprocess_capability_idx")?.definition).toContain(
      "capability_manifest_version NULLS FIRST",
    );
    expect(byName.get("diagnostics_rule_version_run_idx")?.definition).toContain(
      "rule_version NULLS FIRST",
    );
    expect(byName.get("runs_driver_evaluated_at_idx")?.definition).toContain(
      "driver_evaluated_at NULLS FIRST",
    );
    expect(byName.get("driver_catalog_fetched_at_idx")?.definition).toContain("fetched_at");
    expect(byName.get("game_driver_requirements_fetched_at_idx")?.definition).toContain(
      "fetched_at",
    );
    expect(byName.get("verification_jobs_active_claim_idx")?.definition).toContain(
      "created_at",
    );
    expect(byName.get("verification_jobs_active_claim_idx")?.definition).toContain(
      "not_before",
    );
    const queuePredicate = byName.get("verification_jobs_active_claim_idx")?.predicate ?? "";
    expect(queuePredicate).toContain("'pending'");
    expect(queuePredicate).toContain("'running'");
    expect(byName.get("runs_pending_unfinalized_created_at_idx")?.definition).toContain("created_at");
    const reaperPredicate = byName.get("runs_pending_unfinalized_created_at_idx")?.predicate ?? "";
    expect(reaperPredicate).toContain("status = 'pending'::text");
    expect(reaperPredicate).toContain("frames_object_key IS NULL");
    const benchmarkSetIndex = byName.get("runs_public_benchmark_set_profile_idx");
    for (const column of ["benchmark_set_id", "scene", "settings_preset"]) {
      expect(benchmarkSetIndex?.definition).toContain(column);
    }
    const benchmarkPredicate = benchmarkSetIndex?.predicate ?? "";
    for (const required of [
      "status = 'validated'::text",
      "visibility = 'public'::text",
      "methodology_manifest_version IS NOT NULL",
      "resolution IS NOT NULL",
      "scene IS NOT NULL",
      "settings_preset IS NOT NULL",
      "upscaler IS NOT NULL",
      "ray_tracing IS NOT NULL",
      "vsync IS NOT NULL",
      "vrr IS NOT NULL",
      "scene_type IS NOT NULL",
    ]) {
      expect(benchmarkPredicate).toContain(required);
    }
    for (const name of [
      "games_normalized_name_tokens_gin_idx",
      "game_aliases_normalized_name_tokens_gin_idx",
    ]) {
      expect(byName.get(name)?.definition).toContain("USING gin");
      expect(byName.get(name)?.definition).toContain("regexp_split_to_array");
    }
    for (const name of [
      "games_name_trgm_idx",
      "games_slug_trgm_idx",
      "game_aliases_normalized_name_trgm_idx",
      "hardware_canonical_name_trgm_idx",
      "hardware_aliases_normalized_name_trgm_idx",
    ]) {
      expect(byName.get(name)?.definition).toContain("USING gin");
      expect(byName.get(name)?.definition).toContain("gin_trgm_ops");
    }

    const extension = await pool.query<{ schema_name: string }>(
      `select n.nspname as schema_name
         from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace
        where e.extname = 'pg_trgm'`,
    );
    expect(extension.rows).toEqual([{ schema_name: "public" }]);
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
    // Reconciled 0013 shape: title + detail (not the retired `message` column).
    await pool.query(
      `insert into diagnostics (run_id, code, severity, title, detail)
       values ($1, 'ram-below-rated', 'warn', 'RAM below rated', 'Enable EXPO.')`,
      [cascadeRun.id],
    );
    await pool.query("delete from runs where id = $1", [cascadeRun.id]);
    const summaries = await pool.query(
      "select 1 from run_summaries where run_id = $1",
      [cascadeRun.id],
    );
    const jobs = await pool.query(
      "select 1 from verification_jobs where run_id = $1",
      [cascadeRun.id],
    );
    const diagnostics = await pool.query(
      "select 1 from diagnostics where run_id = $1",
      [cascadeRun.id],
    );
    expect(summaries.rows).toEqual([]);
    expect(jobs.rows).toEqual([]);
    expect(diagnostics.rows).toEqual([]);
  });

  it("persists and reads back total VRAM capacity (§15.1)", async () => {
    const run = {
      ...fixtureRunWithId("run_vram_total"),
      hardware: { ...validRun.hardware, gpuVramTotalMb: 12_288 },
    };
    await insertRun(run, pool);
    expect((await readRun(run.id, pool))?.hardware.gpuVramTotalMb).toBe(12_288);
  });

  it("round-trips a capability + methodology manifest and mirrors comparability columns (§16a/§16c)", async () => {
    const capabilityManifest = {
      version: 1,
      source: "presentmon" as const,
      sensors: Object.fromEntries(
        (["gpuLoadPct", "gpuClockMhz", "gpuPowerW", "vramUsedMb", "cpuLoadPct", "cpuBusyMs", "gpuBusyMs"] as const).map(
          (field) => [field, { present: field.endsWith("BusyMs"), frameAligned: field.endsWith("BusyMs") }],
        ),
      ) as never,
      presentationMode: "hardware-independent-flip" as const,
      syncMode: "tearing" as const,
      frameGenerationObserved: false,
      vramCapacity: { totalMb: 12_288 },
      caveats: ["GPU-execution timing is HAGS-affected"],
    };
    const methodologyManifest = {
      version: 1,
      sceneType: "benchmark-scene" as const,
      scene: "Dogtown route",
      settingsPreset: "Ultra",
      resolution: "2560x1440",
      upscaler: "dlss" as const,
      rayTracing: "on" as const,
      frameGeneration: "dlss3" as const,
      graphicsApi: "dx12",
      framePacing: { capFps: 120, vsync: true, vrr: false },
    };
    const run = {
      ...fixtureRunWithId("run_manifests"),
      generatedFrameTech: "dlss3" as const,
      capabilityManifest,
      methodologyManifest,
      benchmarkSetId: BENCHMARK_SET_ID,
      isWarmup: true,
    };
    await insertRun(run, pool, { benchmarkSetSecretHash: BENCHMARK_SET_SECRET_HASH });

    const readBack = await readRun(run.id, pool);
    expect(readBack?.capabilityManifest).toEqual(capabilityManifest);
    expect(readBack?.methodologyManifest).toEqual(methodologyManifest);
    expect(readBack).toMatchObject({ benchmarkSetId: BENCHMARK_SET_ID, isWarmup: true });

    // The queryable comparability columns mirror the manifest (§16c.3).
    const { rows } = await pool.query<{
      upscaler: string;
      ray_tracing: string;
      graphics_api: string;
      scene: string;
      settings_preset: string;
      frame_pacing_cap: number;
      vsync: boolean;
      vrr: boolean;
      scene_type: string;
      benchmark_set_id: string;
      is_warmup: boolean;
    }>(
      `select upscaler, ray_tracing, graphics_api, scene, settings_preset, frame_pacing_cap, vsync, vrr, scene_type, benchmark_set_id, is_warmup
         from runs where id = $1`,
      [run.id],
    );
    expect(rows[0]).toEqual({
      upscaler: "dlss",
      ray_tracing: "on",
      graphics_api: "dx12",
      scene: "Dogtown route",
      settings_preset: "Ultra",
      frame_pacing_cap: 120,
      vsync: true,
      vrr: false,
      scene_type: "benchmark-scene",
      benchmark_set_id: BENCHMARK_SET_ID,
      is_warmup: true,
    });
  });

  it("extends runs_game_gpu_idx with the comparability columns (§16c.3)", async () => {
    const { rows } = await pool.query<{ definition: string }>(
      `select pg_get_indexdef(indexrelid) as definition
         from pg_index where indexrelid = 'runs_game_gpu_idx'::regclass`,
    );
    const definition = rows[0]?.definition ?? "";
    for (const column of [
      "resolution",
      "scene",
      "settings_preset",
      "upscaler",
      "ray_tracing",
      "generated_frame_tech",
      "graphics_api",
      "frame_pacing_cap",
      "vsync",
      "vrr",
      "scene_type",
    ]) {
      expect(definition, `runs_game_gpu_idx includes ${column}`).toContain(column);
    }
    // The partial predicate is preserved from 0004.
    expect(definition).toContain("validated");
    expect(definition).toContain("public");
  });

  it("backfills indexed methodology fields from pre-0022 rows", async () => {
    const run = {
      ...fixtureRunWithId("run_graphics_api_backfill"),
      methodologyManifest: {
        version: 1,
        sceneType: "benchmark-scene" as const,
        scene: "Dogtown route",
        settingsPreset: "Ultra",
        upscaler: "none" as const,
        rayTracing: "off" as const,
        frameGeneration: "none" as const,
        graphicsApi: "dx12",
        framePacing: { vsync: false, vrr: false },
      },
    };
    await insertRun(run, pool);
    await pool.query(
      `update runs
          set graphics_api = null,
              scene = null,
              settings_preset = null,
              settings_json = jsonb_set(
                jsonb_set(
                  jsonb_set(settings_json, '{graphicsApi}', to_jsonb($2::text)),
                  '{scene}', to_jsonb($3::text)
                ),
                '{settingsPreset}', to_jsonb($4::text)
              )
        where id = $1`,
      [run.id, "x".repeat(65), "y".repeat(65), "z".repeat(65)],
    );
    await pool.query(
      "delete from schema_migrations where version = any($1::text[])",
      [["0021_graphics_api_comparability.sql", "0022_scene_preset_comparability.sql"]],
    );

    expect(await migrate(pool)).toEqual([
      "0021_graphics_api_comparability.sql",
      "0022_scene_preset_comparability.sql",
    ]);
    const { rows } = await pool.query<{
      graphics_api: string | null;
      scene: string | null;
      settings_preset: string | null;
    }>(
      "select graphics_api, scene, settings_preset from runs where id = $1",
      [run.id],
    );
    expect(rows[0]?.graphics_api).toMatch(/^legacy:[0-9a-f]{32}$/);
    expect(rows[0]?.scene).toMatch(/^legacy:[0-9a-f]{32}$/);
    expect(rows[0]?.settings_preset).toMatch(/^legacy:[0-9a-f]{32}$/);
  });
});
