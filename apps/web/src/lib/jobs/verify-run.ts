/**
 * Verification worker core (§11.5): recompute a run's summary from the stored
 * Parquet — the recompute is CANONICAL; the client's numbers were provisional.
 *
 * Pure-ish on purpose: all I/O comes through `VerifyDeps`, so tests inject a
 * pool and a byte-array `getObject` and never touch live R2. Phase 7 extends
 * this same job with §18 physics checks/outlier handling.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { GENERATED_FRAME_TECH, RUN_STATUS, normalizeMethodologyManifest } from "@heimdall/shared";
import type { CapabilityManifest, DiagnosticFinding, GeneratedFrameTech, RunSummary } from "@heimdall/shared";
import { buildCapabilityManifest, runDiagnostics } from "@heimdall/parsers";
import { readRunForVerification, type Queryable } from "../db";
import { applyVerificationResult, type ClaimedJob } from "../repo/jobs";
import { computeFrameParquetSummary } from "../parquet/frame-metadata";

export interface VerifyDeps {
  db: Queryable;
  /** Bounded object read (the real one caps at MAX_OBJECT_READ_BYTES). */
  getObject(key: string): Promise<Uint8Array>;
  /** Base64 SPKI Ed25519 key; absent → signature_valid stays null (§11.7). */
  publicKeyBase64?: string;
}

export type VerifyOutcome =
  | { kind: "validated" }
  | { kind: "flagged"; reason: string }
  /** Transient (storage hiccup): job goes back to pending. */
  | { kind: "retry"; error: string }
  /** Terminal (corrupt/impossible data): job and finalized run are flagged. */
  | { kind: "failed"; error: string };

/**
 * Float tolerance for client-vs-server summary comparison. The same
 * `computeRunSummary` code runs on both sides over DOUBLE columns, so honest
 * uploads should be bit-identical — the epsilon only absorbs float
 * serialization noise, never tampering.
 */
function floatsMatch(client: number, server: number): boolean {
  return Math.abs(client - server) <= Math.max(1e-9, 1e-6 * Math.abs(server));
}

/** null → summaries agree; otherwise the first mismatching field (for logs). */
export function summaryMismatch(client: RunSummary, server: RunSummary): string | null {
  const exact: (keyof RunSummary)[] = [
    "stutterCount",
    "sampleCount",
    "pointOnePercentLowConfidence",
  ];
  for (const field of exact) {
    if (client[field] !== server[field]) {
      return field;
    }
  }
  const floats: (keyof RunSummary)[] = [
    "avgFps",
    "onePercentLowFps",
    "pointOnePercentLowFps",
    "frameTimeP50Ms",
    "frameTimeP95Ms",
    "frameTimeP99Ms",
    "generatedFramePct",
    "durationSeconds",
  ];
  for (const field of floats) {
    if (!floatsMatch(client[field] as number, server[field] as number)) {
      return field;
    }
  }
  return null;
}

function verifyEd25519(publicKeyBase64: string, data: Uint8Array, signatureBase64: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, data, key, Buffer.from(signatureBase64, "base64"));
  } catch {
    // Malformed key/signature is evidence of nothing — record invalid.
    return false;
  }
}

export async function verifyRunJob(job: ClaimedJob, deps: VerifyDeps): Promise<VerifyOutcome> {
  const { db } = deps;

  const state = await readRunForVerification(job.runId, db);
  if (!state) {
    return { kind: "failed", error: "run row disappeared" };
  }
  const { run, signature, requiredDriver, driverPlatform, driverCatalog } = state;
  if (!run.framesObjectKey) {
    return { kind: "failed", error: "run has no frames object key" };
  }

  let recomputed: RunSummary;
  let signatureValid: boolean | null;
  let findings: DiagnosticFinding[];
  let capabilityManifest: CapabilityManifest;
  {
    let bytes: Uint8Array;
    try {
      bytes = await deps.getObject(run.framesObjectKey);
    } catch (error) {
      // Storage errors are presumed transient; the attempts cap terminalizes
      // a genuinely missing object.
      return { kind: "retry", error: `object read failed: ${String(error)}` };
    }

    try {
      // Validate the full report schema in column chunks, retaining only the
      // scalar buffers needed by the canonical summary and the diagnostics
      // engine. This avoids a large FrameSample object graph for 500k-frame
      // captures.
      const parquet = await computeFrameParquetSummary(bytes);
      recomputed = parquet.summary;

      // Recompute the capability manifest canonically from the stored Parquet —
      // the client-derived manifest (written at insertRun) was provisional, the
      // same way the summary is. Cheap: presence booleans + hardware, no frame
      // arrays retained. Declared capture semantics (presentation/sync mode) that
      // the Parquet can't reveal are preserved from the stored client manifest.
      capabilityManifest = buildCapabilityManifest({
        source: run.captureSource,
        presentSensors: parquet.presentSensors,
        frameGenerationObserved: parquet.frameGenerationObserved,
        hardware: run.hardware,
        ...(run.capabilityManifest
          ? {
              declared: {
                presentationMode: run.capabilityManifest.presentationMode,
                syncMode: run.capabilityManifest.syncMode,
                vramCapacity: run.capabilityManifest.vramCapacity,
              },
            }
          : {}),
      });

      // Keep the per-frame typed arrays scoped to this block. At 500k frames
      // they can hold up to 16 MiB; only compact findings need to survive the
      // subsequent awaited database write.
      findings = runDiagnostics({
        summary: recomputed,
        hardware: run.hardware,
        source: run.captureSource,
        vendor: run.hardware.gpuVendor ?? "unknown",
        ...(requiredDriver !== null ? { game: { requiredDriver } } : {}),
        ...(driverPlatform !== null ? { driverPlatform } : {}),
        ...(driverCatalog !== null ? { driverCatalog } : {}),
        frames: parquet.diagnosticsColumns,
        capabilityManifest,
      });
    } catch (error) {
      return { kind: "failed", error: `unreadable parquet: ${String(error)}` };
    }

    signatureValid =
      deps.publicKeyBase64 && signature
        ? verifyEd25519(deps.publicKeyBase64, bytes, signature)
        : null;
  }
  // The bounded R2 payload goes out of scope before the database write on a
  // large run; only the recomputed summary, compact findings, and signature
  // verdict remain.

  const mismatch = summaryMismatch(run.summary, recomputed);
  const status = mismatch === null && run.status !== RUN_STATUS.flagged ? "validated" : "flagged";
  const generatedFrameTech: GeneratedFrameTech =
    recomputed.generatedFramePct === 0
      ? GENERATED_FRAME_TECH.none
      : run.generatedFrameTech === GENERATED_FRAME_TECH.none ||
          run.generatedFrameTech === GENERATED_FRAME_TECH.unknown
        ? GENERATED_FRAME_TECH.unknown
        : run.generatedFrameTech;
  const methodologyManifest = normalizeMethodologyManifest(
    run.methodologyManifest,
    run.hardware,
    generatedFrameTech,
  );

  // Either way the recompute becomes the stored truth — "corrected and
  // flagged" (§12.4) is exactly the flagged arm of this write. Findings land in
  // the same atomic write.
  await applyVerificationResult(
    job.runId,
    {
      summary: recomputed,
      runStatus: status,
      signatureValid,
      diagnostics: findings,
      capabilityManifest,
      methodologyManifest: methodologyManifest ?? null,
      generatedFrameTech,
    },
    job,
    db,
  );

  return status === "validated"
    ? { kind: "validated" }
    : {
        kind: "flagged",
        reason:
          mismatch === null
            ? "run was already flagged by a prior verification attempt"
            : `client summary mismatch on ${mismatch}`,
      };
}
