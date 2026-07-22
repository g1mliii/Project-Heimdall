/**
 * POST /api/reports (§20.5) — anonymous-allowed moderation report on a run or
 * game. Matches every other report/ingest path's zero-auth-friction
 * invariant: no session required, but a signed-in reporter is recorded
 * (nullable — `on delete set null` — so the report survives account
 * deletion as moderation history).
 */

import { NextResponse } from "next/server";
import { createReportRequestSchema } from "@heimdall/shared";
import type { ReportRow } from "@heimdall/shared";
import { createReport, ReportSubjectNotFoundError } from "@/lib/repo/reports";
import { getViewer } from "@/lib/api/auth";
import { jsonError, parseJsonBody, rateLimits, requireRateLimit } from "@/lib/api/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const viewer = await getViewer();
    const limited = await requireRateLimit(
      "create-report",
      request,
      rateLimits().createReport,
      viewer,
    );
    if (limited) {
      return limited;
    }

    const body = await parseJsonBody(request, createReportRequestSchema);
    if (body instanceof NextResponse) {
      return body;
    }

    const report = await createReport({
      subjectType: body.subjectType,
      subjectRunId: body.subjectRunId,
      subjectGameId: body.subjectGameId,
      reason: body.reason,
      detail: body.detail,
      reporterUserId: viewer?.userId ?? null,
    });
    const response: ReportRow = report;
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    if (error instanceof ReportSubjectNotFoundError) {
      return jsonError(404, "not-found", "report subject not found");
    }
    console.error("POST /api/reports failed", error);
    return jsonError(500, "internal", "report creation failed");
  }
}
