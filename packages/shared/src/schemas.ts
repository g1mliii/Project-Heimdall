/**
 * Zod schemas for ingest payloads + API DTOs (IMPLEMENTATION_PLAN §2.2).
 *
 * Every ingest payload carries an explicit `schemaVersion` + `parserVersion` so
 * old uploads can be reprocessed safely. DTO TypeScript types are derived from
 * these schemas with `z.infer`, and the test suite asserts mutual assignability
 * with the hand-authored domain types in `types.ts` so the two can't drift.
 */

import { z } from "zod";
import { RUN_VISIBILITY, RUN_STATUS } from "./visibility";
import {
  CAPABILITY_MANIFEST_VERSION,
  CAPABILITY_SENSOR_FIELDS,
  CURRENT_SCHEMA_VERSION,
  GAME_SUBMISSIONS_MAX_PAGE_SIZE,
  GAME_SUBMISSIONS_PAGE_SIZE,
  INGEST_LIMITS,
  METHODOLOGY_MANIFEST_VERSION,
  MIN_FRAME_TIME_MS,
  SEARCH_RESULT_LIMIT,
} from "./constants";
import type { CapabilitySensorField } from "./constants";

/* ── Primitive enums (kept in lockstep with the domain unions in types.ts) ── */

export const captureSourceSchema = z.enum(["presentmon", "mangohud", "capframex"]);
export const generatedFrameTechSchema = z.enum(["none", "unknown", "dlss3", "fsr3", "xess"]);
export const gpuVendorSchema = z.enum(["nvidia", "amd", "intel", "unknown"]);
export const confidenceLevelSchema = z.enum(["high", "medium", "low"]);
export const diagnosticSeveritySchema = z.enum(["good", "warn", "bad", "info"]);

export const runVisibilitySchema = z.enum([
  RUN_VISIBILITY.private,
  RUN_VISIBILITY.unlisted,
  RUN_VISIBILITY.public,
]);

/** Pre-auth ingest cannot create owner-only private runs (accounts land in Phase 8). */
export const preAuthRunVisibilitySchema = runVisibilitySchema.exclude([
  RUN_VISIBILITY.private,
]);

export const runStatusSchema = z.enum([
  RUN_STATUS.pending,
  RUN_STATUS.validated,
  RUN_STATUS.flagged,
  RUN_STATUS.hidden,
  RUN_STATUS.moderated,
]);

/* ── Shared object schemas ──────────────────────────────────────────────── */

const pct = z.number().min(0).max(100);
const MAX_METADATA_TEXT_LENGTH = 512;
/**
 * `resolution` and `graphicsApi` are copied into indexed run columns. Keep
 * their worst-case UTF-8 tuple contribution safely below Postgres's B-tree
 * index-row limit while leaving descriptive manifest fields at 512 characters.
 *
 * Exported so the upload form can bound its own inputs to the same limit rather
 * than letting an overlong entry travel to the API only to come back a 400 that
 * names no field.
 */
export const MAX_INDEXED_METADATA_TEXT_LENGTH = 64;
const MAX_MANIFEST_CAVEATS = 16;
const MAX_EVIDENCE_METRICS = 16;
const metadataText = (maxLength: number) => z.string().trim().min(1).max(maxLength);
const metadataTextSchema = metadataText(MAX_METADATA_TEXT_LENGTH);
const indexedMetadataTextSchema = metadataText(MAX_INDEXED_METADATA_TEXT_LENGTH);
/** Opaque client-generated identity; unlike the local display label, it is never human-chosen. */
const benchmarkSetIdSchema = z.string().uuid();
/** URL-safe 256-bit browser-held capability used only to join an existing set. */
const benchmarkSetSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
/** Browser-local benchmark-set credentials use the same contract as the API. */
export const benchmarkSetCredentialsSchema = z.object({
  id: benchmarkSetIdSchema,
  secret: benchmarkSetSecretSchema,
});
export type BenchmarkSetCredentials = z.infer<typeof benchmarkSetCredentialsSchema>;
const evidenceMetricNameSchema = z.string().trim().min(1).max(64);

export const hardwareSnapshotSchema = z.object({
  gpu: z.string().min(1),
  cpu: z.string().min(1),
  gpuVendor: gpuVendorSchema.optional(),
  ramGb: z.number().positive().optional(),
  ramSpeedMtps: z.number().int().positive().optional(),
  ramRatedSpeedMtps: z.number().int().positive().optional(),
  os: z.string().optional(),
  gpuDriver: z.string().optional(),
  gpuVramTotalMb: z.number().positive().optional(),
  // This is mirrored into the indexed `runs.resolution` column when a
  // methodology manifest does not supply a separate value.
  resolution: indexedMetadataTextSchema.optional(),
  canonicalGpuId: z.string().optional(),
  canonicalCpuId: z.string().optional(),
});

/**
 * Concrete evidence a finding fired on (§16b.2). Mirrors `DiagnosticEvidence`;
 * every field is optional so a Phase 6 finding (no evidence) still validates.
 */
export const diagnosticEvidenceSchema = z.object({
  coverageFraction: z.number().min(0).max(1).optional(),
  sensors: z.array(z.enum(CAPABILITY_SENSOR_FIELDS)).max(CAPABILITY_SENSOR_FIELDS.length).optional(),
  metrics: z
    .record(evidenceMetricNameSchema, z.number())
    .refine((metrics) => Object.keys(metrics).length <= MAX_EVIDENCE_METRICS, {
      message: `at most ${MAX_EVIDENCE_METRICS} evidence metrics are allowed`,
    })
    .optional(),
  caveats: z.array(metadataTextSchema).max(MAX_MANIFEST_CAVEATS).optional(),
  provenance: z
    .object({
      sourceUrl: z.string().trim().min(1).max(2048).optional(),
      referencedVersion: indexedMetadataTextSchema.optional(),
      fetchedAt: z.string().datetime({ offset: true }).optional(),
    })
    .optional(),
});

/**
 * A single auto-diagnostic result (Phase 6/6.5). Mirrors the `Diagnostic`
 * domain type. Sensor requirements gate the rules engine internally (§15.5) and
 * are not persisted; the richer per-finding evidence, rule version, and
 * confidence label are the Phase 6.5 §16b.2 additions.
 */
export const diagnosticSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  severity: diagnosticSeveritySchema,
  title: z.string().min(1),
  detail: z.string().min(1),
  evidence: diagnosticEvidenceSchema.optional(),
  ruleVersion: z.string().min(1).optional(),
  confidence: confidenceLevelSchema.optional(),
  evaluatedAt: z.string().datetime({ offset: true }).optional(),
});
export type DiagnosticDto = z.infer<typeof diagnosticSchema>;

export const frameSampleSchema = z.object({
  timeMs: z.number().min(0),
  frameTimeMs: z.number().min(MIN_FRAME_TIME_MS),
  generated: z.boolean().optional(),
  gpuLoadPct: pct.optional(),
  gpuClockMhz: z.number().min(0).optional(),
  gpuPowerW: z.number().min(0).optional(),
  vramUsedMb: z.number().min(0).optional(),
  cpuLoadPct: pct.optional(),
  cpuBusyMs: z.number().min(0).optional(),
  gpuBusyMs: z.number().min(0).optional(),
});

export const runSummarySchema = z.object({
  avgFps: z.number().positive(),
  onePercentLowFps: z.number().positive(),
  pointOnePercentLowFps: z.number().positive(),
  frameTimeP50Ms: z.number().positive(),
  frameTimeP95Ms: z.number().positive(),
  frameTimeP99Ms: z.number().positive(),
  stutterCount: z.number().int().nonnegative(),
  generatedFramePct: z.number().min(0).max(1),
  pointOnePercentLowConfidence: confidenceLevelSchema,
  sampleCount: z.number().int().positive(),
  durationSeconds: z.number().positive(),
});

/* ── Capability manifest (§16a.3/§16a.4) ─────────────────────────────────── */

export const presentationModeSchema = z.enum([
  "hardware-independent-flip",
  "hardware-composed-flip",
  "composed",
  "legacy",
  "unknown",
]);
export const syncModeSchema = z.enum(["vsync", "tearing", "vrr", "unknown"]);

/**
 * Explicit VRAM-capacity state — either a discrete total, or a typed reason it
 * is unavailable. Mirrors the `VramCapacity` domain union (§16a.4).
 */
export const vramCapacitySchema = z.union([
  z.object({ totalMb: z.number().positive() }),
  z.object({ state: z.enum(["unified-memory", "unknown"]) }),
]);

const captureCapabilitySchema = z.object({
  present: z.boolean(),
  frameAligned: z.boolean(),
});

/** Per-sensor capability, keyed by the canonical 7-field sensor set (§7.3). */
const capabilitySensorsSchema = z.object(
  Object.fromEntries(
    CAPABILITY_SENSOR_FIELDS.map((field) => [field, captureCapabilitySchema]),
  ) as Record<CapabilitySensorField, typeof captureCapabilitySchema>,
);

/** Mirrors the `CapabilityManifest` domain type; drift-guarded in the tests. */
export const capabilityManifestSchema = z.object({
  version: z.number().int().positive().default(CAPABILITY_MANIFEST_VERSION),
  source: captureSourceSchema,
  sensors: capabilitySensorsSchema,
  presentationMode: presentationModeSchema,
  syncMode: syncModeSchema,
  frameGenerationObserved: z.boolean(),
  vramCapacity: vramCapacitySchema,
  caveats: z.array(metadataTextSchema).max(MAX_MANIFEST_CAVEATS),
});
export type CapabilityManifestDto = z.infer<typeof capabilityManifestSchema>;

/* ── Methodology manifest (§16c.1) ───────────────────────────────────────── */

export const sceneTypeSchema = z.enum(["benchmark-scene", "gameplay", "freeform"]);
export const upscalerModeSchema = z.enum(["none", "dlss", "fsr", "xess", "unknown"]);
export const rayTracingModeSchema = z.enum(["off", "on", "unknown"]);
export const hagsStateSchema = z.enum(["enabled", "disabled", "unknown"]);

export const framePacingSchema = z.object({
  // `runs.frame_pacing_cap` is an integer. Reject fractional limiter values
  // at the API boundary rather than letting a schema-valid request fail during
  // the database insert.
  capFps: z.number().int().positive().optional(),
  vsync: z.boolean(),
  vrr: z.boolean(),
  refreshHz: z.number().positive().optional(),
});

/** Mirrors the `MethodologyManifest` domain type; drift-guarded in the tests. */
export const methodologyManifestSchema = z.object({
  version: z.number().int().positive().default(METHODOLOGY_MANIFEST_VERSION),
  gameBuild: metadataTextSchema.optional(),
  scene: indexedMetadataTextSchema.optional(),
  sceneType: sceneTypeSchema,
  settingsPreset: indexedMetadataTextSchema.optional(),
  graphicsApi: indexedMetadataTextSchema.optional(),
  resolution: indexedMetadataTextSchema.optional(),
  upscaler: upscalerModeSchema,
  rayTracing: rayTracingModeSchema,
  frameGeneration: generatedFrameTechSchema,
  framePacing: framePacingSchema,
  os: metadataTextSchema.optional(),
  gpuDriver: metadataTextSchema.optional(),
  captureTool: metadataTextSchema.optional(),
  captureProfile: metadataTextSchema.optional(),
  hags: hagsStateSchema.optional(),
  warmupPolicy: metadataTextSchema.optional(),
  captureDurationSeconds: z.number().positive().optional(),
});
export type MethodologyManifestDto = z.infer<typeof methodologyManifestSchema>;

/* ── Public catalog + game-page reads (§17a) ───────────────────────────── */

export const searchGameResultSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
});

export const searchHardwareResultSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["gpu", "cpu"]),
  vendor: z.string().nullable(),
  canonicalName: z.string().min(1),
});

/** A short query is a normal typeahead state; only the upper bound rejects. */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().max(MAX_INDEXED_METADATA_TEXT_LENGTH),
  })
  .strict();

export const searchResponseSchema = z.object({
  games: z.array(searchGameResultSchema).max(SEARCH_RESULT_LIMIT.games),
  hardware: z.array(searchHardwareResultSchema).max(SEARCH_RESULT_LIMIT.hardware),
});

const gameSubmissionsCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/, "must be an opaque base64url cursor");

export const gameSubmissionsQuerySchema = z
  .object({
    cursor: gameSubmissionsCursorSchema.optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(GAME_SUBMISSIONS_MAX_PAGE_SIZE)
      .default(GAME_SUBMISSIONS_PAGE_SIZE),
    sceneType: sceneTypeSchema.optional(),
    /** Oldest/newest toggle for the individual, recency-ordered table. */
    sortDirection: z.enum(["asc", "desc"]).optional(),
  })
  .strict();
export type GameSubmissionsQuery = z.infer<typeof gameSubmissionsQuerySchema>;

export const gameSubmissionMethodologySchema = z.object({
  profileComplete: z.boolean(),
  resolution: z.string().nullable(),
  graphicsApi: z.string().nullable(),
  upscaler: upscalerModeSchema.nullable(),
  rayTracing: rayTracingModeSchema.nullable(),
  frameGeneration: generatedFrameTechSchema,
});

export const gameSubmissionRowSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().min(1),
  gpu: z.string().min(1),
  cpu: z.string().min(1),
  sceneType: sceneTypeSchema.nullable(),
  avgFps: z.number().positive(),
  onePercentLowFps: z.number().positive(),
  pointOnePercentLowFps: z.number().positive(),
  submittedBy: z.string().nullable(),
  /** Verified-reviewer tier (§20.3) — marker only, never touches the aggregate math. */
  submittedByVerified: z.boolean(),
  methodology: gameSubmissionMethodologySchema,
  isWarmup: z.boolean(),
  benchmarkSetId: z.string().nullable(),
  driverBelowMinimum: z.boolean(),
  driverBehindLatest: z.boolean(),
});

export const gameSubmissionsPageSchema = z.object({
  rows: z.array(gameSubmissionRowSchema).max(GAME_SUBMISSIONS_MAX_PAGE_SIZE),
  nextCursor: gameSubmissionsCursorSchema.nullable(),
});

/* ── Aggregate cohort distribution (§17) ───────────────────────────────────── */

/**
 * The pooled metrics a distribution can be built over (§17.0.3). Every one is
 * frame-derived (frame times or generated-frame flags), so none depends on the
 * optional sensor telemetry — a cohort's capability gate lives in
 * `cohortEligibilitySql`, not per-metric. Sensor-derived RATES (VRAM pressure,
 * CPU/GPU-bound) are aggregate diagnostics (§17.8), not distributions.
 */
export const distributionMetricSchema = z.enum([
  "avg-fps",
  "one-percent-low-fps",
  "point-one-percent-low-fps",
  "frametime-p50-ms",
  "frametime-p95-ms",
  "frametime-p99-ms",
  "stutter-rate",
  "generated-frame-share",
]);
export type DistributionMetric = z.infer<typeof distributionMetricSchema>;

/**
 * Cohort selection for a game's distribution. Every field narrows the exact
 * comparability bucket the distribution pools over; omitted fields leave that
 * dimension unpinned so the read returns each matching bucket separately (a
 * `benchmark-scene` bucket never merges with `gameplay`, §17.5). `verifiedOnly`
 * is accepted but inert until Phase 8's verified tier (§17.3).
 */
export const gameDistributionQuerySchema = z
  .object({
    metric: distributionMetricSchema.default("avg-fps"),
    /** Canonical GPU hardware id (numeric string), the primary cohort split. */
    gpuId: z
      .string()
      .regex(/^\d+$/, "must be a canonical hardware id")
      .optional(),
    sceneType: sceneTypeSchema.optional(),
    resolution: z.string().min(1).max(MAX_INDEXED_METADATA_TEXT_LENGTH).optional(),
    settingsPreset: z.string().min(1).max(MAX_INDEXED_METADATA_TEXT_LENGTH).optional(),
    upscaler: upscalerModeSchema.optional(),
    rayTracing: rayTracingModeSchema.optional(),
    /** The viewer's own run, for a "You: Nth percentile" marker within its bucket. */
    viewerRunId: z.string().min(1).max(64).optional(),
    verifiedOnly: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
  })
  .strict();
export type GameDistributionQuery = z.infer<typeof gameDistributionQuerySchema>;

export const distributionBinSchema = z.object({
  lower: z.number(),
  upper: z.number(),
  count: z.number().int().nonnegative(),
});

export const distributionMarkerSchema = z.object({
  p: z.number().min(0).max(100),
  value: z.number(),
});

/** The comparability descriptors that identify (and label) one cohort bucket. */
export const cohortComparabilitySchema = z.object({
  gpu: z.string().nullable(),
  gpuId: z.string().nullable(),
  resolution: z.string().nullable(),
  scene: z.string().nullable(),
  sceneType: sceneTypeSchema.nullable(),
  settingsPreset: z.string().nullable(),
  upscaler: upscalerModeSchema.nullable(),
  rayTracing: rayTracingModeSchema.nullable(),
  graphicsApi: z.string().nullable(),
  frameGeneration: generatedFrameTechSchema,
  frameCapFps: z.number().int().nullable(),
  vsync: z.boolean(),
  vrr: z.boolean(),
});

export const cohortDistributionSchema = z.object({
  comparability: cohortComparabilitySchema,
  /** Independent observations (a benchmark set counts once, §17.0.2). */
  observationCount: z.number().int().nonnegative(),
  /** Raw runs behind those observations (sets expand here) — for honest counts. */
  rawRunCount: z.number().int().nonnegative(),
  /**
   * The distribution — present only at/above the cold-start threshold (§17.4).
   * Below it this is null and the UI shows the raw submissions, never a curve.
   */
  distribution: z
    .object({
      bins: z.array(distributionBinSchema),
      min: z.number(),
      max: z.number(),
      mean: z.number(),
      markers: z.array(distributionMarkerSchema),
      sampleCount: z.number().int().nonnegative(),
    })
    .nullable(),
  /**
   * The viewer run's STANDING in this bucket (0–100): the share of comparable
   * observations it is at least as good as. Direction-aware — on a lower-is-
   * better metric a small value scores a HIGH standing — so "Nth percentile"
   * means the same thing to a reader on every metric (see `betterDirection`).
   */
  viewerPercentile: z.number().min(0).max(100).nullable(),
  /** The viewer run's metric value, for placing its marker on the value axis. */
  viewerValue: z.number().nullable(),
  /**
   * Why the viewer's own run is not itself pooled into this curve, or null when
   * it is (or when there is no viewer run). Their value is still ranked against
   * the curve — this states that the run behind it was not one of the points, so
   * the UI can say so instead of silently parking the marker on an axis edge.
   */
  viewerExclusion: z.enum(["statistical-outlier", "benchmark-set-member"]).nullable(),
  /**
   * Observations dropped from the curve as statistical outliers (§18.2). They
   * stay counted in `observationCount` and their runs stay individually visible
   * — this is a scoped aggregate exclusion, never a hide. Zero below the
   * cold-start threshold (outlier rejection is inert there).
   */
  excludedOutlierCount: z.number().int().nonnegative(),
});

/** How the game's runs split between the pool and the reasons they were excluded. */
export const cohortExclusionSummarySchema = z.object({
  /** Public + validated runs for the game (the aggregate-eligible population). */
  aggregateEligibleRuns: z.number().int().nonnegative(),
  /** Independent observations that entered a cohort (sets counted once). */
  pooledObservations: z.number().int().nonnegative(),
  /** Aggregate-eligible runs missing a complete methodology profile (§16c.3). */
  unprofiledRuns: z.number().int().nonnegative(),
  /** Aggregate-eligible runs below the current capability manifest version. */
  capabilityUnestablishedRuns: z.number().int().nonnegative(),
});

/**
 * An aggregate diagnostic rate over a game's cohort (§17.8) — an OBSERVATIONAL
 * support pattern, never a causal ranking. The denominator is only runs
 * evaluated at the current diagnostics generation (§17.8.0) that carry the
 * telemetry the rule requires; when that is zero the rate is `null`
 * ("unavailable"), never a misleading clean 0%.
 */
export const diagnosticRateSchema = z.object({
  key: z.enum(["driver-currency", "vram-pressure", "cpu-bound"]),
  label: z.string(),
  /** Observations flagged by the rule (of those with the required telemetry). */
  numerator: z.number().int().nonnegative(),
  /** Observations that could have produced the finding (evaluated + telemetry). */
  denominator: z.number().int().nonnegative(),
  /** numerator/denominator as a percent, or null when the denominator is zero. */
  ratePct: z.number().min(0).max(100).nullable(),
});
export type DiagnosticRate = z.infer<typeof diagnosticRateSchema>;

export const gameDistributionResponseSchema = z.object({
  game: searchGameResultSchema,
  metric: distributionMetricSchema,
  /** Whether higher metric values are better — governs the marker's phrasing. */
  betterDirection: z.enum(["higher", "lower", "neutral"]),
  /** The cohort contract this pooling obeyed, so a client can pin it (§17.0). */
  cohortDefinitionVersion: z.number().int().positive(),
  /** The minimum independent observations before a curve is drawn (§17.4). */
  minSampleSize: z.number().int().positive(),
  /** Buckets ordered by observation count desc; may be capped (see `truncated`). */
  cohorts: z.array(cohortDistributionSchema),
  /** True when more buckets existed than the response returned (§ no silent caps). */
  truncated: z.boolean(),
  exclusionSummary: cohortExclusionSummarySchema,
  /** Observational aggregate diagnostic rates over the game cohort (§17.8). */
  diagnosticRates: z.array(diagnosticRateSchema),
});
export type GameDistributionResponse = z.infer<typeof gameDistributionResponseSchema>;
export type CohortDistribution = z.infer<typeof cohortDistributionSchema>;
export type CohortComparability = z.infer<typeof cohortComparabilitySchema>;

/** Provenance fields shared by every ingest payload (§2.2). */
const provenance = {
  schemaVersion: z.number().int().positive().default(CURRENT_SCHEMA_VERSION),
  parserVersion: z.string().min(1),
};

/* ── Ingest / API DTOs ──────────────────────────────────────────────────── */

/**
 * `POST /api/runs` — create a pending run. Visibility defaults to `unlisted`
 * (link-scoped, never aggregated). Accepts the full `runVisibilitySchema`
 * (including `private`) since §20.2 — the route rejects `private` from an
 * anonymous caller (400 `auth-required-for-private`), not this schema, so the
 * validation error distinguishes "malformed" from "not signed in." The game
 * title is trimmed so normalization is idempotent.
 */
export const createRunRequestSchema = z
  .object({
    game: z.string().trim().min(1),
    captureSource: captureSourceSchema,
    visibility: runVisibilitySchema.default(RUN_VISIBILITY.unlisted),
    hardware: hardwareSnapshotSchema,
    summary: runSummarySchema,
    generatedFrameTech: generatedFrameTechSchema.default("none"),
    /**
     * Exact byte length of the Parquet the client will PUT (§11.10). Bounds the
     * presigned URL's Content-Length so an oversize upload is rejected BEFORE a
     * URL is ever issued.
     */
    parquetByteLength: z.number().int().min(1).max(INGEST_LIMITS.maxParquetBytes),
    /**
     * Client-derived capability manifest (§16a.3), optional. Provisional like
     * the summary — the verify worker recomputes it canonically. Present so a
     * client can declare capture semantics (presentation/sync mode) it detected
     * that the stored Parquet can't reveal.
     */
    capabilityManifest: capabilityManifestSchema.optional(),
    /** Declared reproducible methodology (§16c.1), optional. Quasi-identifying. */
    methodologyManifest: methodologyManifestSchema.optional(),
    /** Opaque repeatable-run identity; the human display label stays local (§16c.2). */
    benchmarkSetId: benchmarkSetIdSchema.optional(),
    /** Browser-held capability authorizing membership of the opaque set id. */
    benchmarkSetSecret: benchmarkSetSecretSchema.optional(),
    isWarmup: z.boolean().default(false),
    ...provenance,
  })
  .refine(
    (req) =>
      req.summary.sampleCount >= INGEST_LIMITS.minFramesPerRun &&
      req.summary.sampleCount <= INGEST_LIMITS.maxFramesPerRun,
    {
      path: ["summary", "sampleCount"],
      message: `sampleCount must be between ${INGEST_LIMITS.minFramesPerRun} and ${INGEST_LIMITS.maxFramesPerRun}`,
    },
  )
  .refine(
    (req) => !req.isWarmup || req.benchmarkSetId !== undefined,
    {
      path: ["isWarmup"],
      message: "a warm-up run must name its benchmark set",
    },
  )
  .refine(
    (req) => (req.benchmarkSetId === undefined) === (req.benchmarkSetSecret === undefined),
    {
      path: ["benchmarkSetSecret"],
      message: "a benchmark set id and secret must be provided together",
    },
  );
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

/** `POST /api/runs` response — the created id + the presigned R2 PUT URL. */
export const createRunResponseSchema = z.object({
  id: z.string().min(1),
  uploadUrl: z.string().url(),
  uploadObjectKey: z.string().min(1),
});
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

/**
 * `POST /api/runs/:id/finalize` — record summary metadata, the explicit
 * visibility choice, and a hashed management/delete token (issued for both
 * anonymous AND signed-in uploads — the protocol is unchanged by accounts,
 * §20.2). Accepts the full `runVisibilitySchema`; the route rejects `private`
 * from an anonymous caller.
 */
export const finalizeRunRequestSchema = z.object({
  uploadObjectKey: z.string().min(1),
  visibility: runVisibilitySchema,
  managementTokenHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "must be a lowercase sha-256 hex digest"),
  /**
   * Optional client signature over the uploaded Parquet bytes (§11.7),
   * base64-encoded Ed25519. Verified server-side against
   * HEIMDALL_SIGNING_PUBLIC_KEY; recorded as evidence, never gatekeeping.
   */
  signature: z.string().max(512).optional(),
  // NOTE: `signatureValid` is intentionally NOT accepted here. It is server-derived
  // evidence (set from the API's own signature verification, §11.7) and lives only on
  // the response/Run shape — never trust a client-asserted value. Invariant: integrity
  // is server-side.
});
export type FinalizeRunRequest = z.infer<typeof finalizeRunRequestSchema>;

/** `POST /api/runs/:id/finalize` response — the run enters the verify queue. */
export const finalizeRunResponseSchema = z.object({
  id: z.string().min(1),
  status: runStatusSchema,
});
export type FinalizeRunResponse = z.infer<typeof finalizeRunResponseSchema>;

/** `GET /api/runs/:id/frames` response — a short-lived signed R2 read URL. */
export const framesUrlResponseSchema = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int().positive(),
});
export type FramesUrlResponse = z.infer<typeof framesUrlResponseSchema>;

/** `PATCH /api/runs/:id` — owner-only visibility switcher (§20.2). */
export const updateRunVisibilityRequestSchema = z.object({
  visibility: runVisibilitySchema,
});
export type UpdateRunVisibilityRequest = z.infer<typeof updateRunVisibilityRequestSchema>;

const userRoleSchema = z.enum(["public", "verified", "admin"]);

/** `GET /api/account/runs` response item — one row of "My runs" (§20.2). */
export const ownedRunListItemSchema = z.object({
  id: z.string().min(1),
  game: z.string().min(1),
  visibility: runVisibilitySchema,
  status: runStatusSchema,
  createdAt: z.string(),
  avgFps: z.number(),
});
/** Cursor-paginated account run management list. */
export const accountRunsResponseSchema = z.object({
  runs: z.array(ownedRunListItemSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type OwnedRunListItem = z.infer<typeof ownedRunListItemSchema>;
export type AccountRunsResponse = z.infer<typeof accountRunsResponseSchema>;

/**
 * `PATCH /api/account` — handle edit only; email stays Clerk-managed. Loose
 * shape check here — `isValidHandle()` in `lib/repo/users.ts` is the
 * authoritative regex + reserved-word check, run at the route so it can
 * return one specific 400 message.
 */
export const updateAccountRequestSchema = z.object({
  handle: z.string().min(1).max(32),
});
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;

export const accountResponseSchema = z.object({
  id: z.string().min(1),
  handle: z.string().nullable(),
  email: z.string().nullable(),
  role: userRoleSchema,
});
export type AccountResponse = z.infer<typeof accountResponseSchema>;

/** `POST /api/admin/verifications` — grant the verified-reviewer tier (§20.3). */
export const grantVerificationRequestSchema = z.object({
  userId: z.string().min(1),
  hardwareVetted: z.boolean().default(false),
});
export type GrantVerificationRequest = z.infer<typeof grantVerificationRequestSchema>;

/** `DELETE /api/admin/verifications` — revoke. */
export const revokeVerificationRequestSchema = z.object({
  userId: z.string().min(1),
});
export type RevokeVerificationRequest = z.infer<typeof revokeVerificationRequestSchema>;

/** Uniform API error envelope every route returns on failure. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

/** `GET /api/runs/:id` response — the run with its (possibly provisional) summary. */
export const runResponseSchema = z.object({
  id: z.string().min(1),
  game: z.string().min(1),
  captureSource: captureSourceSchema,
  visibility: runVisibilitySchema,
  status: runStatusSchema,
  hardware: hardwareSnapshotSchema,
  summary: runSummarySchema,
  generatedFrameTech: generatedFrameTechSchema,
  diagnostics: z.array(diagnosticSchema),
  schemaVersion: z.number().int().positive(),
  parserVersion: z.string().min(1),
  createdAt: z.string().min(1),
  framesObjectKey: z.string().optional(),
  // `ownerId` is deliberately NOT in this wire schema (§20.3 finding): it's a
  // raw Clerk user id, useful internally for ownership checks (`isVisibleTo`)
  // but never something a run's public/unlisted viewers need — the
  // submissions table already exposes attribution via `submittedBy` (a
  // handle, not a raw id). `.parse()`ing a `Run` through this schema at the
  // API/page boundary strips it; do not re-add without a reason a viewer
  // needs it.
  signatureValid: z.boolean().optional(),
  capabilityManifest: capabilityManifestSchema.optional(),
  methodologyManifest: methodologyManifestSchema.optional(),
  benchmarkSetId: metadataTextSchema.optional(),
  isWarmup: z.boolean().optional(),
});
export type RunResponse = z.infer<typeof runResponseSchema>;

/** `GET /api/runs/:id/summary` response — just the canonical summary. */
export const runSummaryResponseSchema = runSummarySchema;
export type RunSummaryResponse = z.infer<typeof runSummaryResponseSchema>;

/* ── Moderation reports (§20.5) ─────────────────────────────────────────── */

export const reportReasonSchema = z.enum(["abusive-name", "bad-faith-upload", "other"]);
export const reportStatusSchema = z.enum(["open", "resolved", "dismissed"]);

/**
 * `POST /api/reports` — anonymous-allowed, matching every other report/ingest
 * path's zero-auth-friction invariant. Exactly one subject id, discriminated
 * by `subjectType`.
 */
export const createReportRequestSchema = z
  .object({
    subjectType: z.enum(["run", "game"]),
    subjectRunId: z.string().min(1).max(64).optional(),
    subjectGameId: z
      .string()
      .regex(/^\d+$/, "must be a canonical game id")
      .max(19)
      .refine(
        (value) => {
          try {
            return BigInt(value) <= 9_223_372_036_854_775_807n;
          } catch {
            return false;
          }
        },
        "must fit a canonical game id",
      )
      .optional(),
    reason: reportReasonSchema,
    detail: z.string().trim().max(MAX_METADATA_TEXT_LENGTH).optional(),
  })
  .refine(
    (req) =>
      req.subjectType === "run"
        ? req.subjectRunId !== undefined && req.subjectGameId === undefined
        : req.subjectGameId !== undefined && req.subjectRunId === undefined,
    { path: ["subjectType"], message: "subject id must match subjectType, and only one may be set" },
  );
export type CreateReportRequest = z.infer<typeof createReportRequestSchema>;

/** Admin queue row — `GET /api/admin/reports`. */
export const reportRowSchema = z.object({
  id: z.string().min(1),
  subjectType: z.enum(["run", "game"]),
  subjectRunId: z.string().nullable(),
  subjectGameId: z.string().nullable(),
  reason: reportReasonSchema,
  detail: z.string().nullable(),
  status: reportStatusSchema,
  createdAt: z.string().min(1),
});
export type ReportRow = z.infer<typeof reportRowSchema>;
/** Cursor-paginated moderation queue; never serialize an unbounded report set. */
export const adminReportsResponseSchema = z.object({
  reports: z.array(reportRowSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type AdminReportsResponse = z.infer<typeof adminReportsResponseSchema>;

/** `PATCH /api/admin/reports/:id` — resolve or dismiss. */
export const updateReportRequestSchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
});
export type UpdateReportRequest = z.infer<typeof updateReportRequestSchema>;

/** `PATCH /api/admin/games/:id` — single-field display-name fix (§20.5). */
export const updateGameRequestSchema = z.object({
  name: z.string().trim().min(1).max(MAX_METADATA_TEXT_LENGTH),
});
export type UpdateGameRequest = z.infer<typeof updateGameRequestSchema>;
