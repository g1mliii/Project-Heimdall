/**
 * GET /api/games/:slug/distribution (§17) — the aggregate cohort distribution
 * for one game and metric. Unlike the individual submissions listing, this is
 * pooled public + validated aggregate data (no per-submission identity), so the
 * cohort-only response is safe to share-cache at the edge like /api/search.
 *
 * When the request pins `viewerRunId` for a "You: Nth percentile" marker the
 * response is scoped to that URL, so it drops to private/no-store rather than
 * populating the shared edge cache with per-viewer variants.
 */

import { NextResponse } from "next/server";
import { gameDistributionQuerySchema } from "@heimdall/shared";

import { jsonError, parseQuery, rateLimits, requireRateLimit } from "@/lib/api/http";
import { readGameDistribution } from "@/lib/repo/distribution";

export const runtime = "nodejs";

const SHARED_CACHE = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
const PRIVATE_CACHE = "private, no-store";
type Context = { params: Promise<{ slug: string }> };

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const parsed = parseQuery(request, gameDistributionQuerySchema);
    if (parsed instanceof NextResponse) return parsed;

    const limited = await requireRateLimit("distribution", request, rateLimits().search);
    if (limited) return limited;

    const { slug } = await context.params;
    const distribution = await readGameDistribution(slug, parsed);
    if (!distribution) {
      const notFound = jsonError(404, "not-found", "game not found");
      notFound.headers.set("Cache-Control", PRIVATE_CACHE);
      return notFound;
    }

    const cacheControl = parsed.viewerRunId ? PRIVATE_CACHE : SHARED_CACHE;
    return NextResponse.json(distribution, { headers: { "Cache-Control": cacheControl } });
  } catch (error) {
    console.error("GET /api/games/:slug/distribution failed", error);
    return jsonError(500, "internal", "distribution read failed");
  }
}
