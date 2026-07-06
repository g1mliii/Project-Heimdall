/**
 * Hand-rolled CSV utilities (§7.2 locale variance). Deliberately dependency-
 * free: the parse path ships to the browser (Phase 4) and a ~60-line tokenizer
 * keeps the bundle tiny and skips dependency-policy review.
 *
 * Locale handling is detected once per file from the header line: a header
 * split on `;` means a German-style export (`;` delimiter + decimal comma);
 * otherwise `,` + decimal dot.
 */

import type { CaptureSource } from "@heimdall/shared";

import { failure, type ParseResult } from "../errors";

export interface CsvDialect {
  delimiter: "," | ";";
  /** The decimal separator numbers in this file use. */
  decimal: "." | ",";
}

/** Sniff the dialect from the header line (§7.2). */
export function detectDialect(headerLine: string): CsvDialect {
  return headerLine.includes(";")
    ? { delimiter: ";", decimal: "," }
    : { delimiter: ",", decimal: "." };
}

/**
 * Split one CSV line into cells. Handles double-quoted fields (with `""`
 * escapes) because CapFrameX quotes strings that contain the delimiter.
 */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

/**
 * Parse a numeric cell under the file's dialect. Returns `undefined` (never
 * NaN) for empty cells, `NA`, or garbage, so callers can distinguish "absent
 * sensor" from a real zero. In the decimal-comma dialect a cell with both
 * separators (`1.234,5`) treats dots as grouping; a dot-only cell (`11.500`)
 * is ambiguous and keeps its face value rather than being guessed at.
 */
export function parseLocaleNumber(raw: string | undefined, dialect: CsvDialect): number | undefined {
  if (raw === undefined) return undefined;
  let text = raw.trim();
  if (text === "") return undefined;
  if (dialect.decimal === "," && text.includes(",")) {
    text = text.replaceAll(".", "").replace(",", ".");
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Case-insensitive header lookup: lowercased/trimmed cell text → column index.
 * First occurrence wins on duplicate headers.
 */
export function buildHeaderMap(headerCells: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  headerCells.forEach((cell, index) => {
    const key = cell.trim().toLowerCase();
    if (!map.has(key)) map.set(key, index);
  });
  return map;
}

/** Resolve the first matching alias to a column index (aliases are lowercase). */
export function findColumn(
  header: Map<string, number>,
  aliases: readonly string[],
): number | undefined {
  for (const alias of aliases) {
    const index = header.get(alias);
    if (index !== undefined) return index;
  }
  return undefined;
}

/** How many leading lines are scanned for a recognizable header. */
export const HEADER_SCAN_LIMIT = 100;

export interface FoundHeader {
  /** Zero-based line index of the header row. */
  index: number;
  dialect: CsvDialect;
  header: Map<string, number>;
}

/**
 * Locate the header: the first line (within the scan limit) that contains one
 * of the frame-time aliases under its own sniffed dialect. Lines before it
 * (CapFrameX comment banners, MangoHud sysinfo) are left to the caller.
 */
export function findCsvHeader(
  lines: readonly string[],
  frameTimeAliases: readonly string[],
): FoundHeader | undefined {
  const limit = Math.min(lines.length, HEADER_SCAN_LIMIT);
  for (let i = 0; i < limit; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const dialect = detectDialect(line);
    const header = buildHeaderMap(splitCsvLine(line, dialect.delimiter));
    if (findColumn(header, frameTimeAliases) !== undefined) return { index: i, dialect, header };
  }
  return undefined;
}

/** Does any scanned line look delimiter-separated at all? Drives error triage. */
export function looksLikeCsv(lines: readonly string[]): boolean {
  return lines.slice(0, HEADER_SCAN_LIMIT).some((line) => line.includes(",") || line.includes(";"));
}

/** Shared "no header found" triage: CSV-looking input → missing-columns. */
export function headerFailure(source: CaptureSource, lines: readonly string[]): ParseResult<never> {
  return looksLikeCsv(lines)
    ? failure(source, "missing-columns", "No header row with a frame-time column found.")
    : failure(source, "unrecognized-format", "Input does not look like a capture log.");
}
