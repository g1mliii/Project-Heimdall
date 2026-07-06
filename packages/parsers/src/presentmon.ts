/**
 * Intel PresentMon CSV parser (§8). Two console-capture generations share the
 * output shape with CapFrameX:
 *
 * - v1.x: `MsBetweenPresents` + `TimeInSeconds`, no busy-time or telemetry.
 * - v2.x: `FrameTime` (+ `CPUStartTime`), plus the GamersNexus-style
 *   bottleneck columns `CPUBusy`/`GPUBusy`, opt-in GPU telemetry
 *   (`GPUUtilization`/`GPUFrequency`/`GPUPower`/`GPUMemUsed`), and `FrameType`
 *   marking frame-generation (DLSS3/FSR3/XeSS) frames.
 *
 * Frame times are per-swapchain: an unfiltered capture interleaves the game
 * with dwm.exe and overlay swapchains, so rows are grouped by
 * Application/ProcessID/SwapChainAddress and only the dominant stream is kept
 * (with a `multiple-streams` warning when others were dropped).
 *
 * Bare PresentMon CSVs carry no hardware block, so `hardware` is never set.
 */

import { failure, success, type ParsedCapture, type ParseResult, type ParseWarning } from "./errors";
import { decodeInput, splitLines } from "./internal/decode";
import { findColumn, findCsvHeader, headerFailure, splitCsvLine, type FoundHeader } from "./internal/csv";
import { PRESENTMON_V1_COLUMNS, PRESENTMON_V2_COLUMNS } from "./internal/columns";
import { parseFrameRowsAt, type FrameRowsInput } from "./internal/frames";
import { parserVersionString } from "./version";

const SOURCE = "presentmon" as const;

export function parsePresentMon(input: string | Uint8Array): ParseResult<ParsedCapture> {
  const text = decodeInput(input);
  const lines = splitLines(text);
  if (lines.length === 0) return failure(SOURCE, "empty-input", "Input is empty.");

  // v2 is detected via its FrameTime column, v1 via MsBetweenPresents.
  const found = findCsvHeader(lines, [
    ...PRESENTMON_V2_COLUMNS.frameTimeMs,
    ...PRESENTMON_V1_COLUMNS.frameTimeMs,
  ]);
  if (found === undefined) return headerFailure(SOURCE, lines);

  const isV2 = findColumn(found.header, PRESENTMON_V2_COLUMNS.frameTimeMs) !== undefined;
  const columns = isV2 ? PRESENTMON_V2_COLUMNS : PRESENTMON_V1_COLUMNS;

  const stream = dominantStream(lines, found);
  const generatedColumn = findColumn(found.header, ["frametype"]);
  const rows = parseFrameRowsAt(SOURCE, lines, found, columns, {
    ...(stream.rowFilter === undefined ? {} : { rowFilter: stream.rowFilter }),
    ...(generatedColumn === undefined ? {} : { generatedColumn }),
  });
  if (!rows.ok) return rows;

  return success(
    { source: SOURCE, frames: rows.value, parserVersion: parserVersionString(SOURCE) },
    [...rows.warnings, ...stream.warnings],
  );
}

/**
 * Group data rows by (Application, ProcessID, SwapChainAddress) and pick the
 * stream with the most rows. Returns no filter when the columns are absent or
 * only one stream is present.
 */
function dominantStream(
  lines: readonly string[],
  found: FoundHeader,
): { rowFilter?: FrameRowsInput["rowFilter"]; warnings: ParseWarning[] } {
  const indices = ["application", "processid", "swapchainaddress"]
    .map((alias) => findColumn(found.header, [alias]))
    .filter((index): index is number => index !== undefined);
  if (indices.length === 0) return { warnings: [] };

  const keyOf = (cells: readonly string[]): string =>
    indices.map((index) => cells[index]?.trim() ?? "").join("|");

  const counts = new Map<string, number>();
  for (let i = found.index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const key = keyOf(splitCsvLine(line, found.dialect.delimiter));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size <= 1) return { warnings: [] };

  let dominant = "";
  let dominantCount = 0;
  let totalCount = 0;
  for (const [key, count] of counts) {
    totalCount += count;
    if (count > dominantCount) {
      dominant = key;
      dominantCount = count;
    }
  }

  const dropped = totalCount - dominantCount;
  return {
    rowFilter: (cells) => keyOf(cells) === dominant,
    warnings: [
      {
        code: "multiple-streams",
        message:
          `Capture contains ${counts.size} process/swapchain streams; ` +
          `kept the dominant one and dropped ${dropped} row(s) from the others.`,
        count: dropped,
      },
    ],
  };
}
