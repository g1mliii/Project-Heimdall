/**
 * POST /api/runs/:id/finalize (§11.4) — after the browser's direct-to-R2 PUT:
 * HEAD-validate the object (§11.10), resolve canonical game/hardware ids
 * (§11.9), record visibility + hashed management token + optional signature,
 * and enqueue the durable verification job — atomically with the finalize
 * (§11.5). A best-effort drain kick follows; durability never depends on it.
 */

import { NextResponse } from "next/server";
import { INGEST_LIMITS, RUN_STATUS, finalizeRunRequestSchema } from "@heimdall/shared";
import type { FinalizeRunResponse } from "@heimdall/shared";
import { readRun } from "@/lib/db";
import { finalizeRun, readRunFinalizeState } from "@/lib/repo/runs";
import { resolveGameId, resolveHardwareId } from "@/lib/repo/catalog";
import { drainJobs } from "@/lib/jobs/drain";
import { deleteObject, framesObjectKey, headObject } from "@/lib/r2";
import { jsonError, parseJsonBody, rateLimits, requireRateLimit } from "@/lib/api/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const limited = await requireRateLimit("finalize-run", request, rateLimits().finalize);
    if (limited) {
      return limited;
    }

    const { id } = await context.params;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return jsonError(404, "not-found", "run not found");
    }
    const body = await parseJsonBody(request, finalizeRunRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    // The object key is derived from the id — a client naming any other key
    // could hijack someone else's upload slot.
    const expectedKey = framesObjectKey(id);
    if (body.framesObjectKey !== expectedKey) {
      return jsonError(403, "key-mismatch", "framesObjectKey does not belong to this run");
    }

    const run = await readRun(id);
    if (!run) {
      return jsonError(404, "not-found", "run not found");
    }

    // §11.10: the object must exist and fit before we commit to it. The
    // presigner can't sign Content-Type, so size + recompute-from-storage are
    // the real guards.
    const head = await headObject(expectedKey);
    if (!head) {
      return jsonError(409, "object-missing", "upload the parquet before finalizing");
    }
    if (head.sizeBytes > INGEST_LIMITS.maxParquetBytes) {
      await deleteObject(expectedKey);
      return jsonError(413, "object-too-large", "uploaded parquet exceeds the size limit");
    }

    // §11.9 canonical resolution — enrichment, never a gate: failures leave
    // the raw strings standing and the ids null.
    let gameId: string | null = null;
    let gpuHardwareId: string | null = null;
    let cpuHardwareId: string | null = null;
    try {
      gameId = await resolveGameId(run.captureSource, run.game);
      gpuHardwareId = await resolveHardwareId(
        "gpu",
        run.captureSource,
        run.hardware.gpu,
        run.hardware.gpuVendor ?? null,
      );
      cpuHardwareId = await resolveHardwareId("cpu", run.captureSource, run.hardware.cpu, null);
    } catch (error) {
      console.error(`finalize ${id}: canonical resolution failed (non-fatal)`, error);
    }

    const finalized = await finalizeRun({
      id,
      framesObjectKey: expectedKey,
      visibility: body.visibility,
      managementTokenHash: body.managementTokenHash ?? null,
      signature: body.signature ?? null,
      gameId,
      gpuHardwareId,
      cpuHardwareId,
    });
    if (!finalized) {
      const state = await readRunFinalizeState(id);
      if (!state) {
        return jsonError(404, "not-found", "run not found");
      }
      return jsonError(409, "already-finalized", "run was already finalized");
    }

    // Best-effort immediate drain — the enqueued row is the durable truth; if
    // this process dies right here, cron picks the job up (§11.5).
    void drainJobs({ maxJobs: 1 }).catch((error) => {
      console.error(`finalize ${id}: drain kick failed (job remains queued)`, error);
    });

    const response: FinalizeRunResponse = { id, status: RUN_STATUS.pending };
    return NextResponse.json(response);
  } catch (error) {
    console.error("POST /api/runs/:id/finalize failed", error);
    return jsonError(500, "internal", "finalize failed");
  }
}
