import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FRAME_PARQUET_COLUMNS, INGEST_LIMITS, finalizeRunRequestSchema } from "@heimdall/shared";
import { validateFrameParquetMetadata } from "../parquet/frame-metadata";
import { reconcileGeneratedFrameTech } from "./verify-run";

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

/**
 * Frame-generation reconciliation (§11.5, §22.11).
 *
 * The rule that matters: `none` is a positive claim and must be earned by
 * evidence. Before this, a capture format that cannot report frame type
 * produced `none` anyway — so an AMD run with frame generation on went out as
 * "no frame generation" at roughly twice its real rendering rate.
 */
describe("reconcileGeneratedFrameTech", () => {
  const EVIDENCE = true;
  const NO_EVIDENCE = false;

  describe("with frame-type evidence in the capture", () => {
    it("reports none when the frames show no generation, whatever was declared", () => {
      expect(reconcileGeneratedFrameTech("fsr3", 0, EVIDENCE)).toBe("none");
      expect(reconcileGeneratedFrameTech("none", 0, EVIDENCE)).toBe("none");
    });

    it("names the declared tech once the frames corroborate generation", () => {
      expect(reconcileGeneratedFrameTech("fsr3", 0.5, EVIDENCE)).toBe("fsr3");
    });

    it("falls back to unknown when frames are generated but nothing names the tech", () => {
      expect(reconcileGeneratedFrameTech("none", 0.5, EVIDENCE)).toBe("unknown");
      expect(reconcileGeneratedFrameTech("unknown", 0.5, EVIDENCE)).toBe("unknown");
    });
  });

  describe("without frame-type evidence", () => {
    it("never claims none — that would assert absence from absence of evidence", () => {
      expect(reconcileGeneratedFrameTech("none", 0, NO_EVIDENCE)).toBe("unknown");
    });

    it("takes the uploader's declaration at face value", () => {
      // Same trust level as `upscaler` or `settingsPreset`: unverifiable
      // declarations that are already comparability key fields.
      expect(reconcileGeneratedFrameTech("fsr3", 0, NO_EVIDENCE)).toBe("fsr3");
      expect(reconcileGeneratedFrameTech("dlss3", 0, NO_EVIDENCE)).toBe("dlss3");
    });

    it("keeps unknown as unknown", () => {
      expect(reconcileGeneratedFrameTech("unknown", 0, NO_EVIDENCE)).toBe("unknown");
    });
  });

  it("defaults to assuming evidence, so existing callers keep the old behaviour", () => {
    expect(reconcileGeneratedFrameTech("none", 0)).toBe("none");
  });
});
