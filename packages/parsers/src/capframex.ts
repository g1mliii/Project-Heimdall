/**
 * CapFrameX parser (§7 — the launch wedge). Sniffs CSV vs JSON by the first
 * non-whitespace character: a CapFrameX *capture file* is JSON (frame arrays
 * under `Runs[].CaptureData` plus a hardware `Info` block); a CapFrameX
 * *export* is CSV (PresentMon-style columns plus appended sensor columns).
 * Bare CSVs carry no hardware block, so `hardware` is only present on JSON.
 */

import { MIN_FRAME_TIME_MS, type FrameSample, type HardwareSnapshot } from "@heimdall/shared";

import { failure, success, type ParsedCapture, type ParseResult } from "./errors";
import { decodeInput, splitLines } from "./internal/decode";
import { findCsvHeader, headerFailure } from "./internal/csv";
import { CAPFRAMEX_COLUMNS, type SensorColumnField } from "./internal/columns";
import { finalizeFrames, guardSensor, parseFrameRowsAt } from "./internal/frames";
import { inferGpuVendor } from "./internal/vendor";
import { parserVersionString } from "./version";

const SOURCE = "capframex" as const;

export function parseCapFrameX(input: string | Uint8Array): ParseResult<ParsedCapture> {
  const text = decodeInput(input);
  const sniff = /\S/.exec(text)?.[0];
  if (sniff === undefined) return failure(SOURCE, "empty-input", "Input is empty.");
  if (sniff === "{" || sniff === "[") return parseJson(text);
  return parseCsv(text);
}

/* ── CSV branch (§7.1–§7.2) ─────────────────────────────────────────────── */

function parseCsv(text: string): ParseResult<ParsedCapture> {
  const lines = splitLines(text);
  const found = findCsvHeader(lines, CAPFRAMEX_COLUMNS.frameTimeMs);
  if (found === undefined) return headerFailure(SOURCE, lines);

  const rows = parseFrameRowsAt(SOURCE, lines, found, CAPFRAMEX_COLUMNS);
  if (!rows.ok) return rows;

  return success(
    { source: SOURCE, frames: rows.value, parserVersion: parserVersionString(SOURCE) },
    rows.warnings,
  );
}

/* ── JSON branch (§7.1 hardware extraction) ─────────────────────────────── */

/** JSON sensor-array keys per FrameSample field (case-insensitive). */
const JSON_SENSOR_KEYS: Partial<Record<SensorColumnField, readonly string[]>> = {
  gpuLoadPct: ["gpuusage"],
  gpuClockMhz: ["gpuclock"],
  gpuPowerW: ["gpupower"],
  vramUsedMb: ["gpumemusage"],
  cpuLoadPct: ["cpuusage"],
  gpuBusyMs: ["msgpuactive"],
};

/** Case-insensitive property lookup on a plain object. */
function getCi(obj: Record<string, unknown>, names: readonly string[]): unknown {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const [key, value] of Object.entries(obj)) {
    if (wanted.has(key.toLowerCase())) return value;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberAt(array: unknown, index: number): number | undefined {
  if (!Array.isArray(array)) return undefined;
  const value: unknown = array[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJson(text: string): ParseResult<ParsedCapture> {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failure(SOURCE, "invalid-json", `Not valid JSON: ${detail}`);
  }

  const rootObj = asRecord(root);
  if (rootObj === undefined) {
    return failure(SOURCE, "unrecognized-format", "JSON root is not an object.");
  }

  const runsRaw = getCi(rootObj, ["runs"]);
  const runs = Array.isArray(runsRaw) ? runsRaw : [];
  const captures = runs
    .map((run) => {
      const runObj = asRecord(run);
      return runObj === undefined ? undefined : asRecord(getCi(runObj, ["capturedata"]));
    })
    .filter((c): c is Record<string, unknown> => c !== undefined);
  if (captures.length === 0) {
    return failure(SOURCE, "missing-columns", "JSON has no Runs[].CaptureData block.");
  }

  const frames: FrameSample[] = [];
  const missingSensors = new Set<SensorColumnField>(
    Object.keys(JSON_SENSOR_KEYS) as SensorColumnField[],
  );
  let badRows = 0;
  let totalRows = 0;
  let cumulativeMs = 0;

  // Multi-run captures are concatenated; per-run TimeInSeconds restarts, so we
  // only trust it for single-run files and fall back to the cumulative sum of
  // frame times otherwise.
  const useTimes = captures.length === 1;

  for (const capture of captures) {
    const frameTimes = getCi(capture, ["msbetweenpresents"]);
    if (!Array.isArray(frameTimes)) {
      return failure(SOURCE, "missing-columns", "CaptureData lacks a MsBetweenPresents array.");
    }
    const times = useTimes ? getCi(capture, ["timeinseconds"]) : undefined;
    const timesArray = Array.isArray(times) ? times : undefined;
    let baselineMs: number | undefined;
    let lastRawMs: number | undefined;

    // Resolve each sensor array once per capture — getCi scans every
    // CaptureData key, so calling it per frame would be O(frames × keys).
    const sensorArrays: [SensorColumnField, unknown[]][] = [];
    for (const [field, keys] of Object.entries(JSON_SENSOR_KEYS) as [
      SensorColumnField,
      readonly string[],
    ][]) {
      const array = getCi(capture, keys);
      if (!Array.isArray(array)) continue;
      missingSensors.delete(field);
      sensorArrays.push([field, array]);
    }

    for (let i = 0; i < frameTimes.length; i++) {
      totalRows++;
      const frameTimeMs = numberAt(frameTimes, i);
      if (frameTimeMs === undefined || frameTimeMs < MIN_FRAME_TIME_MS) {
        badRows++;
        continue;
      }

      let timeMs: number;
      if (timesArray !== undefined) {
        const rawSeconds = numberAt(timesArray, i);
        if (rawSeconds === undefined) {
          badRows++;
          continue;
        }
        const rawMs = rawSeconds * 1000;
        if (lastRawMs !== undefined && rawMs < lastRawMs) {
          // Backwards timestamp — same monotonicity policy as the row engine.
          badRows++;
          continue;
        }
        timeMs = rawMs - (baselineMs ?? rawMs);
        baselineMs ??= rawMs;
        lastRawMs = rawMs;
      } else {
        timeMs = cumulativeMs;
      }

      const frame: FrameSample = { timeMs, frameTimeMs };
      for (const [field, array] of sensorArrays) {
        const value = guardSensor(field, numberAt(array, i));
        if (value !== undefined) frame[field] = value;
      }

      cumulativeMs += frameTimeMs;
      frames.push(frame);
    }
  }

  const rows = finalizeFrames(SOURCE, {
    frames,
    badRows,
    dataRows: totalRows,
    missingSensors: [...missingSensors],
  });
  if (!rows.ok) return rows;

  const value: ParsedCapture = {
    source: SOURCE,
    frames: rows.value,
    parserVersion: parserVersionString(SOURCE),
  };
  const hardware = extractHardware(rootObj);
  if (hardware !== undefined) value.hardware = hardware;
  return success(value, rows.warnings);
}

/** `Info` / `SystemInfo` / `HardwareInfo` → HardwareSnapshot (gpu+cpu required). */
function extractHardware(root: Record<string, unknown>): HardwareSnapshot | undefined {
  const info = asRecord(getCi(root, ["info", "systeminfo", "hardwareinfo"]));
  if (info === undefined) return undefined;

  const gpu = getCi(info, ["gpu", "graphiccardname", "graphicscard"]);
  const cpu = getCi(info, ["processor", "cpu"]);
  if (typeof gpu !== "string" || gpu.trim() === "" || typeof cpu !== "string" || cpu.trim() === "") {
    return undefined;
  }

  const hardware: HardwareSnapshot = {
    gpu: gpu.trim(),
    cpu: cpu.trim(),
    gpuVendor: inferGpuVendor(gpu),
  };

  const os = getCi(info, ["os", "osversion"]);
  if (typeof os === "string" && os.trim() !== "") hardware.os = os.trim();
  const driver = getCi(info, ["gpudriverversion", "gpudriver", "driverversion"]);
  if (typeof driver === "string" && driver.trim() !== "") hardware.gpuDriver = driver.trim();
  const resolution = getCi(info, ["resolution", "screenresolution"]);
  if (typeof resolution === "string" && resolution.trim() !== "") {
    hardware.resolution = resolution.trim();
  }
  const ram = getCi(info, ["systemram", "ram"]);
  if (typeof ram === "string") {
    const gb = Number.parseFloat(ram);
    if (Number.isFinite(gb) && gb > 0) hardware.ramGb = gb;
  } else if (typeof ram === "number" && Number.isFinite(ram) && ram > 0) {
    hardware.ramGb = ram;
  }

  return hardware;
}
