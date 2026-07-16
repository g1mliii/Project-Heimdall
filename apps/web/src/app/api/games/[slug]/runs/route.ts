/**
 * GET /api/games/:slug/runs (§17.7) — bounded pages of individual public,
 * validated submissions. This is run-derived data, so it is deliberately
 * private/no-store even though every returned row is public.
 */

import { NextResponse } from "next/server";
import { gameSubmissionsQuerySchema } from "@heimdall/shared";

import { jsonError, parseQuery } from "@/lib/api/http";
import {
  InvalidGameSubmissionsCursorError,
  readGamePage,
} from "@/lib/repo/games";

export const runtime = "nodejs";

const CACHE_CONTROL = "private, no-store";
type Context = { params: Promise<{ slug: string }> };

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", CACHE_CONTROL);
  return response;
}

export async function GET(request: Request, context: Context): Promise<NextResponse> {
  try {
    const parsed = parseQuery(request, gameSubmissionsQuerySchema);
    if (parsed instanceof NextResponse) return privateResponse(parsed);

    const { slug } = await context.params;
    const page = await readGamePage(slug, parsed);
    if (!page) {
      return privateResponse(jsonError(404, "not-found", "game not found"));
    }
    return NextResponse.json(page.submissions, {
      headers: { "Cache-Control": CACHE_CONTROL },
    });
  } catch (error) {
    if (error instanceof InvalidGameSubmissionsCursorError) {
      return privateResponse(jsonError(400, "invalid-request", "cursor is invalid"));
    }
    console.error("GET /api/games/:slug/runs failed", error);
    return privateResponse(jsonError(500, "internal", "game submissions read failed"));
  }
}
