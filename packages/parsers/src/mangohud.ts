/**
 * MangoHud log parser (§8). A MangoHud CSV log opens with sysinfo lines — a
 * key row (`os,cpu,gpu,ram,kernel,driver,...`) followed by its value row —
 * then the frame-data header (`fps,frametime,...`). `frametime` is already in
 * milliseconds; the row timestamp is `elapsed` in nanoseconds; `gpu_vram_used`
 * is logged in GiB and converted to MB here (synthetic-provenance assumption —
 * see fixtures/README.md).
 */

import type { HardwareSnapshot } from "@heimdall/shared";

import { failure, success, type ParsedCapture, type ParseResult } from "./errors";
import { decodeInput, splitLines } from "./internal/decode";
import { findColumn, findCsvHeader, headerFailure, splitCsvLine, type FoundHeader } from "./internal/csv";
import { MANGOHUD_COLUMNS } from "./internal/columns";
import { parseFrameRowsAt } from "./internal/frames";
import { inferGpuVendor } from "./internal/vendor";
import { parseVramTotalMb } from "./internal/hardware";
import { parserVersionString } from "./version";

const SOURCE = "mangohud" as const;

/** Sysinfo values above ~256 in the `ram` slot are MB, not GB (heuristic). */
const RAM_MB_THRESHOLD = 256;

export function parseMangoHud(input: string | Uint8Array): ParseResult<ParsedCapture> {
  const text = decodeInput(input);
  const lines = splitLines(text);
  if (lines.length === 0) return failure(SOURCE, "empty-input", "Input is empty.");

  const found = findCsvHeader(lines, MANGOHUD_COLUMNS.frameTimeMs);
  if (found === undefined) return headerFailure(SOURCE, lines);

  const elapsedIndex = findColumn(found.header, ["elapsed"]);
  const rows = parseFrameRowsAt(SOURCE, lines, found, MANGOHUD_COLUMNS, {
    ...(elapsedIndex === undefined
      ? {}
      : { timeColumn: { index: elapsedIndex, unit: "nanoseconds" as const } }),
    sensorScale: { vramUsedMb: 1024 }, // gpu_vram_used is GiB
  });
  if (!rows.ok) return rows;

  const value: ParsedCapture = {
    source: SOURCE,
    frames: rows.value,
    parserVersion: parserVersionString(SOURCE),
  };
  const hardware = extractHardware(lines, found);
  if (hardware !== undefined) value.hardware = hardware;
  return success(value, rows.warnings);
}

/**
 * Sysinfo block → HardwareSnapshot: scan the lines above the data header for a
 * key row containing both `cpu` and `gpu`, and read the row after it as the
 * values. Absent or unusable sysinfo just means no hardware — never an error.
 */
function extractHardware(lines: readonly string[], found: FoundHeader): HardwareSnapshot | undefined {
  for (let i = 0; i < found.index; i++) {
    const keys = splitCsvLine(lines[i]!, ",").map((k) => k.trim().toLowerCase());
    if (!keys.includes("cpu") || !keys.includes("gpu")) continue;
    // The value row must itself sit above the data header — otherwise a key
    // row with its value row lost would read the header cells as hardware.
    if (i + 1 >= found.index) return undefined;
    const values = splitCsvLine(lines[i + 1]!, ",").map((v) => v.trim());

    const at = (key: string): string | undefined => {
      const index = keys.indexOf(key);
      const value = index === -1 ? undefined : values[index];
      return value === undefined || value === "" ? undefined : value;
    };

    const gpu = at("gpu");
    const cpu = at("cpu");
    if (gpu === undefined || cpu === undefined) return undefined;

    const hardware: HardwareSnapshot = { gpu, cpu, gpuVendor: inferGpuVendor(gpu) };
    const os = at("os");
    if (os !== undefined) hardware.os = os;
    const driver = at("driver");
    if (driver !== undefined) hardware.gpuDriver = driver;
    const ram = at("ram");
    if (ram !== undefined) {
      const parsed = Number.parseFloat(ram);
      if (Number.isFinite(parsed) && parsed > 0) {
        hardware.ramGb = parsed > RAM_MB_THRESHOLD ? parsed / 1024 : parsed;
      }
    }
    // Only the explicit total key — a bare `vram` sysinfo field is ambiguous
    // (often instantaneous/used), and mis-reading it as capacity would fire a
    // false VRAM-saturation diagnostic (§15.1).
    const vramTotalMb = parseVramTotalMb(at("gpu_vram_total"));
    if (vramTotalMb !== undefined) hardware.gpuVramTotalMb = vramTotalMb;
    return hardware;
  }
  return undefined;
}
