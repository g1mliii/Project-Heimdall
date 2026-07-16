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
  methodology: gameSubmissionMethodologySchema,
  isWarmup: z.boolean(),
  benchmarkSetId: z.string().nullable(),
  gpuDriver: z.string().nullable(),
  requiredDriver: z.string().nullable(),
  latestDriver: z.string().nullable(),
});

export const gameSubmissionsPageSchema = z.object({
  rows: z.array(gameSubmissionRowSchema).max(GAME_SUBMISSIONS_MAX_PAGE_SIZE),
  nextCursor: gameSubmissionsCursorSchema.nullable(),
});

/** Provenance fields shared by every ingest payload (§2.2). */
const provenance = {
  schemaVersion: z.number().int().positive().default(CURRENT_SCHEMA_VERSION),
  parserVersion: z.string().min(1),
};

/* ── Ingest / API DTOs ──────────────────────────────────────────────────── */

/**
 * `POST /api/runs` — create a pending run. Visibility defaults to `unlisted`
 * (link-scoped, never aggregated) per the pre-auth visibility model (§11 note).
 * The game title is trimmed so normalization is idempotent.
 */
export const createRunRequestSchema = z
  .object({
    game: z.string().trim().min(1),
    captureSource: captureSourceSchema,
    visibility: preAuthRunVisibilitySchema.default(RUN_VISIBILITY.unlisted),
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
 * visibility choice, and (for anonymous runs) a hashed management/delete token.
 */
export const finalizeRunRequestSchema = z.object({
  uploadObjectKey: z.string().min(1),
  visibility: preAuthRunVisibilitySchema,
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
  ownerId: z.string().optional(),
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
