/**
 * Intel PresentMon CSV parser (§8). Three tested output profiles share the
 * same normalized shape as CapFrameX:
 *
 * - v1.x: `MsBetweenPresents` + `TimeInSeconds`, no busy-time or telemetry.
 * - v2.x `--v1_metrics`: the v1-compatible columns plus `msGPUActive`.
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
  type CaptureParseOptions,
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
  PRESENTMON_V1_COMPAT_COLUMNS,
  PRESENTMON_V1_COLUMNS,
  PRESENTMON_V2_COLUMNS,
  frameAlignedSensorMap,
} from "./internal/columns";
import { parseFrameRowsAt, type FrameRowsInput } from "./internal/frames";
import { parserVersionString } from "./version";

const SOURCE = "presentmon" as const;
const MAX_TRACKED_STREAMS = 1_024;

export function parsePresentMon(
  input: string | Uint8Array,
  { maxFrames }: CaptureParseOptions = {},
): ParseResult<ParsedCapture> {
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
  const isV1MetricsCompat =
    !isV2 &&
    findColumn(found.header, PRESENTMON_V1_COMPAT_COLUMNS.sensors.gpuBusyMs ?? []) !== undefined;
  const columns = isV2
    ? PRESENTMON_V2_COLUMNS
    : isV1MetricsCompat
      ? PRESENTMON_V1_COMPAT_COLUMNS
      : PRESENTMON_V1_COLUMNS;
  const captureProfile = isV2
    ? PRESENTMON_PROFILES.v2
    : isV1MetricsCompat
      ? PRESENTMON_PROFILES.v1MetricsCompat
      : PRESENTMON_PROFILES.v1;

  const stream = dominantStream(lines, found);
  if (stream.error !== undefined) return failure(SOURCE, "too-many-streams", stream.error);
  const generatedColumn = findColumn(found.header, ["frametype"]);
  const rows = parseFrameRowsAt(SOURCE, lines, found, columns, {
    ...(stream.rowFilter === undefined ? {} : { rowFilter: stream.rowFilter }),
    ...(generatedColumn === undefined ? {} : { generatedColumn }),
    ...(isV2 ? presentMonV2TimeColumn(found) : {}),
    ...(maxFrames === undefined ? {} : { maxFrames }),
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
      sensorAlignment: frameAlignedSensorMap(columns),
      ...(captureSemantics ? { captureSemantics } : {}),
    },
    [...rows.warnings, ...stream.warnings],
  );
}

/** PresentMon 2.x writes CPUStartTime in milliseconds, not seconds. */
function presentMonV2TimeColumn(found: FoundHeader): Pick<FrameRowsInput, "timeColumn"> {
  const index = findColumn(found.header, ["cpustarttime"]);
  return index === undefined ? {} : { timeColumn: { index, unit: "milliseconds" } };
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

/**
 * Normalize the small runtime vocabulary PresentMon writes into methodology.
 *
 * `Runtime` names the PRESENT runtime, not the graphics API: DXGI is what every
 * D3D10/11/12 title presents through, so it cannot tell DX11 from DX12 and is
 * NOT evidence of an API. Returning it verbatim would pool DX11 and DX12 runs
 * into one comparability bucket — exactly what the graphics-API key exists to
 * prevent. Only a value that names an API on its own is mapped; anything else
 * degrades to "undeclared" (§16d.1) and the user declares the API instead.
 */
function toGraphicsApi(raw: string): string | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "d3d12" || value === "direct3d 12") return "dx12";
  if (value === "d3d11" || value === "direct3d 11") return "dx11";
  if (value === "d3d9" || value === "direct3d 9") return "dx9";
  if (value === "vulkan") return "vulkan";
  return undefined;
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
function noDominantStreamError(): { warnings: ParseWarning[]; error: string } {
  return {
    warnings: [],
    error:
      `Capture contains more than ${MAX_TRACKED_STREAMS} process/swapchain streams ` +
      "and none of them dominates.",
  };
}

function dominantStream(
  lines: readonly string[],
  found: FoundHeader,
): {
  rowFilter?: FrameRowsInput["rowFilter"];
  firstRow?: readonly string[];
  warnings: ParseWarning[];
  error?: string;
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
  // Retain at most one row per bounded stream so semantics detection does not
  // need to rescan a potentially 500k-frame capture after grouping it.
  const firstRows = new Map<string, readonly string[]>();
  let totalCount = 0;
  let evicted = false;
  for (let i = found.index + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const cells = splitCsvLine(line, found.dialect.delimiter);
    totalCount++;
    const key = keyOf(cells);
    const previous = counts.get(key);
    if (previous !== undefined) {
      counts.set(key, previous + 1);
      continue;
    }
    if (counts.size >= MAX_TRACKED_STREAMS) {
      // Misra-Gries: charge an untracked stream against every tracked one
      // rather than rejecting the capture. A long system-wide session can pass
      // MAX_TRACKED_STREAMS on transient swapchains alone, and failing there
      // would make it unuploadable. Any stream holding more than
      // 1/(MAX_TRACKED_STREAMS + 1) of all rows — which a real capture's game
      // stream always does — cannot be evicted by this, so the dominant stream
      // is still tracked when the scan ends. Amortized O(1) per row: each pass
      // consumes MAX_TRACKED_STREAMS counts against a total of `totalCount`.
      evicted = true;
      for (const [tracked, count] of counts) {
        if (count > 1) {
          counts.set(tracked, count - 1);
        } else {
          counts.delete(tracked);
          firstRows.delete(tracked);
        }
      }
      continue;
    }
    counts.set(key, 1);
    firstRows.set(key, cells);
  }

  if (!evicted && counts.size <= 1) {
    return { warnings: [], firstRow: firstRows.values().next().value };
  }
  if (counts.size === 0) {
    // Every tracked stream was evicted, so no stream holds a large enough share
    // to be the dominant one. There is nothing to attribute this capture to.
    return noDominantStreamError();
  }

  // Eviction leaves the surviving counts as lower bounds, so recount them
  // exactly before picking a winner and reporting how much was dropped.
  if (evicted) {
    for (const key of counts.keys()) counts.set(key, 0);
    for (let i = found.index + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      const key = keyOf(splitCsvLine(line, found.dialect.delimiter));
      const count = counts.get(key);
      if (count !== undefined) counts.set(key, count + 1);
    }
  }

  let dominant = "";
  let dominantCount = 0;
  for (const [key, count] of counts) {
    if (count > dominantCount) {
      dominant = key;
      dominantCount = count;
    }
  }

  // Misra-Gries only guarantees retention for a stream above this share. A
  // lower-count survivor can be an arbitrary residue of the eviction pass, so
  // selecting it would silently turn a multi-stream capture into unrelated
  // frame data.
  if (evicted && dominantCount * (MAX_TRACKED_STREAMS + 1) <= totalCount) {
    return noDominantStreamError();
  }

  const dropped = totalCount - dominantCount;
  return {
    rowFilter: (cells) => keyOf(cells) === dominant,
    firstRow: firstRows.get(dominant),
    warnings: [
      {
        code: "multiple-streams",
        message:
          (evicted
            ? `Capture contains over ${MAX_TRACKED_STREAMS} process/swapchain streams; `
            : `Capture contains ${counts.size} process/swapchain streams; `) +
          `kept the dominant one and dropped ${dropped} row(s) from the others.`,
        count: dropped,
      },
    ],
  };
}
