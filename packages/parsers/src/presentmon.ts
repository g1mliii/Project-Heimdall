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

import type { PresentationMode, SyncMode } from "@heimdall/shared";

import {
  failure,
  success,
  type CaptureSemantics,
  type ParsedCapture,
  type ParseResult,
  type ParseWarning,
} from "./errors";
import { decodeInput, splitLines } from "./internal/decode";
import { findColumn, findCsvHeader, headerFailure, splitCsvLine, type FoundHeader } from "./internal/csv";
import {
  PRESENTMON_PROFILES,
  PRESENTMON_SEMANTICS_COLUMNS,
  PRESENTMON_V1_COLUMNS,
  PRESENTMON_V2_COLUMNS,
} from "./internal/columns";
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
  const captureProfile = isV2 ? PRESENTMON_PROFILES[1] : PRESENTMON_PROFILES[0];

  const stream = dominantStream(lines, found);
  const generatedColumn = findColumn(found.header, ["frametype"]);
  const rows = parseFrameRowsAt(SOURCE, lines, found, columns, {
    ...(stream.rowFilter === undefined ? {} : { rowFilter: stream.rowFilter }),
    ...(generatedColumn === undefined ? {} : { generatedColumn }),
  });
  if (!rows.ok) return rows;

  // Both pinned profiles can expose a runtime; v2 additionally exposes the
  // presentation/sync columns the merged frame stream cannot reveal (§16a.2).
  const captureSemantics = detectPresentMonSemanticsFromRow(stream.firstRow, found);

  return success(
    {
      source: SOURCE,
      frames: rows.value,
      parserVersion: parserVersionString(SOURCE),
      captureProfile: captureProfile.id,
      ...(captureSemantics ? { captureSemantics } : {}),
    },
    [...rows.warnings, ...stream.warnings],
  );
}

/** Map a PresentMon `PresentMode` cell to a canonical presentation mode (§16a.3). */
function toPresentationMode(raw: string): PresentationMode {
  const value = raw.trim().toLowerCase();
  if (value === "") return "unknown";
  if (value.includes("hardware composed")) return "hardware-composed-flip";
  if (value.includes("hardware")) return "hardware-independent-flip";
  if (value.includes("composed")) return "composed";
  if (value.includes("legacy")) return "legacy";
  return "unknown";
}

/**
 * Read presentation/sync semantics from the first kept data row's PresentMode /
 * AllowsTearing / SyncInterval cells. These are per-frame columns but stable
 * across a capture, so the first row of the selected stream is representative.
 * Returns `undefined` when the capture exposes none of them.
 */
function detectPresentMonSemanticsFromRow(
  firstRow: readonly string[] | undefined,
  found: FoundHeader,
): CaptureSemantics | undefined {
  const runtimeIndex = findColumn(found.header, PRESENTMON_SEMANTICS_COLUMNS.runtime);
  const presentModeIndex = findColumn(found.header, PRESENTMON_SEMANTICS_COLUMNS.presentMode);
  const tearingIndex = findColumn(found.header, PRESENTMON_SEMANTICS_COLUMNS.allowsTearing);
  const syncIntervalIndex = findColumn(found.header, PRESENTMON_SEMANTICS_COLUMNS.syncInterval);
  if (
    runtimeIndex === undefined &&
    presentModeIndex === undefined &&
    tearingIndex === undefined &&
    syncIntervalIndex === undefined
  ) {
    return undefined;
  }

  if (firstRow === undefined) return undefined;

  const semantics: CaptureSemantics = {};
  if (runtimeIndex !== undefined) {
    const graphicsApi = toGraphicsApi(firstRow[runtimeIndex] ?? "");
    if (graphicsApi !== undefined) semantics.graphicsApi = graphicsApi;
  }
  if (presentModeIndex !== undefined) {
    const mode = toPresentationMode(firstRow[presentModeIndex] ?? "");
    if (mode !== "unknown") semantics.presentationMode = mode;
  }

  const syncMode = detectSyncMode(
    tearingIndex === undefined ? undefined : firstRow[tearingIndex],
    syncIntervalIndex === undefined ? undefined : firstRow[syncIntervalIndex],
  );
  if (syncMode !== undefined) semantics.syncMode = syncMode;

  return semantics.presentationMode === undefined &&
    semantics.syncMode === undefined &&
    semantics.graphicsApi === undefined
    ? undefined
    : semantics;
}

/**
 * Read semantics from the first matching data row. Exported for callers that
 * parse a PresentMon CSV outside {@link parsePresentMon}; the main parser
 * avoids this additional scan by retaining the selected stream's first row.
 */
export function detectPresentMonSemantics(
  lines: readonly string[],
  found: FoundHeader,
  rowFilter?: FrameRowsInput["rowFilter"],
): CaptureSemantics | undefined {
  for (let i = found.index + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === "") continue;
    const cells = splitCsvLine(lines[i]!, found.dialect.delimiter);
    if (rowFilter !== undefined && !rowFilter(cells)) continue;
    return detectPresentMonSemanticsFromRow(cells, found);
  }
  return undefined;
}

/** Normalize the small runtime vocabulary PresentMon writes into methodology. */
function toGraphicsApi(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "") return undefined;
  if (value === "d3d12" || value === "direct3d 12") return "dx12";
  if (value === "d3d11" || value === "direct3d 11") return "dx11";
  return value;
}

/**
 * A tearing-allowed present is unsynced; a non-zero SyncInterval is VSync. VRR
 * is not distinguishable from a bare PresentMon CSV, so it is never inferred
 * here — it is declared by the desktop client (Phase 9).
 */
function detectSyncMode(tearingCell?: string, syncIntervalCell?: string): SyncMode | undefined {
  if (tearingCell !== undefined && tearingCell.trim() === "1") return "tearing";
  if (syncIntervalCell !== undefined) {
    const interval = Number(syncIntervalCell.trim());
    if (Number.isFinite(interval) && interval > 0) return "vsync";
  }
  return undefined;
}

/**
 * Group data rows by (Application, ProcessID, SwapChainAddress) and pick the
 * stream with the most rows. Returns no filter when the columns are absent or
 * only one stream is present.
 */
function dominantStream(
  lines: readonly string[],
  found: FoundHeader,
): {
  rowFilter?: FrameRowsInput["rowFilter"];
  firstRow?: readonly string[];
  warnings: ParseWarning[];
} {
  const indices = ["application", "processid", "swapchainaddress"]
    .map((alias) => findColumn(found.header, [alias]))
    .filter((index): index is number => index !== undefined);
  if (indices.length === 0) {
    for (let i = found.index + 1; i < lines.length; i++) {
      if (lines[i]!.trim() !== "") {
        return { warnings: [], firstRow: splitCsvLine(lines[i]!, found.dialect.delimiter) };
      }
    }
    return { warnings: [] };
  }

  const keyOf = (cells: readonly string[]): string =>
    indices.map((index) => cells[index]?.trim() ?? "").join("|");

  const counts = new Map<string, number>();
  const firstRows = new Map<string, readonly string[]>();
  for (let i = found.index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line, found.dialect.delimiter);
    const key = keyOf(cells);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstRows.has(key)) firstRows.set(key, cells);
  }
  if (counts.size <= 1) return { warnings: [], firstRow: firstRows.values().next().value };

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
    firstRow: firstRows.get(dominant),
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
