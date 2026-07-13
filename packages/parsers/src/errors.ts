/**
 * Typed parse outcomes (§Phase 3). Parsers return a Result union instead of
 * throwing: plain objects survive a worker `postMessage` boundary, and callers
 * are forced to handle failure at the type level. Nothing in the parse path
 * ever throws on malformed input.
 */

import type {
  CaptureSource,
  FrameSample,
  HardwareSnapshot,
  PresentationMode,
  SyncMode,
} from "@heimdall/shared";

/**
 * Capture semantics a source can reveal from its headers but the merged frame
 * stream cannot (§16a.3) — fed into the capability manifest as declared values.
 */
export interface CaptureSemantics {
  presentationMode?: PresentationMode;
  syncMode?: SyncMode;
  /** Graphics runtime recorded by a source header, e.g. `dxgi` or `vulkan`. */
  graphicsApi?: string;
}

/** The common output shape every source parser produces. */
export interface ParsedCapture {
  source: CaptureSource;
  /** Parsed frames — `frameTimeMs > 0` guaranteed for every element. */
  frames: FrameSample[];
  /** Only when gpu+cpu are recoverable (CapFrameX JSON, MangoHud). */
  hardware?: HardwareSnapshot;
  /** Detected presentation/sync semantics (PresentMon v2+); absent otherwise. */
  captureSemantics?: CaptureSemantics;
  /** Pinned parser-recognized capture profile, e.g. `presentmon-2.x`. */
  captureProfile?: string;
  /** e.g. `"capframex@1.0.0"` — stored for reprocessing provenance (§2.2). */
  parserVersion: string;
}

export type ParseErrorCode =
  | "empty-input"
  | "unrecognized-format"
  | "missing-columns"
  | "invalid-json"
  | "no-valid-frames"
  | "too-many-bad-rows";

export type ParseErrorSource = CaptureSource | "unknown";

export interface ParseError {
  code: ParseErrorCode;
  /** Human-readable detail — never the only signal, always paired with `code`. */
  message: string;
  /** Which parser produced the error, or "unknown" when source validation failed first. */
  source: ParseErrorSource;
  /** 1-based line number, when the failure is attributable to one. */
  line?: number;
}

export type ParseWarningCode = "skipped-rows" | "missing-sensors" | "multiple-streams";

export interface ParseWarning {
  code: ParseWarningCode;
  message: string;
  /** For `skipped-rows` / `multiple-streams`: how many rows were dropped. */
  count?: number;
  /** For `missing-sensors`: which optional sensor fields the file lacks. */
  fields?: string[];
}

export type ParseResult<T> =
  | { ok: true; value: T; warnings: ParseWarning[] }
  | { ok: false; error: ParseError };

/**
 * Row-tolerance policy: individually bad rows are skipped (and surfaced via a
 * `skipped-rows` warning), but when more than this fraction of data rows is
 * bad the whole file is rejected with `too-many-bad-rows` — a capture that
 * mangled is not trustworthy enough to summarize.
 */
export const BAD_ROW_FRACTION_LIMIT = 0.05;

export function failure(
  source: ParseErrorSource,
  code: ParseErrorCode,
  message: string,
  line?: number,
): ParseResult<never> {
  return { ok: false, error: line === undefined ? { code, message, source } : { code, message, source, line } };
}

export function success<T>(value: T, warnings: ParseWarning[]): ParseResult<T> {
  return { ok: true, value, warnings };
}
