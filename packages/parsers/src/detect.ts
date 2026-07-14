/**
 * Capture-source auto-detection — the entry point callers use when the source
 * is NOT already known (drag-and-drop upload, future desktop client import).
 *
 * Necessary because the parsers' frame-time columns overlap (MangoHud and
 * PresentMon v2 both name it `frametime`; CapFrameX CSV and PresentMon v1 both
 * use `msbetweenpresents`) — blind try-in-order would "succeed" with the wrong
 * source label. Marker tables live HERE, next to the column tables they must
 * track, so a parser alias change can't silently strand a stale copy elsewhere.
 */

import type { CaptureSource } from "@heimdall/shared";

import type { CaptureParseOptions, ParseError, ParsedCapture, ParseWarning } from "./errors";
import { decodeInput } from "./internal/decode";
import { parseCapture } from "./parse";

const DEFAULT_DETECTION_ORDER: CaptureSource[] = ["capframex", "presentmon", "mangohud"];

/** Source-distinctive markers looked for in the (lowercased) file head. */
const SOURCE_MARKERS: Record<CaptureSource, readonly string[]> = {
  capframex: ["msgpuactive", "gpumemusage", '"capturedata"', '"msbetweenpresents"'],
  presentmon: ["swapchainaddress", "presentruntime", "allowstearing", "cpustarttime"],
  mangohud: ["gpu_core_clock", "gpu_vram_used", "cpuscheduler", "cpu_load"],
};

// A bare MangoHud frame log starts with this header. Match it as a header,
// rather than the broad `fps` substring, so a PresentMon CSV that happens to
// include an FPS column retains its timestamp-aware parser.
const MANGOHUD_FPS_HEADER = /(?:^|[\r\n])\s*fps\s*[,;]\s*frametime(?:\s*[,;\r\n]|$)/;

/** Most marker hits in the file head goes first; ties keep the default order. */
export function detectionOrder(input: string | Uint8Array): CaptureSource[] {
  const head = (
    typeof input === "string" ? input.slice(0, 4096) : decodeInput(input.subarray(0, 4096))
  ).toLowerCase();
  const score = (source: CaptureSource) => {
    const markerHits = SOURCE_MARKERS[source].reduce(
      (hits, marker) => hits + (head.includes(marker) ? 1 : 0),
      0,
    );
    return source === "mangohud" && !head.includes("timeinseconds") && MANGOHUD_FPS_HEADER.test(head)
      ? markerHits + 1
      : markerHits;
  };
  return [...DEFAULT_DETECTION_ORDER].sort((a, b) => score(b) - score(a));
}

export type AutoParseResult =
  | { ok: true; source: CaptureSource; capture: ParsedCapture; warnings: ParseWarning[] }
  | { ok: false; error: ParseError };

/** Try each source in detection order; the first successful parse wins. */
export function parseAnyCapture(
  input: string | Uint8Array,
  options?: CaptureParseOptions,
): AutoParseResult {
  let bestError: ParseError | null = null;
  for (const source of detectionOrder(input)) {
    const result = parseCapture(source, input, options);
    if (result.ok) {
      return { ok: true, source, capture: result.value, warnings: result.warnings };
    }
    // Keep the most informative rejection: a source that recognized the shape
    // but choked mid-file beats a blanket "unrecognized-format".
    if (!bestError || (bestError.code === "unrecognized-format" && result.error.code !== "unrecognized-format")) {
      bestError = result.error;
    }
  }
  return { ok: false, error: bestError! };
}
