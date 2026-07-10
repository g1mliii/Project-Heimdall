/**
 * Cloudflare R2 object storage (Phase 2 §5) — per-frame Parquet + (Phase 11)
 * video exports. R2 speaks the S3 API; the client points at the account
 * endpoint with region "auto".
 *
 * Browser direct-uploads (§11.3) use `presignPut` so raw files never transit
 * the API; the dashboard reads frames via `presignGet`. `headObject` backs the
 * §11.10 exists/size validation before finalize. Bucket CORS for the presigned
 * PUT path is configured out-of-band — see infra/r2/README.md.
 *
 * Server-only: never import from a client component.
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getR2Env } from "./env";

/* ── Object keys ────────────────────────────────────────────────────────── */

// Single definition lives in @heimdall/shared (the browser PUT needs it too);
// re-exported here so server code keeps importing it from the R2 module.
export { PARQUET_CONTENT_TYPE } from "@heimdall/shared";
import { INGEST_LIMITS, PARQUET_CONTENT_TYPE } from "@heimdall/shared";
import { RUN_ID_PATTERN } from "./ids";
export const MAX_PRESIGNED_PUT_BYTES = 512 * 1024 * 1024;
// Derived, not re-declared: the worker must always be able to read back an
// object the API accepted, so the read cap IS the ingest cap.
export const MAX_OBJECT_READ_BYTES: number = INGEST_LIMITS.maxParquetBytes;

function assertSafeObjectKey(key: string): void {
  if (
    !/^(runs|staging\/runs|exports)\/[A-Za-z0-9._/-]+$/.test(key) ||
    key.includes("..") ||
    key.includes("//") ||
    key.includes("\\")
  ) {
    throw new Error(`invalid R2 object key: ${JSON.stringify(key)}`);
  }
}

function assertPositiveBoundedByteLength(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_PRESIGNED_PUT_BYTES) {
    throw new Error(
      `${label} must be an integer between 1 and ${MAX_PRESIGNED_PUT_BYTES} bytes`,
    );
  }
}

/**
 * R2 key for a run's per-frame Parquet blob. Rejects ids that could escape the
 * runs/ prefix ("/", "..", whitespace) — defense in depth even though run ids
 * are app-generated.
 */
function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`invalid run id for object key: ${JSON.stringify(runId)}`);
  }
}

/** Browser-writable staging key. It is never exposed as a finalized run object. */
export function framesUploadObjectKey(runId: string): string {
  assertRunId(runId);
  return `staging/runs/${runId}.parquet`;
}

/**
 * Server-only finalized key. The nonce prevents concurrent finalize attempts
 * from ever overwriting each other's immutable copy.
 */
export function finalizedFramesObjectKey(
  runId: string,
  nonce = crypto.randomUUID().replaceAll("-", ""),
): string {
  assertRunId(runId);
  if (!/^[0-9a-f]{32}$/.test(nonce)) {
    throw new Error(`invalid finalized object nonce: ${JSON.stringify(nonce)}`);
  }
  return `runs/${runId}/${nonce}.parquet`;
}

/** R2 key prefix reserved for Phase 11 video exports (§5.2). */
export const EXPORTS_PREFIX = "exports/";

/* ── Client ─────────────────────────────────────────────────────────────── */

// Same hot-reload guard rationale as the pg pool in db.ts.
const globalForR2 = globalThis as typeof globalThis & { __heimdallR2Client?: S3Client };

export function getR2Client(): S3Client {
  const env = getR2Env();
  globalForR2.__heimdallR2Client ??= new S3Client({
    region: "auto",
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
  return globalForR2.__heimdallR2Client;
}

const bucket = () => getR2Env().R2_BUCKET;

/* ── Presigned URLs (bounded TTLs — links must expire, not linger) ──────── */

/** Browser direct-upload window (§11.2/§11.3): long enough for a slow-link Parquet PUT. */
const PUT_TTL_SECONDS = 15 * 60;
/** Dashboard read window (§5.1): a page view, not a durable share link. */
export const GET_TTL_SECONDS = 60 * 60;

interface PresignPutOptions {
  contentLengthBytes: number;
  contentType?: string;
}

/**
 * Presigned browser PUT. Pass `contentLengthBytes` (Phase 4 §11.10 will make it
 * required) to bind the expected body size. The AWS S3 presigner intentionally
 * leaves Content-Type unsigned, so finalize (§11.4/§11.10) must HEAD-validate
 * metadata. The signed key is staging-only; finalize copies the exact HEADed
 * version to a server-only key before exposing it.
 */
export async function presignPut(
  key: string,
  { contentLengthBytes, contentType = PARQUET_CONTENT_TYPE }: PresignPutOptions,
): Promise<string> {
  assertSafeObjectKey(key);
  assertPositiveBoundedByteLength(contentLengthBytes, "contentLengthBytes");
  return getSignedUrl(
    getR2Client(),
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: contentType,
      ContentLength: contentLengthBytes,
    }),
    { expiresIn: PUT_TTL_SECONDS },
  );
}

export async function presignGet(key: string): Promise<string> {
  assertSafeObjectKey(key);
  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
    { expiresIn: GET_TTL_SECONDS },
  );
}

/* ── Server-side object helpers ─────────────────────────────────────────── */

export async function putObject(
  key: string,
  body: Uint8Array,
  contentType = PARQUET_CONTENT_TYPE,
): Promise<void> {
  assertSafeObjectKey(key);
  assertPositiveBoundedByteLength(body.byteLength, "body.byteLength");
  await getR2Client().send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

export async function getObject(
  key: string,
  { maxBytes = MAX_OBJECT_READ_BYTES }: { maxBytes?: number } = {},
): Promise<Uint8Array> {
  assertSafeObjectKey(key);
  assertPositiveBoundedByteLength(maxBytes, "maxBytes");
  const result = await getR2Client().send(
    new GetObjectCommand({ Bucket: bucket(), Key: key }),
  );
  if ((result.ContentLength ?? 0) > maxBytes) {
    throw new Error(`R2 object ${key} is too large to buffer (${result.ContentLength} bytes)`);
  }
  if (!result.Body) {
    throw new Error(`R2 object ${key} has no body`);
  }
  const bytes = await result.Body.transformToByteArray();
  if (bytes.byteLength > maxBytes) {
    throw new Error(`R2 object ${key} exceeded buffered read limit (${bytes.byteLength} bytes)`);
  }
  return bytes;
}

/** Object metadata, or null when the key does not exist (§11.10 pre-finalize check). */
export async function headObject(
  key: string,
): Promise<{ sizeBytes: number; etag: string } | null> {
  assertSafeObjectKey(key);
  try {
    const result = await getR2Client().send(
      new HeadObjectCommand({ Bucket: bucket(), Key: key }),
    );
    if (!result.ETag) {
      throw new Error(`R2 object ${key} has no ETag`);
    }
    return { sizeBytes: result.ContentLength ?? 0, etag: result.ETag };
  } catch (error) {
    if (error instanceof Error && error.name === "NotFound") {
      return null;
    }
    throw error;
  }
}

/**
 * Promote the exact staging version validated by HEAD into an immutable,
 * server-only key. CopySourceIfMatch closes the HEAD/copy race: if the browser
 * overwrites staging in between, R2 rejects the copy.
 */
export async function copyObject(
  sourceKey: string,
  destinationKey: string,
  { sourceEtag }: { sourceEtag: string },
): Promise<boolean> {
  assertSafeObjectKey(sourceKey);
  assertSafeObjectKey(destinationKey);
  try {
    await getR2Client().send(
      new CopyObjectCommand({
        Bucket: bucket(),
        Key: destinationKey,
        CopySource: `${bucket()}/${sourceKey}`,
        CopySourceIfMatch: sourceEtag,
        ContentType: PARQUET_CONTENT_TYPE,
        MetadataDirective: "REPLACE",
      }),
    );
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "PreconditionFailed" ||
        ("$metadata" in error &&
          (error as Error & { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode === 412))
    ) {
      return false;
    }
    throw error;
  }
}

/** Delete a run's stored object (anonymous-token delete + §20.4 erasure paths). */
export async function deleteObject(key: string): Promise<void> {
  assertSafeObjectKey(key);
  await getR2Client().send(
    new DeleteObjectCommand({ Bucket: bucket(), Key: key }),
  );
}
