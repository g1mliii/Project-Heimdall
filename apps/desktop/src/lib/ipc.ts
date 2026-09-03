/**
 * Typed wrapper over the Rust command surface (src-tauri/src/commands.rs).
 *
 * One module so the webview never spells an invoke name inline, and so the
 * event names and payload shapes have exactly one definition on this side of
 * the boundary. Every command rejects with the Rust `{ code, message }`
 * envelope, normalized here into a plain Error carrying the code.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { HardwareSnapshot } from "@heimdall/shared";

export interface HotkeyState {
  status: "registered" | "conflict" | "unavailable";
  accelerator: string;
  message?: string;
}

export type CheckState = "ok" | "missing" | "unknown";

/**
 * One onboarding check, produced by Rust (src-tauri/src/env.rs).
 *
 * The label, hint and any config lines come from the side that ran the check —
 * Windows and Linux have different checks with different remedies, and the copy
 * for "add this line to MangoHud.conf" only exists where the config was read.
 * This side renders the list and reads `blocking`; it knows nothing about what
 * any individual check means.
 */
export interface EnvCheck {
  id: string;
  label: string;
  state: CheckState;
  hint?: string;
  /** Verbatim config lines to add. Shown, never written. */
  lines?: string[];
  /** Failing this means a capture cannot work at all. */
  blocking: boolean;
}

export interface Environment {
  platform: "windows" | "linux" | "other";
  checks: EnvCheck[];
  /**
   * True when starting a capture ARMS a watcher rather than beginning one
   * (§23.1) — the Linux MangoHud backend. Windows never enters the armed screen.
   */
  watcherMode: boolean;
  captureTool: string;
  hotkey: HotkeyState;
  apiBaseUrl: string;
  appVersion: string;
  signingAvailable: boolean;
  updatesEnabled: boolean;
}

export interface MethodologyFacts {
  hags?: boolean;
  captureTool: string;
}

export interface DeclaredHardware {
  hardware: HardwareSnapshot;
  methodology: MethodologyFacts;
}

export interface CaptureTarget {
  pid: number;
  process: string;
}

export interface CaptureStarted extends CaptureTarget {
  antiCheat?: string;
}

/**
 * The watcher is live but MangoHud has not written a log yet (§23.1).
 *
 * `liveTraceExpected` is false when no `log_interval` is configured. MangoHud may
 * then only write the log when logging stops, so the Capturing screen has to say
 * "the trace appears when it flushes" instead of rendering an empty chart that
 * looks broken. Skip, never fail — the same rule the diagnostics follow.
 */
export interface CaptureArmed {
  logDirs: string[];
  hint: string;
  liveTraceExpected: boolean;
}

/**
 * What `startCapture` resolved to. Tagged rather than a nullable pair: the two
 * outcomes mean different things, and a shape allowing both or neither would let
 * a bug show a running timer over a capture that never began.
 */
export type CaptureStart =
  | ({ state: "started" } & CaptureStarted)
  | ({ state: "armed" } & CaptureArmed);

export interface CaptureRows {
  lines: string[];
  frames: number;
}

export interface CaptureEnded {
  frames: number;
  reason: "exited" | "overflow";
}

export interface CaptureResult {
  target: CaptureTarget;
  frames: number;
  csv: string;
  antiCheat?: string;
}

export interface PreparedPayload {
  signature?: string;
  byteLength: number;
}

export interface UpdateInfo {
  currentVersion: string;
  version: string;
}

/** Error carrying the Rust command's stable `code` discriminant. */
export class IpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IpcError";
  }
}

function normalize(error: unknown): IpcError {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
    const { code, message } = error as { code: unknown; message: unknown };
    return new IpcError(String(code), String(message));
  }
  return new IpcError("internal", error instanceof Error ? error.message : String(error));
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalize(error);
  }
}

export const getEnvironment = () => call<Environment>("get_environment");
export const getHardware = () => call<DeclaredHardware>("get_hardware");
export const getHardwareForPid = (pid: number) =>
  call<DeclaredHardware>("get_hardware_for_pid", { pid });
export const checkForUpdate = () => call<UpdateInfo | null>("check_for_update");
export const installUpdate = () => call<void>("install_update");
export const getForegroundGame = () => call<CaptureTarget>("get_foreground_game");
export const startCapture = () => call<CaptureStart>("start_capture");
export const stopCapture = () => call<CaptureResult>("stop_capture");
export const captureRunning = () => call<boolean>("capture_running");
export const setHotkey = (accelerator: string) => call<HotkeyState>("set_hotkey", { accelerator });
export const beginUpload = () => call<void>("begin_upload");
export const endUpload = () => call<void>("end_upload");
export const discardPayload = () => call<void>("discard_payload");
export const openSetupGuide = () => call<void>("open_setup_guide");
export const openClaim = (runId: string, managementToken: string) =>
  call<void>("open_claim", { runId, managementToken });
export const pendingCrashReport = () => call<string | null>("pending_crash_report");
export const openCrashReport = (report: string) => call<void>("open_crash_report", { report });
export const dismissCrashReport = () => call<void>("dismiss_crash_report");

/**
 * Hand the frame Parquet to Rust to be signed AND held for the PUT.
 *
 * The bytes go over Tauri's RAW IPC channel, not the JSON one — a 64 MiB
 * payload base64-encoded into JSON would be 85 MiB of string. This is also the
 * only transfer of the payload across the boundary: `putPreparedPayload`
 * uploads the bytes Rust already holds, so the two calls are a pair and
 * calling the second alone fails with `no-prepared-payload`.
 */
export async function preparePayload(parquet: Uint8Array): Promise<PreparedPayload> {
  try {
    // Copy into a standalone ArrayBuffer: `invoke` transfers the buffer, and a
    // view onto a larger/shared buffer would send the wrong bytes.
    const body = parquet.slice();
    return await invoke<PreparedPayload>("prepare_payload", body);
  } catch (error) {
    throw normalize(error);
  }
}

export const putPreparedPayload = (url: string, contentType: string) =>
  call<void>("put_prepared_payload", { url, contentType });

/* ── Events ─────────────────────────────────────────────────────────────── */

export const EVENTS = {
  armed: "capture://armed",
  started: "capture://started",
  rows: "capture://rows",
  ended: "capture://ended",
  hotkey: "capture://hotkey",
  hotkeyState: "capture://hotkey-state",
  trayToggle: "capture://toggle",
  uploadProgress: "upload://progress",
} as const;

export function on<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (message) => handler(message.payload));
}
