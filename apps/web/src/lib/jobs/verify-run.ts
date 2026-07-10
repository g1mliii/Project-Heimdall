/**
 * Verification worker core (§11.5): recompute a run's summary from the stored
 * Parquet — the recompute is CANONICAL; the client's numbers were provisional.
 *
 * Pure-ish on purpose: all I/O comes through `VerifyDeps`, so tests inject a
 * pool and a byte-array `getObject` and never touch live R2. Phase 7 extends
 * this same job with §18 physics checks/outlier handling.
 */

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { parquetMetadata, parquetReadObjects } from "hyparquet";
import type { FileMetaData } from "hyparquet";
import { computeRunSummary } from "@heimdall/parsers";
import { FRAME_PARQUET_COLUMNS, INGEST_LIMITS, rowsToFrameSamples } from "@heimdall/shared";
import type { RunSummary } from "@heimdall/shared";
import { readRun, type Queryable } from "../db";
import { readRunSignature } from "../repo/runs";
import { applyVerificationResult, type ClaimedJob } from "../repo/jobs";

const FRAME_PARQUET_COLUMN_NAMES = FRAME_PARQUET_COLUMNS.map((column) => column.name);
const MAX_DECODED_FRAME_PARQUET_BYTES = BigInt(INGEST_LIMITS.maxParquetBytes);

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

/** Reject oversized or internally inconsistent captures before decoding rows. */
export function frameCountFromMetadata(
  metadata: Pick<FileMetaData, "num_rows" | "row_groups">,
): number {
  const rowCount = metadata.num_rows;
  const min = BigInt(INGEST_LIMITS.minFramesPerRun);
  const max = BigInt(INGEST_LIMITS.maxFramesPerRun);
  if (rowCount < min || rowCount > max) {
    throw new Error(`frame count ${rowCount} outside ingest limits`);
  }
  const rowGroupCount = metadata.row_groups.reduce((total, group) => total + group.num_rows, 0n);
  if (rowCount !== rowGroupCount) {
    throw new Error(`parquet metadata row count ${rowCount} disagrees with row groups ${rowGroupCount}`);
  }
  return Number(rowCount);
}

/** Reject malformed physical frame columns before the reader decodes page data. */
export function validateFrameParquetMetadata(
  metadata: Pick<FileMetaData, "num_rows" | "row_groups">,
): number {
  const frameCount = frameCountFromMetadata(metadata);
  let uncompressedBytes = 0n;
  for (const rowGroup of metadata.row_groups) {
    const columns = new Map(
      rowGroup.columns.flatMap((chunk) =>
        chunk.meta_data ? [[chunk.meta_data.path_in_schema[0], chunk.meta_data] as const] : [],
      ),
    );
    for (const frameColumn of FRAME_PARQUET_COLUMNS) {
      const column = columns.get(frameColumn.name);
      if (!column) {
        throw new Error(`parquet is missing required column ${frameColumn.name}`);
      }
      if (column.type !== frameColumn.type || column.num_values !== rowGroup.num_rows) {
        throw new Error(`parquet column ${frameColumn.name} has an invalid physical layout`);
      }
      uncompressedBytes += column.total_uncompressed_size;
      if (uncompressedBytes > MAX_DECODED_FRAME_PARQUET_BYTES) {
        throw new Error(`parquet frame columns exceed decoded-byte limit ${MAX_DECODED_FRAME_PARQUET_BYTES}`);
      }
    }
  }
  return frameCount;
}

export async function verifyRunJob(job: ClaimedJob, deps: VerifyDeps): Promise<VerifyOutcome> {
  const { db } = deps;

  const [run, stored] = await Promise.all([
    readRun(job.runId, db),
    readRunSignature(job.runId, db),
  ]);
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
    const metadata = parquetMetadata(buffer);
    const frameCount = validateFrameParquetMetadata(metadata);
    const rows = await parquetReadObjects({
      file: buffer,
      metadata,
      columns: FRAME_PARQUET_COLUMN_NAMES,
      rowEnd: frameCount,
    });
    const frames = rowsToFrameSamples(rows);
    if (frames.length !== frameCount) {
      return { kind: "failed", error: `decoded ${frames.length} frames but metadata declared ${frameCount}` };
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
  await applyVerificationResult(job.runId, recomputed, status, signatureValid, job, db);

  return mismatch === null
    ? { kind: "validated" }
    : { kind: "flagged", reason: `client summary mismatch on ${mismatch}` };
}
