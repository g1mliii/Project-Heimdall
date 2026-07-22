/**
 * POST /api/admin/runs/:id/moderate (§20.5) — admin-only takedown: sets the
 * run to `moderated` (owner still sees it, labeled; public 404s, same as
 * private/flagged/hidden) and resolves any of its open reports as a side
 * effect of the same action — a moderator hiding the content already IS the
 * resolution, not a separate step.
 */

import { NextResponse } from "next/server";
import { hideRunForModeration } from "@/lib/repo/reports";
import { requireAdmin } from "@/lib/api/auth";
import { jsonError } from "@/lib/api/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: Context): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (admin instanceof NextResponse) {
      return admin;
    }

    const { id } = await context.params;
    const moderated = await hideRunForModeration(id, admin.userId);
    if (!moderated) {
      return jsonError(404, "not-found", "run not found or already moderated/deleted");
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("POST /api/admin/runs/:id/moderate failed", error);
    return jsonError(500, "internal", "moderation failed");
  }
}
