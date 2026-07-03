/**
 * Storage regression coverage — R2 (IMPLEMENTATION_PLAN §6.2).
 *
 * Key construction is pure and always tested. The live object round-trip needs
 * real R2 credentials (Testcontainers has no R2 analog); without them it skips
 * loudly. Run locally with a populated .env to exercise the real bucket.
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import { validRun } from "@heimdall/shared";
import {
  EXPORTS_PREFIX,
  MAX_OBJECT_READ_BYTES,
  MAX_PRESIGNED_PUT_BYTES,
  PARQUET_CONTENT_TYPE,
  deleteObject,
  framesObjectKey,
  getObject,
  headObject,
  presignGet,
  presignPut,
  putObject,
} from "./r2";

describe("r2 object keys", () => {
  it("frames key matches the shared fixture's framesObjectKey (no drift)", () => {
    expect(framesObjectKey(validRun.id)).toBe(validRun.framesObjectKey);
  });

  it("reserves the exports/ prefix for Phase 11", () => {
    expect(EXPORTS_PREFIX).toBe("exports/");
  });

  it("uses the Parquet content type for frame objects", () => {
    expect(PARQUET_CONTENT_TYPE).toBe("application/vnd.apache.parquet");
  });

  it("rejects run ids that could escape the runs/ prefix", () => {
    for (const bad of ["../exports/x", "a/b", "a b", "", "a\nb"]) {
      expect(() => framesObjectKey(bad), bad).toThrow(/invalid run id/);
    }
  });

  it("signs Content-Length when a browser PUT size is supplied", async () => {
    vi.resetModules();
    vi.stubEnv("R2_ACCOUNT_ID", "accountid");
    vi.stubEnv("R2_ACCESS_KEY_ID", "accesskey");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secretkey");
    vi.stubEnv("R2_BUCKET", "bucket");
    delete (globalThis as { __heimdallR2Client?: unknown }).__heimdallR2Client;
    try {
      const r2 = await import("./r2");
      const url = new URL(
        await r2.presignPut(framesObjectKey(validRun.id), { contentLengthBytes: 123 }),
      );
      expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain(
        "content-length",
      );
    } finally {
      delete (globalThis as { __heimdallR2Client?: unknown }).__heimdallR2Client;
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("rejects unsafe object keys and unbounded upload sizes before signing", async () => {
    vi.resetModules();
    vi.stubEnv("R2_ACCOUNT_ID", "accountid");
    vi.stubEnv("R2_ACCESS_KEY_ID", "accesskey");
    vi.stubEnv("R2_SECRET_ACCESS_KEY", "secretkey");
    vi.stubEnv("R2_BUCKET", "bucket");
    delete (globalThis as { __heimdallR2Client?: unknown }).__heimdallR2Client;
    try {
      const r2 = await import("./r2");
      await expect(
        r2.presignPut("../secrets.parquet", { contentLengthBytes: 1 }),
      ).rejects.toThrow(/invalid R2 object key/);
      await expect(
        r2.presignPut(framesObjectKey(validRun.id), {
          contentLengthBytes: MAX_PRESIGNED_PUT_BYTES + 1,
        }),
      ).rejects.toThrow(/contentLengthBytes/);
      expect(MAX_OBJECT_READ_BYTES).toBeLessThan(MAX_PRESIGNED_PUT_BYTES);
    } finally {
      delete (globalThis as { __heimdallR2Client?: unknown }).__heimdallR2Client;
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

const hasR2Creds = Boolean(
  process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
);
if (!hasR2Creds) {
  if (process.env.CI) {
    throw new Error(
      "[r2.test] no R2 credentials in CI — provide R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, " +
        "R2_SECRET_ACCESS_KEY, and R2_BUCKET; refusing to silently skip live bucket coverage.",
    );
  }
  console.warn(
    "[r2.test] live round-trip SKIPPED: R2_* env vars not set — populate .env to run it.",
  );
}

describe.skipIf(!hasR2Creds)("r2 live round-trip (§6.2)", () => {
  const key = `runs/test_${process.pid}_${Date.now()}.parquet`;
  const presignedKey = `${key}.presigned`;
  const bytes = new TextEncoder().encode("heimdall phase-2 round-trip fixture");

  afterAll(async () => {
    await Promise.all(
      [key, presignedKey].map((k) => deleteObject(k).catch(() => {})),
    );
  });

  it("put → head → get returns identical bytes", async () => {
    await putObject(key, bytes);
    const head = await headObject(key);
    expect(head?.sizeBytes).toBe(bytes.byteLength);
    expect(await getObject(key)).toEqual(bytes);
  });

  it("presigned PUT then presigned GET round-trips through plain fetch (§5.1)", async () => {
    const putUrl = await presignPut(presignedKey, { contentLengthBytes: bytes.byteLength });
    const putResponse = await fetch(putUrl, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": PARQUET_CONTENT_TYPE },
    });
    expect(putResponse.ok).toBe(true);

    const getUrl = await presignGet(presignedKey);
    const getResponse = await fetch(getUrl);
    expect(getResponse.ok).toBe(true);
    expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(bytes);
  });

  it("headObject returns null for a missing key (§11.10)", async () => {
    expect(await headObject("runs/definitely-missing.parquet")).toBeNull();
  });
});
