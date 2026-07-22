/**
 * POST /api/runs/:id/claim (§20.2e) — attach an anonymous run to the
 * signed-in caller's account, using the same management token the upload
 * flow already handed them. Single-use: a successful claim clears the
 * token hash, so the run can never be claimed — or anonymously deleted —
 * again. Every failure mode is a 404, matching the anonymous DELETE route's
 * posture: a wrong token, an already-owned run, or a missing run must all
 * be indistinguishable to the caller.
 */

import { NextResponse } from "next/server";
import { verifyManagementToken } from "@heimdall/shared";
import { claimRun, readRunManagementTokenHash } from "@/lib/repo/runs";
import { requireViewer } from "@/lib/api/auth";
import { bearerToken, jsonError, rateLimits, requireRateLimit } from "@/lib/api/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const viewer = await requireViewer();
    if (viewer instanceof NextResponse) {
      return viewer;
    }

    const limited = await requireRateLimit("claim-run", request, rateLimits().claim, viewer);
    if (limited) {
      return limited;
    }

    const { id } = await context.params;
    const token = bearerToken(request);
    const state = await readRunManagementTokenHash(id);
    if (
      !state ||
      state.ownerId ||
      !state.tokenHash ||
      !token ||
      !(await verifyManagementToken(token, state.tokenHash))
    ) {
      return jsonError(404, "not-found", "run not found");
    }

    const claimed = await claimRun(id, viewer.userId, state.tokenHash);
    if (!claimed) {
      // Lost a race with a concurrent claim/delete between the read above and here.
      return jsonError(404, "not-found", "run not found");
    }

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("POST /api/runs/:id/claim failed", error);
    return jsonError(500, "internal", "claim failed");
  }
}
