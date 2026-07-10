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
import { CURRENT_SCHEMA_VERSION, INGEST_LIMITS, MIN_FRAME_TIME_MS } from "./constants";

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

export const hardwareSnapshotSchema = z.object({
  gpu: z.string().min(1),
  cpu: z.string().min(1),
  gpuVendor: gpuVendorSchema.optional(),
  ramGb: z.number().positive().optional(),
  ramSpeedMtps: z.number().int().positive().optional(),
  ramRatedSpeedMtps: z.number().int().positive().optional(),
  os: z.string().optional(),
  gpuDriver: z.string().optional(),
  resolution: z.string().optional(),
  canonicalGpuId: z.string().optional(),
  canonicalCpuId: z.string().optional(),
});

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
  schemaVersion: z.number().int().positive(),
  parserVersion: z.string().min(1),
  createdAt: z.string().min(1),
  framesObjectKey: z.string().optional(),
  ownerId: z.string().optional(),
  signatureValid: z.boolean().optional(),
});
export type RunResponse = z.infer<typeof runResponseSchema>;

/** `GET /api/runs/:id/summary` response — just the canonical summary. */
export const runSummaryResponseSchema = runSummarySchema;
export type RunSummaryResponse = z.infer<typeof runSummaryResponseSchema>;
