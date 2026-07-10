/**
 * POST /api/runs (§11.2) — create a `pending` run row and hand back a
 * presigned R2 PUT URL. Size/frame-count limits are enforced HERE, before any
 * presigned URL exists (§11.10): an unbounded capture is a storage-DoS vector.
 */

import { NextResponse } from "next/server";
import { GENERATED_FRAME_TECH, RUN_STATUS, createRunRequestSchema } from "@heimdall/shared";
import type { CreateRunResponse, Run } from "@heimdall/shared";
import { insertRun } from "@/lib/db";
import { newRunId } from "@/lib/ids";
import { framesUploadObjectKey, presignPut } from "@/lib/r2";
import { jsonError, parseJsonBody, rateLimits, requireRateLimit } from "@/lib/api/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const limited = await requireRateLimit("create-runs", request, rateLimits().createRuns);
    if (limited) {
      return limited;
    }

    const body = await parseJsonBody(request, createRunRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    const id = newRunId();
    const uploadObjectKey = framesUploadObjectKey(id);
    const run: Run = {
      id,
      game: body.game,
      captureSource: body.captureSource,
      visibility: body.visibility,
      status: RUN_STATUS.pending,
      // Canonical ids are SERVER-resolved on finalize (§11.9) — a client-
      // asserted id would let an uploader plant their run in any hardware
      // bucket, so strip them regardless of what the payload carried.
      hardware: { ...body.hardware, canonicalGpuId: undefined, canonicalCpuId: undefined },
      summary: body.summary,
      generatedFrameTech:
        body.summary.generatedFramePct > 0 &&
        body.generatedFrameTech === GENERATED_FRAME_TECH.none
          ? GENERATED_FRAME_TECH.unknown
          : body.generatedFrameTech,
      schemaVersion: body.schemaVersion,
      parserVersion: body.parserVersion,
      createdAt: new Date().toISOString(),
      // framesObjectKey stays unset until finalize proves the object exists.
    };
    await insertRun(run);

    const uploadUrl = await presignPut(uploadObjectKey, {
      contentLengthBytes: body.parquetByteLength,
    });
    const response: CreateRunResponse = { id, uploadUrl, uploadObjectKey };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error("POST /api/runs failed", error);
    return jsonError(500, "internal", "run creation failed");
  }
}
