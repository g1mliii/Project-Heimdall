/**
 * The one seam between Clerk and the app (§20.1c). Route handlers call
 * `getViewer()`/`requireViewer()`/`requireAdmin()`; every other module —
 * repositories especially — stays Clerk-free and takes a plain
 * `Viewer | null` argument instead. Getting this file wrong is getting
 * Phase 8 authorization wrong: every ownership/role check in the app reads
 * through here.
 */

import { auth } from "@clerk/nextjs/server";
import type { NextResponse } from "next/server";
import type { ApiError } from "@heimdall/shared";
import { isClerkConfigured } from "../env";
import { AccountErasedError, ensureUser } from "../repo/users";
import type { Viewer, ViewerIdentity } from "../viewer";
import { jsonError } from "./http";

export type { Viewer, ViewerIdentity };

/**
 * Who is calling, with NO database round trip — the id comes straight off the
 * verified session cookie. Prefer this wherever only `userId` is used:
 * ownership comparisons (`isVisibleTo`) and rate-limit bucketing. Read paths
 * like GET /api/search (600/hr) and GET /api/runs/:id must not pay a `users`
 * read just to pick a rate-limit key.
 *
 * It does NOT guarantee a `users` row exists. Any route about to write a row
 * that references `users.id` (runs, reports, comparisons) needs `getViewer()`
 * — or `ensureUser()` directly — or the foreign key will reject the insert.
 *
 * Null when signed out, or when Clerk isn't configured (anonymous-only
 * dev/CI, §20.1a) — both cases must behave identically to the pre-auth app.
 */
export async function getViewerIdentity(): Promise<ViewerIdentity | null> {
  if (!isClerkConfigured()) {
    return null;
  }
  const { userId } = await auth();
  return userId ? { userId } : null;
}

/**
 * Identity + role, provisioning the `users` row on the way (§20.1b). Costs an
 * upsert on first sight of a user per process, then one select per call — use
 * `getViewerIdentity()` when the role isn't read.
 *
 * Null when signed out, or when Clerk isn't configured (anonymous-only
 * dev/CI, §20.1a) — both cases must behave identically to the pre-auth app.
 */
export async function getViewer(): Promise<Viewer | null> {
  const identity = await getViewerIdentity();
  if (!identity) {
    return null;
  }
  try {
    const user = await ensureUser(identity.userId);
    return { userId: identity.userId, role: user.role };
  } catch (error) {
    // A session can outlive Clerk's deletion propagation by a few requests.
    // The durable database fence wins over that stale cookie.
    if (error instanceof AccountErasedError) {
      return null;
    }
    throw error;
  }
}

export async function requireViewer(): Promise<Viewer | NextResponse<ApiError>> {
  const viewer = await getViewer();
  return viewer ?? jsonError(401, "auth-required", "sign in required");
}

export async function requireAdmin(): Promise<Viewer | NextResponse<ApiError>> {
  const viewer = await getViewer();
  if (!viewer) {
    return jsonError(401, "auth-required", "sign in required");
  }
  if (viewer.role !== "admin") {
    return jsonError(403, "forbidden", "admin role required");
  }
  return viewer;
}
