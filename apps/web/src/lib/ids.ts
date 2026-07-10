/**
 * Run identifiers. 144 bits of entropy, base64url — unguessable by design:
 * `unlisted` visibility is link-scoped (§1.1), so the id IS the capability.
 * The alphabet satisfies both `framesObjectKey`'s charset guard and URL paths.
 */

import { randomBytes } from "node:crypto";

/**
 * The run-id alphabet (base64url), next to the generator so the two can't
 * drift. Route handlers and the R2 key guard both validate against THIS —
 * never a local copy of the regex.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isRunId(id: string): boolean {
  return RUN_ID_PATTERN.test(id);
}

export function newRunId(): string {
  return randomBytes(18).toString("base64url");
}
