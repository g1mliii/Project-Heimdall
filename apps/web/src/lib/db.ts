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
import { DIAGNOSTICS, normalizeMethodologyManifest } from "@heimdall/shared";
import type {
  CapabilityManifest,
  ConfidenceLevel,
  Diagnostic,
  DiagnosticFinding,
  HardwareSnapshot,
  MethodologyManifest,
  Run,
  RunSummary,
} from "@heimdall/shared";
import type {
  DiagnosticsDriverCatalog,
  DiagnosticsDriverPlatform,
} from "@heimdall/parsers";
import { DIAGNOSTIC_RULES } from "@heimdall/parsers";
import { getDbEnv } from "./env";

/** Registry order — the order findings are produced, and the order they read back. */
const DIAGNOSTIC_RULE_CODES = DIAGNOSTIC_RULES.map((rule) => rule.code);

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
export const DRIVER_CATALOG_MAX_AGE_DAYS = DIAGNOSTICS.driverCatalogMaxAgeDays;
export const DRIVER_UPDATE_GRACE_DAYS = DIAGNOSTICS.driverUpdateGraceDays;

/**
 * Free-form OS snapshots mapped conservatively to the two supported families,
 * falling back to the capture tool's own platform.
 *
 * A null here defeats the `requirement.os = driver_platform.os` and
 * `catalog.os = driver_platform.os` joins, which silently suppresses BOTH driver
 * advisories — and `os_build` is absent far more often than not, since no parser
 * populates it and an anonymous upload need not declare an OS. So when the
 * snapshot says NOTHING, fall back to the capture tool, which is real evidence
 * rather than a guess: PresentMon and CapFrameX ship as Windows-only builds and
 * MangoHud is a Linux overlay.
 *
 * Text that IS present but unrecognized (`macOS 15`, `Windows 7`) is the
 * opposite: it is evidence of a platform this catalog does not cover. It must
 * still map to null, and must NOT be overridden by the capture tool.
 */
const DRIVER_OS_SQL = `case
  when trim(lower(coalesce(r.os_build, ''))) ~ '^(microsoft )?windows$'
    or lower(coalesce(r.os_build, '')) ~ '(^|[^a-z0-9])(?:(?:microsoft[ _-]+)?(?:windows|win)(?:[ _-]+nt[ _-]*|[ _-]*\\[\\s*version\\s+|[ _-]*)(?:10|11)(?:\\.\\d+)?)(?:[^a-z0-9]|$)' then 'windows'
  when lower(coalesce(r.os_build, '')) ~ '(^|[^a-z0-9])(linux|ubuntu|debian|fedora|arch( linux)?|steam ?os|pop!?_?os|manjaro|nobara|bazzite|opensuse|mint)([^a-z0-9]|$)' then 'linux'
  when nullif(trim(coalesce(r.os_build, '')), '') is null
    and r.capture_source in ('presentmon', 'capframex') then 'windows'
  when nullif(trim(coalesce(r.os_build, '')), '') is null
    and r.capture_source = 'mangohud' then 'linux'
  else null
end`;

/** Linux AMD/Intel use Mesa; every other supported cell uses a GPU package. */
const DRIVER_COMPONENT_SQL = `case
  when driver_platform.os = 'linux' and r.gpu_vendor in ('amd', 'intel') then 'mesa'
  else 'gpu'
end`;

const DRIVER_PLATFORM_JOIN_SQL = `left join lateral (
        select ${DRIVER_OS_SQL} as os
      ) driver_platform on true`;

const REQUIRED_DRIVER_JOIN_SQL = `left join game_driver_requirements requirement
        on requirement.game_id = r.game_id
       and requirement.vendor = r.gpu_vendor
       and requirement.os = driver_platform.os
       and requirement.fetched_at >= now() - ($2::integer * interval '1 day')`;

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
  benchmark_set_id: string | null;
  is_warmup: boolean;
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
        r.benchmark_set_id, r.is_warmup,
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
    ...(row.benchmark_set_id === null ? {} : { benchmarkSetId: row.benchmark_set_id }),
    ...(row.is_warmup ? { isWarmup: true } : {}),
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
  evaluated_at: Date | null;
}

/**
 * The canonical `run_summaries` column order, shared by every writer so the
 * insert, the verification update, and the reprocess update cannot drift.
 */
const SUMMARY_COLUMNS = [
  "avg_fps",
  "p1_low_fps",
  "p01_low_fps",
  "frametime_p50_ms",
  "frametime_p95_ms",
  "frametime_p99_ms",
  "stutter_count",
  "generated_frame_pct",
  "p01_low_confidence",
  "sample_count",
  "duration_seconds",
] as const;

/**
 * Transpose a summary into positional parameters in {@link SUMMARY_COLUMNS}
 * order.
 *
 * The parameters are positional, so a transposed pair here writes the wrong
 * value into the right column with no type error and no test failure. Every
 * writer goes through this one function so that ordering is stated once.
 */
export function summaryColumns(summary: RunSummary): (number | ConfidenceLevel)[] {
  return [
    summary.avgFps,
    summary.onePercentLowFps,
    summary.pointOnePercentLowFps,
    summary.frameTimeP50Ms,
    summary.frameTimeP95Ms,
    summary.frameTimeP99Ms,
    summary.stutterCount,
    summary.generatedFramePct,
    summary.pointOnePercentLowConfidence,
    summary.sampleCount,
    summary.durationSeconds,
  ];
}

/** `$n, $n+1, …` for the summary values, for the insert form. */
export function summaryValuesSql(firstSummaryParameter: number): string {
  return SUMMARY_COLUMNS.map((_, i) => `$${firstSummaryParameter + i}`).join(", ");
}

/** The `run_summaries` column list, for the insert form. */
export function summaryInsertColumnsSql(): string {
  return SUMMARY_COLUMNS.join(", ");
}

/**
 * The complete `run_summaries` update. `runIdParameter` and
 * `firstSummaryParameter` make it usable from any CTE without restating the
 * column order; `guardSql` gates the write on the caller's claim.
 */
export function summaryUpdateSql(
  runIdParameter: number,
  firstSummaryParameter: number,
  guardSql?: string,
): string {
  const assignments = SUMMARY_COLUMNS.map(
    (column, i) => `${column} = $${firstSummaryParameter + i}`,
  ).join(", ");
  return `update run_summaries
          set ${assignments}
        where run_id = $${runIdParameter}${guardSql ? `\n          and ${guardSql}` : ""}`;
}

/**
 * Retry backoff for a failed queue job, in seconds: 30s doubling per attempt,
 * capped at 5 doublings and a 300s ceiling. Reads `attempts` from the row being
 * updated, so it is only valid inside an update on a job table.
 *
 * Shared by the verification and reprocess lanes — `runMaintenancePass` drains
 * both under one budget, so their retry policies must not drift apart.
 */
export const RETRY_BACKOFF_SECS_SQL = "least(300, 30 * (1 << least(attempts - 1, 4)))";

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
  return `insert into diagnostics (run_id, code, severity, title, detail, evidence, rule_version, confidence, evaluated_at)
     select $${runIdParameter}, code, severity, title, detail, evidence::jsonb, rule_version, confidence, now()
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
    // Order by registry position, not by id. Serial id happens to match the
    // registry on first insert, but applyDriverRefresh replaces the two driver
    // findings with fresh (higher) ids, which would permanently sort them below
    // everything else. `array_position` returns null for a code no longer in the
    // registry; those sort last and keep a stable id tiebreak.
    `select id, code, severity, title, detail, evidence, rule_version, confidence, evaluated_at
       from diagnostics
      where run_id = $1
      order by array_position($2::text[], code) nulls last, id`,
    [runId, DIAGNOSTIC_RULE_CODES],
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
    if (row.evaluated_at !== null) diagnostic.evaluatedAt = row.evaluated_at.toISOString();
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
 * Thrown when a caller tries to join an existing benchmark set without its
 * browser-held capability. Routes deliberately map this to a generic 409 so
 * callers learn neither whether a set exists nor its stored secret hash.
 */
export class BenchmarkSetSecretMismatchError extends Error {
  constructor() {
    super("benchmark set cannot be joined with this secret");
    this.name = "BenchmarkSetSecretMismatchError";
  }
}

export interface InsertRunOptions {
  /** SHA-256 of the browser-held benchmark-set capability; never the plaintext. */
  benchmarkSetSecretHash?: string;
}

/**
 * Insert a run + its summary atomically. The optional benchmark set is
 * registered or capability-checked in the SAME data-modifying CTE, so a group
 * cannot be claimed by a separate request between check and insert. This
 * remains one network round trip on the app's primary write path (Neon is
 * remote; an explicit begin/insert/insert/commit would cost 4 RTTs).
 */
export async function insertRun(
  run: Run,
  db: Queryable = getPool(),
  { benchmarkSetSecretHash }: InsertRunOptions = {},
): Promise<void> {
  if (run.benchmarkSetId === undefined && benchmarkSetSecretHash !== undefined) {
    throw new Error("benchmarkSetSecretHash requires benchmarkSetId");
  }
  if (run.benchmarkSetId !== undefined && benchmarkSetSecretHash === undefined) {
    throw new Error("benchmarkSetSecretHash is required for benchmarkSetId");
  }
  if (
    benchmarkSetSecretHash !== undefined &&
    !/^[0-9a-f]{64}$/i.test(benchmarkSetSecretHash)
  ) {
    throw new Error("benchmarkSetSecretHash must be a sha-256 hex digest");
  }

  const { hardware: hw, summary } = run;
  const methodologyManifest = normalizeMethodologyManifest(
    run.methodologyManifest,
    hw,
    run.generatedFrameTech,
  );
  const resolution = methodologyManifest?.resolution ?? hw.resolution ?? null;
  const rows = await query<{ run_id: string }>(
    `with benchmark_set as (
       insert into benchmark_sets (id, secret_hash)
       select $46::text, $48::text
        where $46::text is not null
       on conflict (id) do update
         set secret_hash = excluded.secret_hash
       where benchmark_sets.secret_hash = excluded.secret_hash
       returning id
     ), run_row as (
       insert into runs (
         id, user_id, game_raw, gpu_hardware_id, cpu_hardware_id,
         capture_source, visibility, status, signature_valid,
         cpu_model, gpu_model, gpu_vendor, gpu_driver,
         ram_gb, ram_rated_mtps, ram_actual_mtps, os_build, resolution,
         generated_frame_tech, frames_object_key,
         schema_version, parser_version, created_at, gpu_vram_total_mb,
         capability_manifest, capability_manifest_version,
         settings_json, methodology_manifest_version,
         upscaler, ray_tracing, frame_pacing_cap, vsync, vrr, scene_type,
         benchmark_set_id, is_warmup, graphics_api, scene, settings_preset
       ) select
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
         $36::jsonb, $37,
         $38::jsonb, $39, $40, $41, $42, $43, $44, $45, $46, $47, $49, $50, $51
       where $46::text is null or exists (select 1 from benchmark_set)
       returning id
     )
     insert into run_summaries (
       run_id, ${summaryInsertColumnsSql()}
     ) select $1, ${summaryValuesSql(25)}
         from run_row
       returning run_id`,
    [
      run.id, run.ownerId ?? null, run.game,
      canonicalIdParam(hw.canonicalGpuId, "canonicalGpuId"),
      canonicalIdParam(hw.canonicalCpuId, "canonicalCpuId"),
      run.captureSource, run.visibility, run.status, run.signatureValid ?? null,
      hw.cpu, hw.gpu, hw.gpuVendor ?? null, hw.gpuDriver ?? null,
      hw.ramGb ?? null, hw.ramRatedSpeedMtps ?? null, hw.ramSpeedMtps ?? null,
      hw.os ?? null, resolution,
      run.generatedFrameTech, run.framesObjectKey ?? null,
      run.schemaVersion, run.parserVersion, run.createdAt, hw.gpuVramTotalMb ?? null,
      ...summaryColumns(summary),
      run.capabilityManifest ? JSON.stringify(run.capabilityManifest) : null,
      run.capabilityManifest?.version ?? null,
      methodologyManifest ? JSON.stringify(methodologyManifest) : null,
      methodologyManifest?.version ?? null,
      methodologyManifest?.upscaler ?? null,
      methodologyManifest?.rayTracing ?? null,
      methodologyManifest?.framePacing.capFps ?? null,
      methodologyManifest?.framePacing.vsync ?? null,
      methodologyManifest?.framePacing.vrr ?? null,
      methodologyManifest?.sceneType ?? null,
      run.benchmarkSetId ?? null,
      run.isWarmup ?? false,
      benchmarkSetSecretHash ?? null,
      methodologyManifest?.graphicsApi ?? null,
      methodologyManifest?.scene ?? null,
      methodologyManifest?.settingsPreset ?? null,
    ],
    db,
  );
  if (rows.length !== 1) {
    if (run.benchmarkSetId !== undefined) {
      throw new BenchmarkSetSecretMismatchError();
    }
    throw new Error("run insert did not return a row");
  }
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
    `select requirement.min_version as required_driver
       from runs r
       ${DRIVER_PLATFORM_JOIN_SQL}
       ${REQUIRED_DRIVER_JOIN_SQL}
      where r.id = $1`,
    [id, REQUIRED_DRIVER_MAX_AGE_DAYS],
    db,
  );
  return rows[0]?.required_driver ?? null;
}

interface VerificationRunRow extends RunRow {
  signature: string | null;
  required_driver: string | null;
  driver_os: DiagnosticsDriverPlatform["os"] | null;
  driver_component: DiagnosticsDriverPlatform["component"] | null;
  latest_driver: string | null;
  required_driver_source_url: string | null;
  required_driver_fetched_at: Date | null;
  latest_driver_source_url: string | null;
  latest_driver_fetched_at: Date | null;
}

/**
 * Server-only verification read. One primary-key query returns the run's
 * canonical input, signature evidence, finalized object key, and a fresh
 * game-driver requirement, avoiding three separate pool checkouts per job.
 */
export async function readRunForVerification(
  id: string,
  db: Queryable = getPool(),
): Promise<{
  run: Run;
  signature: string | null;
  requiredDriver: string | null;
  requiredDriverProvenance: { sourceUrl?: string; fetchedAt?: string } | null;
  driverPlatform: DiagnosticsDriverPlatform | null;
  driverCatalog: DiagnosticsDriverCatalog | null;
} | null> {
  const rows = await query<VerificationRunRow>(
    `${RUN_WITH_SUMMARY_SELECT},
        r.signature,
        requirement.min_version as required_driver,
        driver_platform.os as driver_os,
        ${DRIVER_COMPONENT_SQL} as driver_component,
        catalog.latest_version as latest_driver,
        requirement.source_url as required_driver_source_url,
        requirement.fetched_at as required_driver_fetched_at,
        catalog.source_url as latest_driver_source_url,
        catalog.fetched_at as latest_driver_fetched_at
       ${RUN_WITH_SUMMARY_FROM}
       ${DRIVER_PLATFORM_JOIN_SQL}
       ${REQUIRED_DRIVER_JOIN_SQL}
       left join driver_catalog catalog
         on catalog.vendor = r.gpu_vendor
        and catalog.os = driver_platform.os
        and catalog.component = ${DRIVER_COMPONENT_SQL}
        and catalog.gpu_series_key = ''
        and catalog.fetched_at >= now() - ($3::integer * interval '1 day')
        and catalog.released_at <= current_date - $4::integer
      where r.id = $1`,
    [
      id,
      REQUIRED_DRIVER_MAX_AGE_DAYS,
      DRIVER_CATALOG_MAX_AGE_DAYS,
      DRIVER_UPDATE_GRACE_DAYS,
    ],
    db,
  );
  const row = rows[0];
  if (!row) return null;
  const vendor = row.gpu_vendor;
  const driverPlatform =
    vendor && vendor !== "unknown" && row.driver_os && row.driver_component
      ? { vendor, os: row.driver_os, component: row.driver_component }
      : null;
  return {
    run: rowToRun(row, []),
    signature: row.signature,
    requiredDriver: row.required_driver,
    driverPlatform,
    driverCatalog:
      driverPlatform && row.latest_driver
        ? {
            ...driverPlatform,
            latestVersion: row.latest_driver,
            ...(row.latest_driver_source_url === null
              ? {}
              : { sourceUrl: row.latest_driver_source_url }),
            ...(row.latest_driver_fetched_at === null
              ? {}
              : { fetchedAt: row.latest_driver_fetched_at.toISOString() }),
          }
        : null,
    requiredDriverProvenance:
      row.required_driver === null
        ? null
        : {
            ...(row.required_driver_source_url === null
              ? {}
              : { sourceUrl: row.required_driver_source_url }),
            ...(row.required_driver_fetched_at === null
              ? {}
              : { fetchedAt: row.required_driver_fetched_at.toISOString() }),
          },
  };
}
