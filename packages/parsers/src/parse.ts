/**
 * Source-tagged dispatcher — the single entry point callers use when the
 * capture source is already known (upload form, recompute job row).
 */

import type { CaptureSource } from "@heimdall/shared";

import { failure, type ParsedCapture, type ParseResult } from "./errors";
import { parseCapFrameX } from "./capframex";
import { parsePresentMon } from "./presentmon";
import { parseMangoHud } from "./mangohud";

type Parser = (input: string | Uint8Array) => ParseResult<ParsedCapture>;

const PARSERS = {
  capframex: parseCapFrameX,
  presentmon: parsePresentMon,
  mangohud: parseMangoHud,
} as const satisfies Record<CaptureSource, Parser>;

function isCaptureSource(source: string): source is CaptureSource {
  return Object.hasOwn(PARSERS, source);
}

export function parseCapture(
  source: CaptureSource | string,
  input: string | Uint8Array,
): ParseResult<ParsedCapture> {
  if (isCaptureSource(source)) return PARSERS[source](input);
  return failure("unknown", "unrecognized-format", `Unknown capture source: ${source}.`);
}
