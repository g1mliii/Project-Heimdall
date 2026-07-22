/**
 * The signed-in requester, as repositories see it (§20.1c). Deliberately
 * dependency-free (no Clerk import) so `lib/repo/**` — which must stay
 * Clerk-free — can take `Viewer | null` as a plain argument. `lib/api/auth.ts`
 * is the only place that constructs one.
 *
 * Two shapes, because most call sites don't need the expensive half:
 * `ViewerIdentity` is "who is this" and comes straight from the session
 * cookie; `Viewer` adds `role`, which costs a `users` read. Ownership checks
 * and rate-limit bucketing only ever compare `userId`, so they take the
 * cheap one — see `getViewerIdentity()` vs `getViewer()`.
 */
export type UserRole = "public" | "verified" | "admin";

/** Just the session identity — free, no database read. */
export interface ViewerIdentity {
  userId: string;
}

/** Identity plus the authorization role — costs one `users` read. */
export interface Viewer extends ViewerIdentity {
  role: UserRole;
}
