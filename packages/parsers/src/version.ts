/**
 * Parser versioning (§2.2 provenance). Every `ParsedCapture` and ingest payload
 * records which parser produced it, so old uploads can be reprocessed when a
 * parser's behavior changes. Bump a source's version on any change that could
 * alter its output for the same input.
 */

import type { CaptureSource } from "@heimdall/shared";

export const PARSER_VERSIONS = {
  capframex: "1.0.0",
  presentmon: "1.0.0",
  mangohud: "1.0.0",
} as const satisfies Record<CaptureSource, string>;

/** `"capframex@1.0.0"` — the string stored as `Run.parserVersion`. */
export function parserVersionString(source: CaptureSource): string {
  return `${source}@${PARSER_VERSIONS[source]}`;
}
