/** GET /api/admin/reports (§20.5) — admin-only list of open reports, newest first. */

import { NextResponse } from "next/server";
import type { AdminReportsResponse } from "@heimdall/shared";
import { InvalidOpenReportsCursorError, listOpenReports } from "@/lib/repo/reports";
import { requireAdmin } from "@/lib/api/auth";
import { jsonError } from "@/lib/api/http";

export const runtime = "nodejs";

export async function GET(
  request: Request = new Request("http://localhost/api/admin/reports"),
): Promise<NextResponse> {
  try {
    const admin = await requireAdmin();
    if (admin instanceof NextResponse) {
      return admin;
    }
    const response: AdminReportsResponse = await listOpenReports({
      cursor: new URL(request.url).searchParams.get("cursor"),
    });
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof InvalidOpenReportsCursorError) {
      return jsonError(400, "invalid-cursor", "reports cursor is invalid");
    }
    console.error("GET /api/admin/reports failed", error);
    return jsonError(500, "internal", "reports read failed");
  }
}
