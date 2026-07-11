/**
 * POST /api/internal/jobs/drain — the platform-agnostic cron entry point
 * (§11.5/§11.11): drains verification jobs, reaps stale pending runs, prunes
 * rate-limit windows. Guarded by INTERNAL_JOBS_TOKEN; 401s when the token is
 * unset rather than running open.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getIngestEnv } from "@/lib/env";
import { runMaintenancePass } from "@/lib/jobs/drain";
import { bearerToken, jsonError } from "@/lib/api/http";

export const runtime = "nodejs";

function bearerMatches(request: Request, expected: string): boolean {
  const presented = bearerToken(request);
  if (presented === null) {
    return false;
  }
  const presentedBytes = Buffer.from(presented);
  const wanted = Buffer.from(expected);
  return presentedBytes.length === wanted.length && timingSafeEqual(presentedBytes, wanted);
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const token = getIngestEnv().INTERNAL_JOBS_TOKEN;
    if (!token || !bearerMatches(request, token)) {
      return jsonError(401, "unauthorized", "missing or invalid drain token");
    }

    return NextResponse.json(await runMaintenancePass({ maxJobs: 10, budgetMs: 25_000 }));
  } catch (error) {
    console.error("POST /api/internal/jobs/drain failed", error);
    return jsonError(500, "internal", "drain failed");
  }
}
