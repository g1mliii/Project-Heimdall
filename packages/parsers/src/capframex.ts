/**
 * CapFrameX parser (§7 — the launch wedge). Sniffs CSV vs JSON by the first
 * non-whitespace character: a CapFrameX *capture file* is JSON (frame arrays
 * under `Runs[].CaptureData` plus a hardware `Info` block); a CapFrameX
 * *export* is CSV (PresentMon-style columns plus appended sensor columns).
 * Bare CSVs carry no hardware block, so `hardware` is only present on JSON.
 */

import { MIN_FRAME_TIME_MS, type FrameSample, type HardwareSnapshot } from "@heimdall/shared";

import {
  failure,
  success,
  type CaptureParseOptions,
  type ParsedCapture,
  type ParseResult,
} from "./errors";
import { decodeInput, splitLines } from "./internal/decode";
import { findCsvHeader, headerFailure } from "./internal/csv";
import {
  CAPFRAMEX_COLUMNS,
  frameAlignedSensorMap,
  type SensorColumnField,
} from "./internal/columns";
import {
  finalizeFrames,
  guardSensor,
  parseFrameRowsAt,
  tooManyFramesFailure,
} from "./internal/frames";
import { inferGpuVendor } from "./internal/vendor";
import { parseVramTotalMb } from "./internal/hardware";
import { parserVersionString } from "./version";

const SOURCE = "capframex" as const;

export function parseCapFrameX(
  input: string | Uint8Array,
  { maxFrames }: CaptureParseOptions = {},
): ParseResult<ParsedCapture> {
  const text = decodeInput(input);
  const sniff = /\S/.exec(text)?.[0];
  if (sniff === undefined) return failure(SOURCE, "empty-input", "Input is empty.");
  if (sniff === "{" || sniff === "[") return parseJson(text, maxFrames);
  return parseCsv(text, maxFrames);
}

/* ── CSV branch (§7.1–§7.2) ─────────────────────────────────────────────── */

function parseCsv(text: string, maxFrames?: number): ParseResult<ParsedCapture> {
  const lines = splitLines(text);
  const found = findCsvHeader(lines, CAPFRAMEX_COLUMNS.frameTimeMs);
  if (found === undefined) return headerFailure(SOURCE, lines);

  const rows = parseFrameRowsAt(SOURCE, lines, found, CAPFRAMEX_COLUMNS, { maxFrames });
  if (!rows.ok) return rows;

  return success(
    {
      source: SOURCE,
      frames: rows.value,
      sensorAlignment: frameAlignedSensorMap(CAPFRAMEX_COLUMNS),
      parserVersion: parserVersionString(SOURCE),
    },
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
  cpuBusyMs: ["cpuactive"],
  gpuBusyMs: ["gpuactive", "msgpuactive"],
};

/** CPUActive is useful when present but is not emitted by every JSON generation. */
const JSON_EXPECTED_SENSOR_FIELDS = (
  Object.keys(JSON_SENSOR_KEYS) as SensorColumnField[]
).filter((field) => field !== "cpuBusyMs");

interface PeriodicSensorSeries {
  timesMs: number[];
  values: number[];
}

type PeriodicSensors = Partial<Record<SensorColumnField, PeriodicSensorSeries>>;
type PeriodicSensorEntry = [SensorColumnField, PeriodicSensorSeries];

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

/** Map a CapFrameX 1.8.6 SensorData2 channel onto the canonical sensor fields. */
function sensorData2Field(channel: Record<string, unknown>): SensorColumnField | undefined {
  const type = getCi(channel, ["type"]);
  const name = getCi(channel, ["name"]);
  const stableIdentifier = getCi(channel, ["stableidentifier"]);
  if (typeof type !== "string") return undefined;

  const normalizedType = type.trim().toLowerCase();
  const normalizedName = typeof name === "string" ? name.trim().toLowerCase() : "";
  const normalizedStable =
    typeof stableIdentifier === "string" ? stableIdentifier.trim().toLowerCase() : "";
  const matches = (expectedName: string, stableSuffix: string): boolean =>
    normalizedName === expectedName || normalizedStable.endsWith(stableSuffix);

  if (normalizedType === "load" && matches("gpu core", "/load/gpu core")) {
    return "gpuLoadPct";
  }
  if (normalizedType === "clock" && matches("gpu core", "/clock/gpu core")) {
    return "gpuClockMhz";
  }
  if (normalizedType === "power" && matches("gpu tbp", "/power/gpu tbp")) {
    return "gpuPowerW";
  }
  if (
    normalizedType === "data" &&
    matches("gpu memory dedicated", "/data/gpu memory dedicated")
  ) {
    return "vramUsedMb";
  }
  if (normalizedType === "load" && matches("cpu total", "/load/cpu total")) {
    return "cpuLoadPct";
  }
  return undefined;
}

/**
 * Read CapFrameX's periodic SensorData2 blocks. Each block has a MeasureTime
 * channel and several independently sized sensor `Values` arrays.
 */
function parseSensorData2(value: unknown): PeriodicSensors {
  const blocks = Array.isArray(value) ? value : [value];
  const result: PeriodicSensors = {};
  const needsSort = new Set<SensorColumnField>();

  for (const rawBlock of blocks) {
    const block = asRecord(rawBlock);
    if (block === undefined) continue;
    const measureTime = asRecord(getCi(block, ["measuretime"]));
    const times = measureTime === undefined ? undefined : getCi(measureTime, ["values"]);
    if (!Array.isArray(times)) continue;
    const timesMs = times.map((_, index) => {
      const seconds = numberAt(times, index);
      return seconds === undefined || seconds < 0 ? undefined : seconds * 1000;
    });

    for (const rawChannel of Object.values(block)) {
      const channel = asRecord(rawChannel);
      if (channel === undefined) continue;
      const field = sensorData2Field(channel);
      if (field === undefined) continue;
      const values = getCi(channel, ["values"]);
      if (!Array.isArray(values)) continue;

      const scale = field === "vramUsedMb" ? 1024 : 1;
      const sampleCount = Math.min(times.length, values.length);
      for (let index = 0; index < sampleCount; index++) {
        const timeMs = timesMs[index];
        const raw = numberAt(values, index);
        const sensorValue = guardSensor(field, raw === undefined ? undefined : raw * scale);
        if (timeMs === undefined || sensorValue === undefined) continue;
        const series = (result[field] ??= { timesMs: [], values: [] });
        if (series.timesMs.length > 0 && series.timesMs.at(-1)! > timeMs) needsSort.add(field);
        series.timesMs.push(timeMs);
        series.values.push(sensorValue);
      }
    }
  }

  for (const field of needsSort) {
    const series = result[field]!;
    const indices = series.timesMs.map((_, index) => index);
    indices.sort((left, right) => series.timesMs[left]! - series.timesMs[right]!);
    series.timesMs = indices.map((index) => series.timesMs[index]!);
    series.values = indices.map((index) => series.values[index]!);
  }
  return result;
}

/** Attach the latest periodic sample at-or-before this frame, without looking ahead. */
function attachPeriodicSensors(
  frame: FrameSample,
  sensors: readonly PeriodicSensorEntry[],
  localTimeMs: number,
  cursors: Partial<Record<SensorColumnField, number>>,
): void {
  for (const [field, series] of sensors) {
    if (frame[field] !== undefined || series.values.length === 0) continue;
    let cursor = cursors[field] ?? -1;
    while (cursor + 1 < series.timesMs.length && series.timesMs[cursor + 1]! <= localTimeMs) {
      cursor++;
    }
    cursors[field] = cursor;
    if (cursor < 0) continue;
    frame[field] = series.values[cursor]!;
  }
}

function parseJson(text: string, maxFrames?: number): ParseResult<ParsedCapture> {
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
  const captureRuns = runs
    .map((run) => {
      const runObj = asRecord(run);
      if (runObj === undefined) return undefined;
      const capture = asRecord(getCi(runObj, ["capturedata"]));
      return capture === undefined
        ? undefined
        : { capture, sensorData2: getCi(runObj, ["sensordata2"]) };
    })
    .filter((run): run is { capture: Record<string, unknown>; sensorData2: unknown } =>
      run !== undefined,
    );
  if (captureRuns.length === 0) {
    return failure(SOURCE, "missing-columns", "JSON has no Runs[].CaptureData block.");
  }

  const frames: FrameSample[] = [];
  const missingSensors = new Set<SensorColumnField>(JSON_EXPECTED_SENSOR_FIELDS);
  let badRows = 0;
  let totalRows = 0;
  let nextRunOffsetMs = 0;
  const sensorAlignment: Partial<Record<SensorColumnField, boolean>> = {};

  for (const { capture, sensorData2 } of captureRuns) {
    const frameTimes = getCi(capture, ["msbetweenpresents"]);
    if (!Array.isArray(frameTimes)) {
      return failure(SOURCE, "missing-columns", "CaptureData lacks a MsBetweenPresents array.");
    }
    const times = getCi(capture, ["timeinseconds"]);
    const timesArray = Array.isArray(times) ? times : undefined;
    let baselineMs: number | undefined;
    let lastRawMs: number | undefined;
    const runOffsetMs = nextRunOffsetMs;
    let runCumulativeMs = 0;
    let runEndMs = runOffsetMs;
    const periodicSensors = parseSensorData2(sensorData2);
    const periodicEntries = Object.entries(periodicSensors) as PeriodicSensorEntry[];
    const periodicCursors: Partial<Record<SensorColumnField, number>> = {};
    for (const [field] of periodicEntries) {
      missingSensors.delete(field);
      sensorAlignment[field] = false;
    }

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
      sensorAlignment[field] ??= true;
      sensorArrays.push([field, array]);
    }

    for (let i = 0; i < frameTimes.length; i++) {
      totalRows++;
      const frameTimeMs = numberAt(frameTimes, i);
      if (frameTimeMs === undefined || frameTimeMs < MIN_FRAME_TIME_MS) {
        badRows++;
        continue;
      }

      let localTimeMs: number;
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
        localTimeMs = rawMs - (baselineMs ?? rawMs);
        baselineMs ??= rawMs;
        lastRawMs = rawMs;
      } else {
        localTimeMs = runCumulativeMs;
      }

      if (maxFrames !== undefined && frames.length >= maxFrames) {
        return tooManyFramesFailure(SOURCE, maxFrames);
      }

      const frame: FrameSample = { timeMs: runOffsetMs + localTimeMs, frameTimeMs };
      for (const [field, array] of sensorArrays) {
        const value = guardSensor(field, numberAt(array, i));
        if (value !== undefined) frame[field] = value;
      }
      attachPeriodicSensors(frame, periodicEntries, localTimeMs, periodicCursors);

      runCumulativeMs += frameTimeMs;
      runEndMs = Math.max(runEndMs, frame.timeMs + frameTimeMs);
      frames.push(frame);
    }
    nextRunOffsetMs = runEndMs;
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
    sensorAlignment,
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
  const vramTotalMb = parseVramTotalMb(
    getCi(info, ["gpumemorytotal", "gpumemtotal", "gpudedicatedmemory", "graphiccardmemory", "gpumemory"]),
  );
  if (vramTotalMb !== undefined) hardware.gpuVramTotalMb = vramTotalMb;

  return hardware;
}
