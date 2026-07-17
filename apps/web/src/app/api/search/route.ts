/**
 * GET /api/search (§17.6) — bounded typeahead over public game + hardware
 * dictionaries. The response contains no run-derived or user-specific data,
 * which is why shared edge caching is safe here (unlike every run read path).
 */

import { NextResponse } from "next/server";
import { searchQuerySchema, type SearchResponse } from "@heimdall/shared";

import { jsonError, parseQuery, rateLimits, requireRateLimit } from "@/lib/api/http";
import { normalizeSearchQuery, searchCatalog } from "@/lib/repo/search";

export const runtime = "nodejs";

const CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";
const EMPTY_SEARCH: SearchResponse = { games: [], hardware: [] };

function catalogResponse(result: SearchResponse): NextResponse<SearchResponse> {
  return NextResponse.json(result, {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const parsed = parseQuery(request, searchQuerySchema);
    if (parsed instanceof NextResponse) {
      return parsed;
    }

    // A too-short typeahead is ordinary UI state, not an error or a reason to
    // spend a rate-limit/database write. Gate on the same normalized form
    // searchCatalog uses so a query that only shrinks below the minimum after
    // normalization does not burn a rate-limit token.
    const normalizedQuery = normalizeSearchQuery(parsed.q);
    if (normalizedQuery === null) {
      return catalogResponse(EMPTY_SEARCH);
    }

    const limited = await requireRateLimit("search", request, rateLimits().search);
    if (limited) {
      return limited;
    }

    return catalogResponse(await searchCatalog(normalizedQuery));
  } catch (error) {
    console.error("GET /api/search failed", error);
    return jsonError(500, "internal", "catalog search failed");
  }
}
