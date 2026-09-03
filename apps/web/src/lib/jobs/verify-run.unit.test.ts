import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FRAME_PARQUET_COLUMNS, INGEST_LIMITS, finalizeRunRequestSchema } from "@heimdall/shared";
import type { RunSummary } from "@heimdall/shared";
import { validateFrameParquetMetadata } from "../parquet/frame-metadata";
import { summaryMismatch } from "./verify-run";

function metadata(
  rowCount: bigint,
  rowGroupCounts: bigint[] = [rowCount],
  uncompressedSize = 1n,
) {
  return {
    num_rows: rowCount,
    row_groups: rowGroupCounts.map((num_rows) => ({
      num_rows,
      total_byte_size: 0n,
      columns: FRAME_PARQUET_COLUMNS.map((column) =>
        ({
          meta_data: {
            path_in_schema: [column.name],
            type: column.type,
            num_values: num_rows,
            total_uncompressed_size: uncompressedSize,
          },
        }) as never,
      ),
    })),
  };
}

describe("validateFrameParquetMetadata", () => {
  it.each([
    BigInt(INGEST_LIMITS.minFramesPerRun - 1),
    BigInt(INGEST_LIMITS.maxFramesPerRun + 1),
  ])("rejects an out-of-range metadata row count before row decoding: %s", (rowCount) => {
    expect(() => validateFrameParquetMetadata(metadata(rowCount))).toThrow(/outside ingest limits/);
  });

  it("rejects metadata whose row groups disagree with the declared total", () => {
    expect(() => validateFrameParquetMetadata(metadata(16n, [8n, 7n]))).toThrow(/disagrees with row groups/);
  });

  it("returns the declared count once it is safe to materialize", () => {
    expect(validateFrameParquetMetadata(metadata(16n, [4n, 12n]))).toBe(16);
  });

  it("rejects oversized physical frame columns before decoding", () => {
    expect(() =>
      validateFrameParquetMetadata(metadata(16n, [16n], BigInt(INGEST_LIMITS.maxParquetBytes))),
    ).toThrow(/decoded-byte limit/);
  });
});

/**
 * Cross-language signature contract (§22.3).
 *
 * The desktop client signs in Rust (`ed25519-dalek`); this server verifies in
 * Node. The two implementations never meet at runtime, so an encoding drift on
 * either side would surface only as every desktop run silently recording
 * `signature_valid: false` — evidence quietly turning into noise.
 *
 * The constants below are a golden vector PRODUCED BY the Rust implementation
 * and pinned there too (`apps/desktop/src-tauri/src/signing.rs`, `mod vector`).
 * Neither side can be changed without the other failing. This asserts the exact
 * primitives `verifyEd25519` uses in verify-run.ts — base64 DER SPKI key, raw
 * (not prehashed) Ed25519, base64 signature.
 */
describe("desktop client signature format (§22.3)", () => {
  const PAYLOAD = Buffer.from("PAR1heimdall-desktop-signature-vector-v1PAR1");
  const SPKI_BASE64 = "MCowBQYDK2VwAyEA6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iw=";
  const SIGNATURE_BASE64 =
    "OvYTS1iE8BLlqaiIHb4f4/I/eay8Bp1C6g5uW90Q47bJecqybaDNGSzvGXHvv173r0UW8l2H6iEoSxVtRLk0CQ==";

  const publicKey = () =>
    createPublicKey({ key: Buffer.from(SPKI_BASE64, "base64"), format: "der", type: "spki" });

  it("verifies a signature produced by the Rust client", () => {
    expect(
      cryptoVerify(null, PAYLOAD, publicKey(), Buffer.from(SIGNATURE_BASE64, "base64")),
    ).toBe(true);
  });

  it("fits the 512-char bound finalizeRunRequestSchema enforces", () => {
    // Raw Ed25519 is 64 bytes → 88 base64 chars. A switch to any enveloped
    // format would blow past the wire limit and fail finalize outright.
    expect(SIGNATURE_BASE64).toHaveLength(88);
    expect(finalizeRunRequestSchema.shape.signature.safeParse(SIGNATURE_BASE64).success).toBe(true);
  });

  it("rejects the same signature over one flipped byte", () => {
    const tampered = Buffer.from(PAYLOAD);
    tampered.writeUInt8(tampered.readUInt8(4) ^ 0x01, 4);
    expect(
      cryptoVerify(null, tampered, publicKey(), Buffer.from(SIGNATURE_BASE64, "base64")),
    ).toBe(false);
  });
});

describe("§22.12 does not move the §11.5 integrity gate", () => {
  /**
   * Phase 9.6's decision 1, asserted rather than asserted-in-prose. The
   * rendered-frame analysis is a SECOND statistic over the same frames; it must
   * never influence whether a run validates or flags. A future reader looking
   * at two recompute paths side by side is most likely to "fix" this by feeding
   * the rendered numbers into the comparison — at which point every honest
   * frame-generated upload starts flagging.
   */
  const presented: RunSummary = {
    avgFps: 238.0952380952381,
    onePercentLowFps: 125,
    pointOnePercentLowFps: 125,
    frameTimeP50Ms: 0.4,
    frameTimeP95Ms: 8,
    frameTimeP99Ms: 8,
    stutterCount: 0,
    generatedFramePct: 0.5,
    pointOnePercentLowConfidence: "low",
    sampleCount: 24,
    durationSeconds: 0.1008,
  };
  /** The same capture's rendered rate — roughly half, and irrelevant here. */
  const rendered: RunSummary = {
    ...presented,
    avgFps: 119.04761904761905,
    onePercentLowFps: 119.04761904761905,
    pointOnePercentLowFps: 119.04761904761905,
    frameTimeP50Ms: 8.4,
    frameTimeP95Ms: 8.4,
    frameTimeP99Ms: 8.4,
    generatedFramePct: 0,
    sampleCount: 11,
    durationSeconds: 0.0924,
  };

  it("agrees on a frame-generated run whose client and server summaries match", () => {
    // Half this run's presents are interpolated. It still validates, because
    // the client and the server computed the same presented summary.
    expect(summaryMismatch(presented, presented)).toBeNull();
  });

  it("still catches tampering on a frame-generated run", () => {
    expect(summaryMismatch({ ...presented, avgFps: 300 }, presented)).toBe("avgFps");
    expect(summaryMismatch({ ...presented, stutterCount: 5 }, presented)).toBe("stutterCount");
  });

  it("would flag every frame-generated run if the two summaries were ever crossed", () => {
    // The guard's whole point: these two are wildly different by design, so a
    // comparison that accidentally reached across them cannot silently pass.
    expect(summaryMismatch(presented, rendered)).not.toBeNull();
    expect(summaryMismatch(rendered, presented)).not.toBeNull();
  });

  it("compares generatedFramePct on the presented summary only", () => {
    // A rendered summary reports 0% by construction. If that value ever reached
    // this comparison, an honest 50%-generated upload would mismatch here.
    expect(presented.generatedFramePct).toBe(0.5);
    expect(rendered.generatedFramePct).toBe(0);
    expect(summaryMismatch(presented, presented)).toBeNull();
  });
});
