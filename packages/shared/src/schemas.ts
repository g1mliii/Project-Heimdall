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
import { CURRENT_SCHEMA_VERSION } from "./constants";

/* ── Primitive enums (kept in lockstep with the domain unions in types.ts) ── */

export const captureSourceSchema = z.enum(["presentmon", "mangohud", "capframex"]);
export const generatedFrameTechSchema = z.enum(["none", "dlss3", "fsr3", "xess"]);
export const gpuVendorSchema = z.enum(["nvidia", "amd", "intel", "unknown"]);
export const confidenceLevelSchema = z.enum(["high", "medium", "low"]);
export const diagnosticSeveritySchema = z.enum(["good", "warn", "bad", "info"]);

export const runVisibilitySchema = z.enum([
  RUN_VISIBILITY.private,
  RUN_VISIBILITY.unlisted,
  RUN_VISIBILITY.public,
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
  ramSpeedMtps: z.number().positive().optional(),
  ramRatedSpeedMtps: z.number().positive().optional(),
  os: z.string().optional(),
  gpuDriver: z.string().optional(),
  resolution: z.string().optional(),
  canonicalGpuId: z.string().optional(),
  canonicalCpuId: z.string().optional(),
});

export const frameSampleSchema = z.object({
  timeMs: z.number().min(0),
  frameTimeMs: z.number().positive(),
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
export const createRunRequestSchema = z.object({
  game: z.string().trim().min(1),
  captureSource: captureSourceSchema,
  visibility: runVisibilitySchema.default(RUN_VISIBILITY.unlisted),
  hardware: hardwareSnapshotSchema,
  summary: runSummarySchema,
  generatedFrameTech: generatedFrameTechSchema.default("none"),
  ...provenance,
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

/** `POST /api/runs` response — the created id + the presigned R2 PUT URL. */
export const createRunResponseSchema = z.object({
  id: z.string().min(1),
  uploadUrl: z.string().url(),
  framesObjectKey: z.string().min(1),
});
export type CreateRunResponse = z.infer<typeof createRunResponseSchema>;

/**
 * `POST /api/runs/:id/finalize` — record summary metadata, the explicit
 * visibility choice, and (for anonymous runs) a hashed management/delete token.
 */
export const finalizeRunRequestSchema = z.object({
  framesObjectKey: z.string().min(1),
  visibility: runVisibilitySchema,
  managementTokenHash: z.string().optional(),
  // NOTE: `signatureValid` is intentionally NOT accepted here. It is server-derived
  // evidence (set from the API's own signature verification, §11.7) and lives only on
  // the response/Run shape — never trust a client-asserted value. Invariant: integrity
  // is server-side.
});
export type FinalizeRunRequest = z.infer<typeof finalizeRunRequestSchema>;

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
