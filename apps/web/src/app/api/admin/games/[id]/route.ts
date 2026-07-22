/**
 * PATCH /api/admin/games/:id (§20.5) — admin-only single-game display-name
 * fix (e.g. correcting an abusive/malformed title). Cross-id game
 * rename-MERGE (combining two canonical game ids into one) is explicitly
 * deferred — this only edits the name on the existing row.
 */

import { NextResponse } from "next/server";
import { updateGameRequestSchema } from "@heimdall/shared";
import { requireAdmin } from "@/lib/api/auth";
import { jsonError, parseJsonBody } from "@/lib/api/http";
import { renameGame } from "@/lib/repo/games";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (admin instanceof NextResponse) {
      return admin;
    }

    const { id } = await context.params;
    const body = await parseJsonBody(request, updateGameRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    if (!(await renameGame(id, body.name))) {
      return jsonError(404, "not-found", "game not found");
    }
    return NextResponse.json({ id, name: body.name });
  } catch (error) {
    console.error("PATCH /api/admin/games/:id failed", error);
    return jsonError(500, "internal", "game update failed");
  }
}
