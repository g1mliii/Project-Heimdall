/**
 * GET /api/search (§17.6) — bounded typeahead over public game + hardware
 * dictionaries. The response contains no run-derived or user-specific data,
 * which is why shared edge caching is safe here (unlike every run read path).
 */

import { NextResponse } from "next/server";
import {
  SEARCH_MIN_QUERY_LENGTH,
  searchQuerySchema,
  type SearchResponse,
} from "@heimdall/shared";

import { jsonError, parseQuery, rateLimits, requireRateLimit } from "@/lib/api/http";
import { searchCatalog } from "@/lib/repo/search";

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
    // spend a rate-limit/database write.
    if (parsed.q.length < SEARCH_MIN_QUERY_LENGTH) {
      return catalogResponse(EMPTY_SEARCH);
    }

    const limited = await requireRateLimit("search", request, rateLimits().search);
    if (limited) {
      return limited;
    }

    return catalogResponse(await searchCatalog(parsed.q));
  } catch (error) {
    console.error("GET /api/search failed", error);
    return jsonError(500, "internal", "catalog search failed");
  }
}
