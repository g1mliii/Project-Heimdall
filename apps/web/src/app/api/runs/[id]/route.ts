/**
 * GET /api/runs/:id (§11.6) — read a run; pre-auth visibility model applies
 * (unlisted is link-scoped; private/hidden 404 because ownership doesn't
 * exist until Phase 8).
 *
 * DELETE /api/runs/:id (§12.6) — anonymous-token delete. Every failure mode
 * is a 404: a wrong token must not confirm the run even exists.
 */

import { NextResponse } from "next/server";
import { RUN_STATUS, RUN_VISIBILITY, verifyManagementToken } from "@heimdall/shared";
import type { RunResponse } from "@heimdall/shared";
import { readRun } from "@/lib/db";
import { deleteRun, readRunManagementTokenHash } from "@/lib/repo/runs";
import { deleteObject } from "@/lib/r2";
import { jsonError, rateLimits, requireRateLimit } from "@/lib/api/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const run = await readRun(id);
    if (!run || run.visibility === RUN_VISIBILITY.private || run.status === RUN_STATUS.hidden) {
      return jsonError(404, "not-found", "run not found");
    }
    const response: RunResponse = run;
    return NextResponse.json(response);
  } catch (error) {
    console.error("GET /api/runs/:id failed", error);
    return jsonError(500, "internal", "run read failed");
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  try {
    const limited = await requireRateLimit("delete-run", request, rateLimits().delete);
    if (limited) {
      return limited;
    }

    const { id } = await context.params;
    const auth = request.headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : null;

    const state = await readRunManagementTokenHash(id);
    if (
      !state ||
      !state.tokenHash ||
      !token ||
      !(await verifyManagementToken(token, state.tokenHash))
    ) {
      return jsonError(404, "not-found", "run not found");
    }

    // Object first: if storage deletion fails the row survives, so the caller
    // can simply retry — the reverse order would orphan the R2 object forever.
    if (state.framesObjectKey) {
      try {
        await deleteObject(state.framesObjectKey);
      } catch (error) {
        console.error(`DELETE /api/runs/${id}: R2 delete failed`, error);
        return jsonError(502, "storage-delete-failed", "could not delete stored frames — retry");
      }
    }
    await deleteRun(id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("DELETE /api/runs/:id failed", error);
    return jsonError(500, "internal", "run deletion failed");
  }
}
