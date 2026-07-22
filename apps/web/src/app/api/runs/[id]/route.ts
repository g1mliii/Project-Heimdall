/**
 * GET /api/runs/:id (§11.6) — read a run through the visibility gate
 * (unlisted is link-scoped; private is owner-only; flagged is owner-visible).
 *
 * PATCH /api/runs/:id (§20.2) — owner-only visibility switcher
 * (private/unlisted/public). A non-owner (including anonymous) 404s.
 *
 * DELETE /api/runs/:id (§12.6, owner auth added §20.2) — the anonymous
 * management token, the run's signed-in owner, or an admin may delete. Every
 * failure mode is a 404: a wrong token or a non-owner must not confirm the
 * run even exists.
 */

import { NextResponse } from "next/server";
import {
  runResponseSchema,
  updateRunVisibilityRequestSchema,
  verifyManagementToken,
} from "@heimdall/shared";
import type { RunResponse } from "@heimdall/shared";
import {
  deleteRun,
  hideAuthorizedRunForDeletion,
  readRunManagementTokenHash,
  readVisibleRun,
  updateRunVisibility,
} from "@/lib/repo/runs";
import { deleteObject } from "@/lib/r2";
import { getViewer, getViewerIdentity, requireViewer } from "@/lib/api/auth";
import { bearerToken, jsonError, parseJsonBody, rateLimits, requireRateLimit } from "@/lib/api/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    // Identity only: the gate compares ownership, never role — no `users` read
    // on this hot read path.
    const viewer = await getViewerIdentity();
    const run = await readVisibleRun(id, viewer);
    if (!run) {
      return jsonError(404, "not-found", "run not found");
    }
    // §20.3: strips ownerId (a raw Clerk user id — internal-only, see the
    // schema's comment) before this reaches a viewer who may be a stranger.
    const response: RunResponse = runResponseSchema.parse(run);
    return NextResponse.json(response);
  } catch (error) {
    console.error("GET /api/runs/:id failed", error);
    return jsonError(500, "internal", "run read failed");
  }
}

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  try {
    const viewer = await requireViewer();
    if (viewer instanceof NextResponse) {
      return viewer;
    }

    const { id } = await context.params;
    const body = await parseJsonBody(request, updateRunVisibilityRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    // Same read used by DELETE — it already carries ownerId. A non-owner
    // (including anonymous, and an ownerless run — that's the claim flow's
    // job, not this route's) 404s.
    const state = await readRunManagementTokenHash(id);
    if (!state || state.ownerId !== viewer.userId) {
      return jsonError(404, "not-found", "run not found");
    }

    if (!(await updateRunVisibility(id, body.visibility))) {
      // A deletion/moderation transition may have won between the ownership
      // read above and the conditional update.
      return jsonError(404, "not-found", "run not found");
    }
    return NextResponse.json({ id, visibility: body.visibility });
  } catch (error) {
    console.error("PATCH /api/runs/:id failed", error);
    return jsonError(500, "internal", "visibility update failed");
  }
}

export async function DELETE(request: Request, context: Context): Promise<NextResponse> {
  try {
    const viewer = await getViewer();
    const limited = await requireRateLimit("delete-run", request, rateLimits().delete, viewer);
    if (limited) {
      return limited;
    }

    const { id } = await context.params;
    const state = await readRunManagementTokenHash(id);
    if (!state) {
      return jsonError(404, "not-found", "run not found");
    }

    const token = bearerToken(request);
    const tokenValid = Boolean(
      state.tokenHash && token && (await verifyManagementToken(token, state.tokenHash)),
    );
    const isOwner = Boolean(viewer && state.ownerId && viewer.userId === state.ownerId);
    const isAdmin = viewer?.role === "admin";
    if (!tokenValid && !isOwner && !isAdmin) {
      return jsonError(404, "not-found", "run not found");
    }

    // Tombstone and re-check the authorization state in ONE conditional UPDATE.
    // A claim that won after the read above has cleared the token hash, so it
    // cannot be deleted by an in-flight token request.
    const deletion = await hideAuthorizedRunForDeletion(id, {
      ownerId: isOwner ? viewer?.userId ?? null : null,
      tokenHash: tokenValid ? state.tokenHash : null,
      isAdmin,
    });
    if (!deletion) {
      return jsonError(404, "not-found", "run not found");
    }
    if (deletion.framesObjectKey) {
      try {
        await deleteObject(deletion.framesObjectKey);
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
