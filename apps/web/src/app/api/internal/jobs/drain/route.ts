/**
 * POST /api/internal/jobs/drain — the platform-agnostic cron entry point
 * (§11.5/§11.11): drains verification jobs, reaps stale pending runs, prunes
 * rate-limit windows. Guarded by INTERNAL_JOBS_TOKEN; 401s when the token is
 * unset rather than running open.
 */

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getIngestEnv } from "@/lib/env";
import { cleanupStalePending, drainJobs } from "@/lib/jobs/drain";
import { pruneRateLimits } from "@/lib/repo/rate-limit";
import { jsonError } from "@/lib/api/http";

export const runtime = "nodejs";

function bearerMatches(request: Request, expected: string): boolean {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) {
    return false;
  }
  const presented = Buffer.from(auth.slice("Bearer ".length).trim());
  const wanted = Buffer.from(expected);
  return presented.length === wanted.length && timingSafeEqual(presented, wanted);
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const token = getIngestEnv().INTERNAL_JOBS_TOKEN;
    if (!token || !bearerMatches(request, token)) {
      return jsonError(401, "unauthorized", "missing or invalid drain token");
    }

    const drained = await drainJobs({ maxJobs: 10, budgetMs: 25_000 });
    const cleanedStalePending = await cleanupStalePending();
    const prunedRateLimitWindows = await pruneRateLimits();
    return NextResponse.json({ ...drained, cleanedStalePending, prunedRateLimitWindows });
  } catch (error) {
    console.error("POST /api/internal/jobs/drain failed", error);
    return jsonError(500, "internal", "drain failed");
  }
}
