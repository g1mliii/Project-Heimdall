/**
 * POST /api/runs/:id/finalize (§11.4) — after the browser's direct-to-R2 PUT:
 * HEAD-validate the object (§11.10), resolve canonical game/hardware ids
 * (§11.9), record visibility + hashed management token + optional signature,
 * and enqueue the durable verification job — atomically with the finalize
 * (§11.5). A best-effort, one-job drain kick follows; the bounded cron/CLI
 * worker remains the durable fallback when that process cannot finish.
 */

import { NextResponse } from "next/server";
import {
  INGEST_LIMITS,
  RUN_STATUS,
  UNKNOWN_HARDWARE,
  finalizeRunRequestSchema,
} from "@heimdall/shared";
import type { FinalizeRunResponse } from "@heimdall/shared";
import { isUniqueViolation, readRun } from "@/lib/db";
import { isRunId } from "@/lib/ids";
import { finalizeRun, readRunFinalizeState } from "@/lib/repo/runs";
import { resolveGameId, resolveHardwareId } from "@/lib/repo/catalog";
import { drainJobs } from "@/lib/jobs/drain";
import {
  copyObject,
  deleteObject,
  finalizedFramesObjectKey,
  framesUploadObjectKey,
  headObject,
  stagingCleanupNotBefore,
} from "@/lib/r2";
import { jsonError, parseJsonBody, rateLimits, requireRateLimit } from "@/lib/api/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

class FinalizedCopyCleanupError extends Error {
  override readonly cause: unknown;

  constructor(id: string, key: string, context: string, cause: unknown) {
    super(`finalize ${id}: ${context} cleanup failed for ${key}`);
    this.name = "FinalizedCopyCleanupError";
    this.cause = cause;
  }
}

async function cleanupFinalizedCopy(id: string, key: string, context: string): Promise<void> {
  try {
    await deleteObject(key);
  } catch (error) {
    throw new FinalizedCopyCleanupError(id, key, context, error);
  }
}

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const limited = await requireRateLimit("finalize-run", request, rateLimits().finalize);
    if (limited) {
      return limited;
    }

    const { id } = await context.params;
    if (!isRunId(id)) {
      return jsonError(404, "not-found", "run not found");
    }
    const body = await parseJsonBody(request, finalizeRunRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    // The object key is derived from the id — a client naming any other key
    // could hijack someone else's upload slot.
    const expectedUploadKey = framesUploadObjectKey(id);
    if (body.uploadObjectKey !== expectedUploadKey) {
      return jsonError(403, "key-mismatch", "uploadObjectKey does not belong to this run");
    }

    const run = await readRun(id, undefined, { withDiagnostics: false });
    if (!run) {
      return jsonError(404, "not-found", "run not found");
    }
    if (run.status !== RUN_STATUS.pending || run.framesObjectKey) {
      return jsonError(409, "already-finalized", "run was already finalized");
    }

    // §11.10: the object must exist and fit before we commit to it. The
    // presigner can't sign Content-Type, so size + recompute-from-storage are
    // the real guards.
    const head = await headObject(expectedUploadKey);
    if (!head) {
      return jsonError(409, "object-missing", "upload the parquet before finalizing");
    }
    if (head.sizeBytes > INGEST_LIMITS.maxParquetBytes) {
      await deleteObject(expectedUploadKey);
      return jsonError(413, "object-too-large", "uploaded parquet exceeds the size limit");
    }

    // §11.9 canonical resolution — enrichment, never a gate: a failed resolver
    // leaves its id null and the raw strings standing. The three lookups are
    // independent, so they run concurrently and fail independently. The
    // UNKNOWN_HARDWARE placeholders never get canonical rows: a shared
    // "Unknown GPU" bucket would mix unrelated machines into per-hardware
    // aggregates.
    const idOrNull = (settled: PromiseSettledResult<string | null>, what: string) => {
      if (settled.status === "fulfilled") {
        return settled.value;
      }
      console.error(`finalize ${id}: ${what} resolution failed (non-fatal)`, settled.reason);
      return null;
    };
    const [gameSettled, gpuSettled, cpuSettled] = await Promise.allSettled([
      resolveGameId(run.captureSource, run.game),
      run.hardware.gpu === UNKNOWN_HARDWARE.gpu
        ? Promise.resolve(null)
        : resolveHardwareId("gpu", run.captureSource, run.hardware.gpu, run.hardware.gpuVendor ?? null),
      run.hardware.cpu === UNKNOWN_HARDWARE.cpu
        ? Promise.resolve(null)
        : resolveHardwareId("cpu", run.captureSource, run.hardware.cpu, null),
    ]);

    // The browser only ever receives a PUT for the staging key. Promote the
    // exact version HEAD validated into a unique server-only key; a later PUT
    // to staging therefore cannot change verified or downloadable frames.
    const finalizedObjectKey = finalizedFramesObjectKey(id);
    const copied = await copyObject(expectedUploadKey, finalizedObjectKey, {
      sourceEtag: head.etag,
    });
    if (!copied) {
      return jsonError(
        409,
        "upload-changed",
        "uploaded parquet changed during finalize — retry finalize",
      );
    }

    let finalized: boolean;
    try {
      finalized = await finalizeRun({
        id,
        framesObjectKey: finalizedObjectKey,
        stagingCleanup: {
          objectKey: expectedUploadKey,
          notBefore: stagingCleanupNotBefore(),
        },
        visibility: body.visibility,
        managementTokenHash: body.managementTokenHash,
        signature: body.signature ?? null,
        gameId: idOrNull(gameSettled, "game"),
        gpuHardwareId: idOrNull(gpuSettled, "gpu"),
        cpuHardwareId: idOrNull(cpuSettled, "cpu"),
      });
    } catch (error) {
      // The hash is client-supplied and unique across runs (0004): a reused
      // delete token is an expected conflict, not an internal error. The
      // update rolled back, so retrying with a FRESH token succeeds.
      if (isUniqueViolation(error, "runs_anonymous_management_token_hash_idx")) {
        await cleanupFinalizedCopy(id, finalizedObjectKey, "copied-object");
        return jsonError(
          409,
          "management-token-in-use",
          "management token already protects another run — generate a fresh token and retry",
        );
      }
      await cleanupFinalizedCopy(id, finalizedObjectKey, "copied-object");
      throw error;
    }
    if (!finalized) {
      await cleanupFinalizedCopy(id, finalizedObjectKey, "losing-copy");
      const state = await readRunFinalizeState(id);
      if (!state) {
        return jsonError(404, "not-found", "run not found");
      }
      return jsonError(409, "already-finalized", "run was already finalized");
    }

    // Best effort only: a durable queue row remains until the PUT URL has
    // expired, so a later staging replay is reaped even if this succeeds.
    await deleteObject(expectedUploadKey).catch((error) => {
      console.error(`finalize ${id}: staging cleanup failed`, error);
    });

    // Keep the normal upload path responsive without relying on this process
    // for durability. The queued row is still drained by cron/CLI if this
    // best-effort kick is interrupted or fails.
    void drainJobs({ maxJobs: 1 }).catch((error) => {
      console.error(`finalize ${id}: drain kick failed (job remains queued)`, error);
    });

    const response: FinalizeRunResponse = { id, status: RUN_STATUS.pending };
    return NextResponse.json(response);
  } catch (error) {
    console.error("POST /api/runs/:id/finalize failed", error);
    if (error instanceof FinalizedCopyCleanupError) {
      return jsonError(
        502,
        "storage-cleanup-failed",
        "could not clean up the copied frames object — retry later",
      );
    }
    return jsonError(500, "internal", "finalize failed");
  }
}
