/**
 * GET /api/runs/:id/frames (§11.6) — short-lived signed R2 read URL for the
 * per-frame Parquet. Same pre-auth visibility gate as GET /api/runs/:id.
 */

import { NextResponse } from "next/server";
import type { FramesUrlResponse } from "@heimdall/shared";
import { readVisibleRun } from "@/lib/repo/runs";
import { GET_TTL_SECONDS, presignGet } from "@/lib/r2";
import { jsonError } from "@/lib/api/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const run = await readVisibleRun(id);
    if (!run) {
      return jsonError(404, "not-found", "run not found");
    }
    if (!run.framesObjectKey) {
      return jsonError(409, "not-finalized", "run has no uploaded frames yet");
    }
    const url = await presignGet(run.framesObjectKey);
    const response: FramesUrlResponse = { url, expiresInSeconds: GET_TTL_SECONDS };
    return NextResponse.json(response);
  } catch (error) {
    console.error("GET /api/runs/:id/frames failed", error);
    return jsonError(500, "internal", "frames url failed");
  }
}
