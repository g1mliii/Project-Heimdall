/**
 * Parser versioning (§2.2 provenance). Every `ParsedCapture` and ingest payload
 * records which parser produced it, so old uploads can be reprocessed when a
 * parser's behavior changes. Bump a source's version on any change that could
 * alter its output for the same input.
 */

import type { CaptureSource } from "@heimdall/shared";

export const PARSER_VERSIONS = {
  capframex: "1.0.0",
  // 1.1.0: GPU utilization/clock/power/VRAM are reported as POLLED, not
  // frame-aligned (they always were; the parser used to claim otherwise), and
  // the Heimdall client's own PDH-sampled columns are recognized.
  // 1.2.0: a frame-type column that reads `Application` now records
  // `generated: false` rather than leaving it undefined — a faithful
  // transcription of the cell, NOT evidence that no frames were generated. An
  // all-`Application` column is what an uninstrumented driver produces
  // (§22.11), so only an observed `true` carries information.
  presentmon: "1.2.0",
  // 1.1.0: every MangoHud sensor is reported as POLLED rather than
  // frame-aligned (they always were; the parser used to claim otherwise). Same
  // correction the presentmon 1.1.0 bump made, applied to the source where it
  // covers the entire sensor set — MangoHud has no per-present timing columns,
  // so nothing it logs is frame-aligned.
  mangohud: "1.1.0",
} as const satisfies Record<CaptureSource, string>;

/** `"capframex@1.0.0"` — the string stored as `Run.parserVersion`. */
export function parserVersionString(source: CaptureSource): string {
  return `${source}@${PARSER_VERSIONS[source]}`;
}
