/**
 * Postgres access for route handlers (Phase 2). No ORM — hand-written SQL with
 * thin typed helpers, per the "readable over clever" invariant.
 *
 * Aggregate/distribution queries (Phase 7) must build on
 * `aggregateEligibilitySql()` from `@heimdall/shared` — never re-derive the
 * public+validated guard.
 *
 * Every helper takes a `Queryable` (defaulting to the app pool) so tests can
 * pass their own container-backed pool or a transaction-scoped client.
 */

import pg from "pg";
import type { HardwareSnapshot, Run, RunSummary } from "@heimdall/shared";
import { getDbEnv } from "./env";

/** A pg.Pool or checked-out pg.PoolClient — anything that can run a query. */
export type Queryable = Pick<pg.Pool, "query">;

// Next.js dev hot-reload re-evaluates modules; stash the pool on globalThis so
// reloads reuse one pool instead of leaking connections.
const globalForDb = globalThis as typeof globalThis & { __heimdallPgPool?: pg.Pool };

export function getPool(): pg.Pool {
  if (!globalForDb.__heimdallPgPool) {
    const env = getDbEnv();
    const pool = new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: env.DATABASE_POOL_MAX,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
      query_timeout: env.DATABASE_QUERY_TIMEOUT_MS,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 15_000,
      maxLifetimeSeconds: 30 * 60,
      allowExitOnIdle: true,
      application_name: "heimdall-web",
    });
    // Without a listener, an error on an IDLE pooled client (Neon closes idle
    // connections aggressively) is an unhandled 'error' event → process crash.
    pool.on("error", (error) => {
      console.error("pg pool: idle client error", error);
    });
    globalForDb.__heimdallPgPool = pool;
  }
  return globalForDb.__heimdallPgPool;
}

/** Typed query wrapper. */
export async function query<Row extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = getPool(),
): Promise<Row[]> {
  const result = await db.query<Row>(text, params as never[]);
  return result.rows;
}

/* ── Row ↔ domain mapping ───────────────────────────────────────────────── */

interface RunRow extends pg.QueryResultRow {
  id: string;
  user_id: string | null;
  game_raw: string;
  gpu_hardware_id: string | null; // bigint comes back as string
  cpu_hardware_id: string | null;
  capture_source: Run["captureSource"];
  visibility: Run["visibility"];
  status: Run["status"];
  signature_valid: boolean | null;
  cpu_model: string;
  gpu_model: string;
  gpu_vendor: HardwareSnapshot["gpuVendor"] | null;
  gpu_driver: string | null;
  ram_gb: number | null;
  ram_rated_mtps: number | null;
  ram_actual_mtps: number | null;
  os_build: string | null;
  resolution: string | null;
  generated_frame_tech: Run["generatedFrameTech"];
  frames_object_key: string | null;
  schema_version: number;
  parser_version: string;
  created_at: Date;
  // run_summaries columns (joined)
  avg_fps: number;
  p1_low_fps: number;
  p01_low_fps: number;
  frametime_p50_ms: number;
  frametime_p95_ms: number;
  frametime_p99_ms: number;
  stutter_count: number;
  generated_frame_pct: number;
  p01_low_confidence: RunSummary["pointOnePercentLowConfidence"];
  sample_count: number;
  duration_seconds: number;
}

function rowToRun(row: RunRow): Run {
  return {
    id: row.id,
    game: row.game_raw,
    captureSource: row.capture_source,
    visibility: row.visibility,
    status: row.status,
    hardware: {
      gpu: row.gpu_model,
      cpu: row.cpu_model,
      gpuVendor: row.gpu_vendor ?? undefined,
      ramGb: row.ram_gb ?? undefined,
      ramSpeedMtps: row.ram_actual_mtps ?? undefined,
      ramRatedSpeedMtps: row.ram_rated_mtps ?? undefined,
      os: row.os_build ?? undefined,
      gpuDriver: row.gpu_driver ?? undefined,
      resolution: row.resolution ?? undefined,
      canonicalGpuId: row.gpu_hardware_id ?? undefined,
      canonicalCpuId: row.cpu_hardware_id ?? undefined,
    },
    summary: {
      avgFps: row.avg_fps,
      onePercentLowFps: row.p1_low_fps,
      pointOnePercentLowFps: row.p01_low_fps,
      frameTimeP50Ms: row.frametime_p50_ms,
      frameTimeP95Ms: row.frametime_p95_ms,
      frameTimeP99Ms: row.frametime_p99_ms,
      stutterCount: row.stutter_count,
      generatedFramePct: row.generated_frame_pct,
      pointOnePercentLowConfidence: row.p01_low_confidence,
      sampleCount: row.sample_count,
      durationSeconds: row.duration_seconds,
    },
    generatedFrameTech: row.generated_frame_tech,
    schemaVersion: row.schema_version,
    parserVersion: row.parser_version,
    createdAt: row.created_at.toISOString(),
    framesObjectKey: row.frames_object_key ?? undefined,
    ownerId: row.user_id ?? undefined,
    signatureValid: row.signature_valid ?? undefined,
  };
}

/**
 * Canonical hardware ids map to bigint FK columns. They are server-resolved
 * (§11.9), but the domain type carries them as strings — reject anything
 * non-numeric here with a clear error instead of a Postgres 22P02.
 */
function canonicalIdParam(value: string | undefined, label: string): string | null {
  if (value === undefined) {
    return null;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a numeric canonical id, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Insert a run + its summary atomically. Both inserts live in one
 * data-modifying-CTE statement — implicitly transactional, and a single
 * network round trip on the app's primary write path (Neon is remote; an
 * explicit begin/insert/insert/commit would cost 4 RTTs).
 */
export async function insertRun(run: Run, db: Queryable = getPool()): Promise<void> {
  const { hardware: hw, summary } = run;
  await db.query(
    `with run_row as (
       insert into runs (
         id, user_id, game_raw, gpu_hardware_id, cpu_hardware_id,
         capture_source, visibility, status, signature_valid,
         cpu_model, gpu_model, gpu_vendor, gpu_driver,
         ram_gb, ram_rated_mtps, ram_actual_mtps, os_build, resolution,
         generated_frame_tech, frames_object_key,
         schema_version, parser_version, created_at
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
       )
     )
     insert into run_summaries (
       run_id, avg_fps, p1_low_fps, p01_low_fps,
       frametime_p50_ms, frametime_p95_ms, frametime_p99_ms,
       stutter_count, generated_frame_pct, p01_low_confidence,
       sample_count, duration_seconds
     ) values ($1, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34)`,
    [
      run.id, run.ownerId ?? null, run.game,
      canonicalIdParam(hw.canonicalGpuId, "canonicalGpuId"),
      canonicalIdParam(hw.canonicalCpuId, "canonicalCpuId"),
      run.captureSource, run.visibility, run.status, run.signatureValid ?? null,
      hw.cpu, hw.gpu, hw.gpuVendor ?? null, hw.gpuDriver ?? null,
      hw.ramGb ?? null, hw.ramRatedSpeedMtps ?? null, hw.ramSpeedMtps ?? null,
      hw.os ?? null, hw.resolution ?? null,
      run.generatedFrameTech, run.framesObjectKey ?? null,
      run.schemaVersion, run.parserVersion, run.createdAt,
      summary.avgFps, summary.onePercentLowFps, summary.pointOnePercentLowFps,
      summary.frameTimeP50Ms, summary.frameTimeP95Ms, summary.frameTimeP99Ms,
      summary.stutterCount, summary.generatedFramePct, summary.pointOnePercentLowConfidence,
      summary.sampleCount, summary.durationSeconds,
    ],
  );
}

/**
 * Read a run (with its summary) back into the domain shape; null when absent.
 * Columns are listed explicitly — never `r.*` — so security-sensitive columns
 * the domain shape doesn't carry (anonymous_management_token_hash, signature)
 * stay out of app memory on the read path.
 */
export async function readRun(id: string, db: Queryable = getPool()): Promise<Run | null> {
  const rows = await query<RunRow>(
    `select r.id, r.user_id, r.game_raw, r.gpu_hardware_id, r.cpu_hardware_id,
            r.capture_source, r.visibility, r.status, r.signature_valid,
            r.cpu_model, r.gpu_model, r.gpu_vendor, r.gpu_driver,
            r.ram_gb, r.ram_rated_mtps, r.ram_actual_mtps, r.os_build, r.resolution,
            r.generated_frame_tech, r.frames_object_key,
            r.schema_version, r.parser_version, r.created_at,
            s.avg_fps, s.p1_low_fps, s.p01_low_fps,
            s.frametime_p50_ms, s.frametime_p95_ms, s.frametime_p99_ms,
            s.stutter_count, s.generated_frame_pct, s.p01_low_confidence,
            s.sample_count, s.duration_seconds
       from runs r
       join run_summaries s on s.run_id = r.id
      where r.id = $1`,
    [id],
    db,
  );
  const row = rows[0];
  return row ? rowToRun(row) : null;
}
