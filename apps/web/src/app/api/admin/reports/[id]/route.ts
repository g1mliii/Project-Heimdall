/**
 * PATCH /api/admin/reports/:id (§20.5) — admin-only. Status-only transition
 * (open → resolved/dismissed); a "dismiss" takes no action against the
 * reported content. To actually hide a reported run, see
 * `POST /api/admin/runs/:id/moderate`, which resolves matching open reports
 * as a side effect of the takedown itself.
 */

import { NextResponse } from "next/server";
import { updateReportRequestSchema } from "@heimdall/shared";
import { updateReportStatus } from "@/lib/repo/reports";
import { requireAdmin } from "@/lib/api/auth";
import { jsonError, parseJsonBody } from "@/lib/api/http";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (admin instanceof NextResponse) {
      return admin;
    }

    const { id } = await context.params;
    const body = await parseJsonBody(request, updateReportRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    const updated = await updateReportStatus(id, body.status, admin.userId);
    if (!updated) {
      return jsonError(404, "not-found", "report not found or already resolved");
    }
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("PATCH /api/admin/reports/:id failed", error);
    return jsonError(500, "internal", "report update failed");
  }
}
