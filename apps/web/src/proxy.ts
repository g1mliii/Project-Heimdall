/**
 * Next 16 middleware convention (§20.1a). Protects ONLY `/account` and
 * `/admin` — everything else, including every `/api/*` ingest/report route,
 * stays reachable with zero auth friction. API routes decide their own
 * 401/404 via `lib/api/auth.ts`; this file must never grow their guard.
 *
 * A no-op passthrough when Clerk isn't configured (§20.1a) — anonymous-only
 * dev/CI must boot without a Clerk instance.
 */

import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextMiddleware } from "next/server";
import { isClerkConfigured } from "./lib/env";

const isProtectedRoute = createRouteMatcher(["/account(.*)", "/admin(.*)"]);

const passthrough: NextMiddleware = () => NextResponse.next();

export default isClerkConfigured()
  ? clerkMiddleware(async (routeAuth, request) => {
      if (isProtectedRoute(request)) {
        await routeAuth.protect();
      }
    })
  : passthrough;

export const config = {
  matcher: [
    // Skip Next internals and static files; run everywhere else, including api routes.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)",
    "/(api|trpc)(.*)",
  ],
};
