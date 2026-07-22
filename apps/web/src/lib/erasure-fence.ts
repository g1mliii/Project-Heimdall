/**
 * Stable, pseudonymous key for the durable account-erasure fence (§20.4).
 *
 * A Clerk id must never be retained merely to reject a delayed webhook or
 * stale session after account deletion. The database therefore stores this
 * one-way identifier instead of the Clerk id itself. It is deliberately
 * domain-separated from every other SHA-256 use in the application.
 */

import { createHash } from "node:crypto";

export function accountErasureFenceKey(userId: string): string {
  return createHash("sha256")
    .update("heimdall/account-erasure-fence/v1\0", "utf8")
    .update(userId, "utf8")
    .digest("hex");
}
