/**
 * Run identifiers. 144 bits of entropy, base64url — unguessable by design:
 * `unlisted` visibility is link-scoped (§1.1), so the id IS the capability.
 * The alphabet satisfies both `framesObjectKey`'s charset guard and URL paths.
 */

import { randomBytes } from "node:crypto";

export function newRunId(): string {
  return randomBytes(18).toString("base64url");
}
