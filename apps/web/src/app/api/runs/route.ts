/**
 * POST /api/runs (§11.2) — create a `pending` run row and hand back a
 * presigned R2 PUT URL. Size/frame-count limits are enforced HERE, before any
 * presigned URL exists (§11.10): an unbounded capture is a storage-DoS vector.
 */

import { NextResponse } from "next/server";
import {
  GENERATED_FRAME_TECH,
  RUN_STATUS,
  RUN_VISIBILITY,
  createRunRequestSchema,
  hashManagementToken,
} from "@heimdall/shared";
import type { CreateRunResponse, Run } from "@heimdall/shared";
import { BenchmarkSetSecretMismatchError, RunOwnerUnavailableError, insertRun } from "@/lib/db";
import { newRunId } from "@/lib/ids";
import { framesUploadObjectKey, presignPut } from "@/lib/r2";
import { getViewer } from "@/lib/api/auth";
import { jsonError, parseJsonBody, rateLimits, requireRateLimit } from "@/lib/api/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const viewer = await getViewer();
    const limited = await requireRateLimit(
      "create-runs",
      request,
      rateLimits().createRuns,
      viewer,
    );
    if (limited) {
      return limited;
    }

    const body = await parseJsonBody(request, createRunRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    if (body.visibility === RUN_VISIBILITY.private && !viewer) {
      return jsonError(400, "auth-required-for-private", "sign in to create a private run");
    }

    const id = newRunId();
    const uploadObjectKey = framesUploadObjectKey(id);
    const run: Run = {
      id,
      game: body.game,
      captureSource: body.captureSource,
      visibility: body.visibility,
      status: RUN_STATUS.pending,
      ownerId: viewer?.userId,
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
      // Rules engine runs at verification; a freshly created run has none yet.
      diagnostics: [],
      schemaVersion: body.schemaVersion,
      parserVersion: body.parserVersion,
      createdAt: new Date().toISOString(),
      // Provisional client manifest (§16a.3), recomputed canonically at verify.
      ...(body.capabilityManifest ? { capabilityManifest: body.capabilityManifest } : {}),
      // Declared methodology (§16c.1) — drives the Phase 7 comparability key.
      ...(body.methodologyManifest ? { methodologyManifest: body.methodologyManifest } : {}),
      ...(body.benchmarkSetId ? { benchmarkSetId: body.benchmarkSetId } : {}),
      ...(body.isWarmup ? { isWarmup: true } : {}),
      // framesObjectKey stays unset until finalize proves the object exists.
    };
    // The opaque id is safe to persist/read with the run; the plaintext
    // browser-held capability is hashed before it reaches the database.
    await insertRun(
      run,
      undefined,
      body.benchmarkSetSecret === undefined
        ? undefined
        : { benchmarkSetSecretHash: await hashManagementToken(body.benchmarkSetSecret) },
    );

    const uploadUrl = await presignPut(uploadObjectKey, {
      contentLengthBytes: body.parquetByteLength,
    });
    const response: CreateRunResponse = { id, uploadUrl, uploadObjectKey };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    if (error instanceof RunOwnerUnavailableError) {
      return jsonError(409, "account-erasure-pending", "account deletion is in progress");
    }
    if (error instanceof BenchmarkSetSecretMismatchError) {
      return jsonError(
        409,
        "benchmark-set-secret-mismatch",
        "benchmark set cannot be joined from this browser",
      );
    }
    console.error("POST /api/runs failed", error);
    return jsonError(500, "internal", "run creation failed");
  }
}
