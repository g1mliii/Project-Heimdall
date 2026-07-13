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
import { DIAGNOSTICS } from "@heimdall/shared";
import type {
  CapabilityManifest,
  Diagnostic,
  DiagnosticFinding,
  HardwareSnapshot,
  MethodologyManifest,
  Run,
  RunSummary,
} from "@heimdall/shared";
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

/**
 * True when `error` is a Postgres unique violation (23505), optionally for one
 * specific constraint/index — lets routes turn expected conflicts into 4xx
 * instead of the catch-all 500.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const pgError = error as { code?: string; constraint?: string };
  return pgError.code === "23505" && (constraint === undefined || pgError.constraint === constraint);
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

/** A hand-curated game-ready requirement expires unless a curation pass refreshes it. */
export const REQUIRED_DRIVER_MAX_AGE_DAYS = DIAGNOSTICS.driverRequirementMaxAgeDays;

/** Shared by the direct helper and the verification hot-path read. */
const FRESH_REQUIRED_DRIVER_SQL = `case
  when g.required_driver_checked_at >= now() - ($2::integer * interval '1 day')
    then g.required_driver
  else null
end`;

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
  gpu_vram_total_mb: number | null;
  ram_gb: number | null;
  ram_rated_mtps: number | null;
  ram_actual_mtps: number | null;
  os_build: string | null;
  resolution: string | null;
  generated_frame_tech: Run["generatedFrameTech"];
  frames_object_key: string | null;
  capability_manifest: CapabilityManifest | null;
  settings_json: MethodologyManifest | null;
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

const RUN_WITH_SUMMARY_SELECT = `select r.id, r.user_id, r.game_raw, r.gpu_hardware_id, r.cpu_hardware_id,
        r.capture_source, r.visibility, r.status, r.signature_valid,
        r.cpu_model, r.gpu_model, r.gpu_vendor, r.gpu_driver, r.gpu_vram_total_mb,
        r.ram_gb, r.ram_rated_mtps, r.ram_actual_mtps, r.os_build, r.resolution,
        r.generated_frame_tech, r.frames_object_key, r.capability_manifest, r.settings_json,
        r.schema_version, r.parser_version, r.created_at,
        s.avg_fps, s.p1_low_fps, s.p01_low_fps,
        s.frametime_p50_ms, s.frametime_p95_ms, s.frametime_p99_ms,
        s.stutter_count, s.generated_frame_pct, s.p01_low_confidence,
        s.sample_count, s.duration_seconds`;

const RUN_WITH_SUMMARY_FROM = `from runs r
      join run_summaries s on s.run_id = r.id`;

function rowToRun(row: RunRow, diagnostics: Diagnostic[]): Run {
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
      gpuVramTotalMb: row.gpu_vram_total_mb ?? undefined,
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
    diagnostics,
    schemaVersion: row.schema_version,
    parserVersion: row.parser_version,
    createdAt: row.created_at.toISOString(),
    framesObjectKey: row.frames_object_key ?? undefined,
    ownerId: row.user_id ?? undefined,
    signatureValid: row.signature_valid ?? undefined,
    // jsonb comes back already parsed; it was written by our own derive path.
    capabilityManifest: row.capability_manifest ?? undefined,
    // settings_json holds the declared methodology manifest (§16c.1).
    methodologyManifest: row.settings_json ?? undefined,
  };
}

interface DiagnosticRow extends pg.QueryResultRow {
  id: string;
  code: string;
  severity: Diagnostic["severity"];
  title: string;
  detail: string;
  evidence: Diagnostic["evidence"] | null;
  rule_version: string | null;
  confidence: Diagnostic["confidence"] | null;
}

/**
 * Transpose findings into the seven positional arrays a diagnostics multi-row
 * insert unnests (code, severity, title, detail, evidence, rule_version,
 * confidence). Evidence is JSON-encoded per row (or null) and cast back to jsonb
 * in the insert; rule_version/confidence are null for Phase 6 findings.
 */
export function diagnosticInsertColumns(
  diagnostics: readonly DiagnosticFinding[],
): [
  string[],
  string[],
  string[],
  string[],
  (string | null)[],
  (string | null)[],
  (string | null)[],
] {
  return [
    diagnostics.map((d) => d.code),
    diagnostics.map((d) => d.severity),
    diagnostics.map((d) => d.title),
    diagnostics.map((d) => d.detail),
    diagnostics.map((d) => (d.evidence ? JSON.stringify(d.evidence) : null)),
    diagnostics.map((d) => d.ruleVersion ?? null),
    diagnostics.map((d) => d.confidence ?? null),
  ];
}

/**
 * The complete diagnostics insert/unnest shape. `runIdParameter` and
 * `firstFindingParameter` make it usable in both a standalone write and a
 * larger CTE without duplicating column order, aliases, or casts. The evidence
 * text[] is cast to jsonb per row so a null element stays a SQL null.
 */
export function diagnosticInsertSql(
  runIdParameter: number,
  firstFindingParameter: number,
  guardSql?: string,
): string {
  const codeParameter = firstFindingParameter;
  const severityParameter = codeParameter + 1;
  const titleParameter = codeParameter + 2;
  const detailParameter = codeParameter + 3;
  const evidenceParameter = codeParameter + 4;
  const ruleVersionParameter = codeParameter + 5;
  const confidenceParameter = codeParameter + 6;
  return `insert into diagnostics (run_id, code, severity, title, detail, evidence, rule_version, confidence)
     select $${runIdParameter}, code, severity, title, detail, evidence::jsonb, rule_version, confidence
       from unnest($${codeParameter}::text[], $${severityParameter}::text[], $${titleParameter}::text[], $${detailParameter}::text[], $${evidenceParameter}::text[], $${ruleVersionParameter}::text[], $${confidenceParameter}::text[])
         as finding(code, severity, title, detail, evidence, rule_version, confidence)${guardSql ? `\n      where ${guardSql}` : ""}`;
}

/**
 * Insert a run's diagnostics (no id — the column is identity-generated). The
 * verification worker writes findings through `applyVerificationResult` inside
 * its atomic verdict; this standalone helper backs seeding/tests. Rows preserve
 * array order via the identity sequence.
 */
export async function insertDiagnostics(
  runId: string,
  diagnostics: readonly DiagnosticFinding[],
  db: Queryable = getPool(),
): Promise<void> {
  if (diagnostics.length === 0) return;
  await db.query(
    diagnosticInsertSql(1, 2),
    [runId, ...diagnosticInsertColumns(diagnostics)],
  );
}

/** Read a run's diagnostics in insertion order (stable render order). */
export async function readDiagnostics(
  runId: string,
  db: Queryable = getPool(),
): Promise<Diagnostic[]> {
  const rows = await query<DiagnosticRow>(
    `select id, code, severity, title, detail, evidence, rule_version, confidence
       from diagnostics
      where run_id = $1
      order by id`,
    [runId],
    db,
  );
  return rows.map((row) => {
    // Attach the Phase 6.5 fields only when present so a Phase 6 finding
    // (all-null) round-trips to exactly the pre-6.5 shape.
    const diagnostic: Diagnostic = {
      id: row.id,
      code: row.code,
      severity: row.severity,
      title: row.title,
      detail: row.detail,
    };
    if (row.evidence !== null) diagnostic.evidence = row.evidence;
    if (row.rule_version !== null) diagnostic.ruleVersion = row.rule_version;
    if (row.confidence !== null) diagnostic.confidence = row.confidence;
    return diagnostic;
  });
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
         schema_version, parser_version, created_at, gpu_vram_total_mb,
         capability_manifest, capability_manifest_version,
         settings_json, methodology_manifest_version,
         upscaler, ray_tracing, frame_pacing_cap, vsync, vrr, scene_type
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
         $36::jsonb, $37,
         $38::jsonb, $39, $40, $41, $42, $43, $44, $45
       )
     )
     insert into run_summaries (
       run_id, avg_fps, p1_low_fps, p01_low_fps,
       frametime_p50_ms, frametime_p95_ms, frametime_p99_ms,
       stutter_count, generated_frame_pct, p01_low_confidence,
       sample_count, duration_seconds
     ) values ($1, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35)`,
    [
      run.id, run.ownerId ?? null, run.game,
      canonicalIdParam(hw.canonicalGpuId, "canonicalGpuId"),
      canonicalIdParam(hw.canonicalCpuId, "canonicalCpuId"),
      run.captureSource, run.visibility, run.status, run.signatureValid ?? null,
      hw.cpu, hw.gpu, hw.gpuVendor ?? null, hw.gpuDriver ?? null,
      hw.ramGb ?? null, hw.ramRatedSpeedMtps ?? null, hw.ramSpeedMtps ?? null,
      hw.os ?? null, hw.resolution ?? null,
      run.generatedFrameTech, run.framesObjectKey ?? null,
      run.schemaVersion, run.parserVersion, run.createdAt, hw.gpuVramTotalMb ?? null,
      summary.avgFps, summary.onePercentLowFps, summary.pointOnePercentLowFps,
      summary.frameTimeP50Ms, summary.frameTimeP95Ms, summary.frameTimeP99Ms,
      summary.stutterCount, summary.generatedFramePct, summary.pointOnePercentLowConfidence,
      summary.sampleCount, summary.durationSeconds,
      run.capabilityManifest ? JSON.stringify(run.capabilityManifest) : null,
      run.capabilityManifest?.version ?? null,
      run.methodologyManifest ? JSON.stringify(run.methodologyManifest) : null,
      run.methodologyManifest?.version ?? null,
      run.methodologyManifest?.upscaler ?? null,
      run.methodologyManifest?.rayTracing ?? null,
      run.methodologyManifest?.framePacing.capFps ?? null,
      run.methodologyManifest?.framePacing.vsync ?? null,
      run.methodologyManifest?.framePacing.vrr ?? null,
      run.methodologyManifest?.sceneType ?? null,
    ],
  );
}

/**
 * Read a run (with its summary) back into the domain shape; null when absent.
 * Columns are listed explicitly — never `r.*` — so security-sensitive columns
 * the domain shape doesn't carry (anonymous_management_token_hash, signature)
 * stay out of app memory on the read path.
 */
export async function readRun(
  id: string,
  db: Queryable = getPool(),
  { withDiagnostics = true }: { withDiagnostics?: boolean } = {},
): Promise<Run | null> {
  const rows = await query<RunRow>(
    `${RUN_WITH_SUMMARY_SELECT}
       ${RUN_WITH_SUMMARY_FROM}
      where r.id = $1`,
    [id],
    db,
  );
  const row = rows[0];
  if (!row) return null;
  // Second query, not a join: a run's diagnostics are 0–4 rows, and joining
  // them onto the summary would fan the single run row out per finding. Callers
  // that don't render the run (the verification worker, finalize) skip it to
  // avoid a wasted round-trip on the ingest hot path.
  const diagnostics = withDiagnostics ? await readDiagnostics(id, db) : [];
  return rowToRun(row, diagnostics);
}

/**
 * Curated minimum GPU driver for a run's resolved game (§15.4), or null when
 * the game is unresolved, has no curated value, or curation is stale.
 */
export async function readRunRequiredDriver(
  id: string,
  db: Queryable = getPool(),
): Promise<string | null> {
  const rows = await query<{ required_driver: string | null }>(
    `select ${FRESH_REQUIRED_DRIVER_SQL} as required_driver
       from runs r
       join games g on g.id = r.game_id
      where r.id = $1`,
    [id, REQUIRED_DRIVER_MAX_AGE_DAYS],
    db,
  );
  return rows[0]?.required_driver ?? null;
}

interface VerificationRunRow extends RunRow {
  signature: string | null;
  required_driver: string | null;
}

/**
 * Server-only verification read. One primary-key query returns the run's
 * canonical input, signature evidence, finalized object key, and a fresh
 * game-driver requirement, avoiding three separate pool checkouts per job.
 */
export async function readRunForVerification(
  id: string,
  db: Queryable = getPool(),
): Promise<{ run: Run; signature: string | null; requiredDriver: string | null } | null> {
  const rows = await query<VerificationRunRow>(
    `${RUN_WITH_SUMMARY_SELECT},
        r.signature,
        ${FRESH_REQUIRED_DRIVER_SQL} as required_driver
       ${RUN_WITH_SUMMARY_FROM}
       left join games g on g.id = r.game_id
      where r.id = $1`,
    [id, REQUIRED_DRIVER_MAX_AGE_DAYS],
    db,
  );
  const row = rows[0];
  return row
    ? {
        run: rowToRun(row, []),
        signature: row.signature,
        requiredDriver: row.required_driver,
      }
    : null;
}
