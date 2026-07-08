/**
 * Verification worker core (§11.5): recompute a run's summary from the stored
 * Parquet — the recompute is CANONICAL; the client's numbers were provisional.
 *
 * Pure-ish on purpose: all I/O comes through `VerifyDeps`, so tests inject a
 * pool and a byte-array `getObject` and never touch live R2. Phase 7 extends
 * this same job with §18 physics checks/outlier handling.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { parquetReadObjects } from "hyparquet";
import { computeRunSummary } from "@heimdall/parsers";
import { INGEST_LIMITS, rowsToFrameSamples } from "@heimdall/shared";
import type { RunSummary } from "@heimdall/shared";
import { getPool, readRun, type Queryable } from "../db";
import { readRunSignature } from "../repo/runs";
import { applyVerificationResult, type ClaimedJob } from "../repo/jobs";

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
  /** Terminal (corrupt/impossible data): job is failed, run stays pending. */
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
  const db = deps.db ?? getPool();

  const run = await readRun(job.runId, db);
  const stored = await readRunSignature(job.runId, db);
  if (!run || !stored) {
    return { kind: "failed", error: "run row disappeared" };
  }
  if (!stored.framesObjectKey) {
    return { kind: "failed", error: "run has no frames object key" };
  }

  let bytes: Uint8Array;
  try {
    bytes = await deps.getObject(stored.framesObjectKey);
  } catch (error) {
    // Storage errors are presumed transient; the attempts cap terminalizes
    // a genuinely missing object.
    return { kind: "retry", error: `object read failed: ${String(error)}` };
  }

  let recomputed: RunSummary;
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const rows = await parquetReadObjects({ file: buffer });
    const frames = rowsToFrameSamples(rows);
    if (
      frames.length < INGEST_LIMITS.minFramesPerRun ||
      frames.length > INGEST_LIMITS.maxFramesPerRun
    ) {
      return { kind: "failed", error: `frame count ${frames.length} outside ingest limits` };
    }
    recomputed = computeRunSummary(frames);
  } catch (error) {
    return { kind: "failed", error: `unreadable parquet: ${String(error)}` };
  }

  const signatureValid =
    deps.publicKeyBase64 && stored.signature
      ? verifyEd25519(deps.publicKeyBase64, bytes, stored.signature)
      : null;

  const mismatch = summaryMismatch(run.summary, recomputed);
  const status = mismatch === null ? "validated" : "flagged";
  // Either way the recompute becomes the stored truth — "corrected and
  // flagged" (§12.4) is exactly the flagged arm of this write.
  await applyVerificationResult(job.runId, recomputed, status, signatureValid, db);

  return mismatch === null
    ? { kind: "validated" }
    : { kind: "flagged", reason: `client summary mismatch on ${mismatch}` };
}
