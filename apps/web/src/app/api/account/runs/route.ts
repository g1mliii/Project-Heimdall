/**
 * GET /api/account/runs (§20.2) — "My runs" for the signed-in caller. Owner
 * identity comes from the session, never a request param — there is no way
 * to ask for anyone else's list through this route.
 */

import { NextResponse } from "next/server";
import type { AccountRunsResponse } from "@heimdall/shared";
import { InvalidOwnedRunsCursorError, listRunsForUser } from "@/lib/repo/runs";
import { requireViewer } from "@/lib/api/auth";
import { jsonError } from "@/lib/api/http";

export const runtime = "nodejs";

export async function GET(
  request: Request = new Request("http://localhost/api/account/runs"),
): Promise<NextResponse> {
  try {
    const viewer = await requireViewer();
    if (viewer instanceof NextResponse) {
      return viewer;
    }
    const response: AccountRunsResponse = await listRunsForUser(viewer.userId, undefined, {
      cursor: new URL(request.url).searchParams.get("cursor"),
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof InvalidOwnedRunsCursorError) {
      return jsonError(400, "invalid-cursor", "account runs cursor is invalid");
    }
    console.error("GET /api/account/runs failed", error);
    return jsonError(500, "internal", "account runs read failed");
  }
}
