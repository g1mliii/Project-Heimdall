/**
 * Shared row→FrameSample engine. Each source parser locates its header and
 * resolves its column aliases; this module owns the per-row semantics so the
 * row-tolerance policy (§Phase 3), sensor plausibility guards, and timestamp
 * normalization behave identically across CapFrameX / PresentMon / MangoHud.
 */

import { MIN_FRAME_TIME_MS, type CaptureSource, type FrameSample } from "@heimdall/shared";

import { BAD_ROW_FRACTION_LIMIT, failure, type ParseResult, type ParseWarning } from "../errors";
import { parseLocaleNumber, splitCsvLine, findColumn, type CsvDialect, type FoundHeader } from "./csv";
import { SENSOR_COLUMN_FIELDS, type SensorColumnField, type SourceColumns } from "./columns";

export interface FrameRowsInput {
  source: CaptureSource;
  /** Source lines; callers may point `lineStart` at the first data row to avoid slicing. */
  lines: readonly string[];
  /** Zero-based index in `lines` where data rows begin. */
  lineStart?: number;
  /** 1-based line number of `lines[0]` in the original file. */
  firstLineNumber: number;
  dialect: CsvDialect;
  /** Header map from `buildHeaderMap`, used to resolve `columns` aliases. */
  header: Map<string, number>;
  columns: SourceColumns;
  /**
   * Explicit timestamp column override (e.g. MangoHud `elapsed` nanoseconds).
   * When absent, `columns.timeSeconds` is used; when that is also missing the
   * timestamp falls back to the cumulative sum of frame times.
   */
  timeColumn?: { index: number; unit: "seconds" | "milliseconds" | "nanoseconds" };
  /** Per-field multiplier for unit conversion (e.g. MangoHud VRAM GB→MB). */
  sensorScale?: Partial<Record<SensorColumnField, number>>;
  /**
   * Rows this returns `false` for are skipped silently — they belong to a
   * different stream (PresentMon swapchain filtering), not to this capture,
   * so they count as neither good nor bad.
   */
  rowFilter?: (cells: readonly string[]) => boolean;
  /**
   * Column whose cell marks a generated frame (PresentMon v2 `FrameType`):
   * any non-empty value other than `Application` sets `frame.generated`.
   */
  generatedColumn?: number;
  /** Reject on the first valid frame beyond this limit instead of retaining it. */
  maxFrames?: number;
}

/** Plausibility guard: implausible sensor readings become "absent", not row-fatal. */
export function guardSensor(field: SensorColumnField, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (field === "gpuLoadPct" || field === "cpuLoadPct") {
    return value >= 0 && value <= 100 ? value : undefined;
  }
  return value >= 0 ? value : undefined;
}

export interface FrameTally {
  frames: FrameSample[];
  badRows: number;
  /** Rows considered (good + bad); filtered-out rows are excluded. */
  dataRows: number;
  /** 1-based line of the first bad row, when line numbers are meaningful. */
  firstBadLine?: number;
  missingSensors: readonly SensorColumnField[];
}

/**
 * Shared tolerance policy + warning assembly (§Phase 3) — the single owner of
 * accept/reject semantics for both the CSV row path and the CapFrameX JSON
 * path, so the two can never drift.
 */
export function finalizeFrames(source: CaptureSource, tally: FrameTally): ParseResult<FrameSample[]> {
  const { frames, badRows, dataRows, firstBadLine, missingSensors } = tally;
  if (frames.length === 0) {
    return failure(source, "no-valid-frames", "No rows survived parsing — nothing to summarize.");
  }
  if (badRows / dataRows > BAD_ROW_FRACTION_LIMIT) {
    return failure(
      source,
      "too-many-bad-rows",
      `${badRows} of ${dataRows} data rows are malformed (> ${BAD_ROW_FRACTION_LIMIT * 100}% tolerance).`,
      firstBadLine,
    );
  }

  const warnings: ParseWarning[] = [];
  if (badRows > 0) {
    warnings.push({
      code: "skipped-rows",
      message: `Skipped ${badRows} malformed row(s) of ${dataRows}.`,
      count: badRows,
    });
  }
  if (missingSensors.length > 0) {
    warnings.push({
      code: "missing-sensors",
      message: `Input lacks optional sensor column(s): ${missingSensors.join(", ")}.`,
      fields: [...missingSensors],
    });
  }

  return { ok: true, value: frames, warnings };
}

/** Typed early exit for callers that must bound browser-side capture parsing. */
export function tooManyFramesFailure(
  source: CaptureSource,
  maxFrames: number,
): ParseResult<never> {
  return failure(source, "too-many-frames", `Capture exceeds the ${maxFrames}-frame limit.`);
}

/**
 * Parse data rows into frames. Row policy: a row is bad when its frame time is
 * missing/non-positive or its timestamp cell is unparsable or time-reversed
 * (earlier than the previous accepted row). Bad rows are skipped and counted
 * (`skipped-rows` warning); more than `BAD_ROW_FRACTION_LIMIT` bad →
 * `too-many-bad-rows`; zero survivors → `no-valid-frames`. Timestamps are
 * normalized so the first valid frame is 0.
 */
export function parseFrameRows(input: FrameRowsInput): ParseResult<FrameSample[]> {
  const { source, dialect, header, columns } = input;

  const frameTimeIndex = findColumn(header, columns.frameTimeMs);
  if (frameTimeIndex === undefined) {
    return failure(
      source,
      "missing-columns",
      `Header has no frame-time column (looked for: ${columns.frameTimeMs.join(", ")}).`,
    );
  }

  const timeSecondsIndex = findColumn(header, columns.timeSeconds);
  const timeColumn =
    input.timeColumn ??
    (timeSecondsIndex === undefined ? undefined : { index: timeSecondsIndex, unit: "seconds" as const });

  const sensorIndices: Partial<Record<SensorColumnField, number>> = {};
  const missingSensors: SensorColumnField[] = [];
  for (const field of SENSOR_COLUMN_FIELDS) {
    const aliases = columns.sensors[field];
    if (aliases === undefined) continue; // source never carries it — not "missing"
    const index = findColumn(header, aliases);
    if (index === undefined) missingSensors.push(field);
    else sensorIndices[field] = index;
  }

  const frames: FrameSample[] = [];
  let badRows = 0;
  let firstBadLine: number | undefined;
  let dataRows = 0;
  let cumulativeMs = 0;
  let baselineMs: number | undefined;
  let lastRawMs: number | undefined;

  const markBad = (lineIndex: number) => {
    badRows++;
    firstBadLine ??= input.firstLineNumber + lineIndex;
  };

  const lineStart = input.lineStart ?? 0;
  for (let lineIndex = lineStart; lineIndex < input.lines.length; lineIndex++) {
    const line = input.lines[lineIndex]!;
    if (line.trim() === "") continue;

    const cells = splitCsvLine(line, dialect.delimiter);
    if (input.rowFilter !== undefined && !input.rowFilter(cells)) continue;
    dataRows++;

    const frameTimeMs = parseLocaleNumber(cells[frameTimeIndex], dialect);
    if (frameTimeMs === undefined || frameTimeMs < MIN_FRAME_TIME_MS) {
      markBad(lineIndex);
      continue;
    }

    let rawTimeMs: number;
    if (timeColumn === undefined) {
      rawTimeMs = cumulativeMs;
    } else {
      const rawTime = parseLocaleNumber(cells[timeColumn.index], dialect);
      if (rawTime === undefined) {
        markBad(lineIndex);
        continue;
      }
      rawTimeMs =
        timeColumn.unit === "seconds"
          ? rawTime * 1000
          : timeColumn.unit === "milliseconds"
            ? rawTime
            : rawTime / 1e6;
    }

    if (lastRawMs !== undefined && rawTimeMs < lastRawMs) {
      // Time went backwards relative to the previous accepted row — not a
      // frame we can order; treat as a bad row rather than emitting a
      // non-monotonic stream.
      markBad(lineIndex);
      continue;
    }

    if (input.maxFrames !== undefined && frames.length >= input.maxFrames) {
      return tooManyFramesFailure(source, input.maxFrames);
    }

    const frame: FrameSample = { timeMs: rawTimeMs - (baselineMs ?? rawTimeMs), frameTimeMs };
    for (const field of SENSOR_COLUMN_FIELDS) {
      const index = sensorIndices[field];
      if (index === undefined) continue;
      const scale = input.sensorScale?.[field] ?? 1;
      const raw = parseLocaleNumber(cells[index], dialect);
      const value = guardSensor(field, raw === undefined ? undefined : raw * scale);
      if (value !== undefined) frame[field] = value;
    }
    if (input.generatedColumn !== undefined) {
      const frameType = cells[input.generatedColumn]?.trim() ?? "";
      if (frameType !== "" && frameType.toLowerCase() !== "application") frame.generated = true;
    }

    baselineMs ??= rawTimeMs;
    lastRawMs = rawTimeMs;
    cumulativeMs += frameTimeMs;
    frames.push(frame);
  }

  return finalizeFrames(source, { frames, badRows, dataRows, firstBadLine, missingSensors });
}

/**
 * Locate-and-parse convenience for the CSV parsers: owns the "data starts on
 * the line after the header" arithmetic so each parser doesn't repeat it, and
 * keeps the original line array intact for large capture logs.
 */
export function parseFrameRowsAt(
  source: CaptureSource,
  lines: readonly string[],
  found: FoundHeader,
  columns: SourceColumns,
  options?: Pick<
    FrameRowsInput,
    "timeColumn" | "sensorScale" | "rowFilter" | "generatedColumn" | "maxFrames"
  >,
): ParseResult<FrameSample[]> {
  return parseFrameRows({
    source,
    lines,
    lineStart: found.index + 1,
    firstLineNumber: 1,
    dialect: found.dialect,
    header: found.header,
    columns,
    ...options,
  });
}
