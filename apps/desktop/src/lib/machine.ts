/**
 * Capture-client state machine (§22.4).
 *
 * A pure reducer, deliberately: the four kit screens plus the upload sub-states
 * have enough edges (hotkey, tray, sidecar exit, discard) that driving them out
 * of scattered `useState` calls would make "stop arrived twice" or "hotkey
 * fired while uploading" unreviewable. Everything here is synchronous and
 * side-effect free, so the transitions are unit-tested without a webview.
 */

import type { ParseWarning } from "@heimdall/parsers";
import type { RunSummary } from "@heimdall/shared";
import type {
  CaptureArmed,
  CaptureStarted,
  CaptureTarget,
  Environment,
  HotkeyState,
} from "./ipc";

/**
 * `armed` is Linux-only (§23.1): the MangoHud watcher is live but the user has
 * not pressed MangoHud's own logging hotkey yet, so no rows exist. It sits
 * between `ready` and `capturing` because it is genuinely neither — showing
 * `capturing` would run a timer over a capture that has not started, and staying
 * on `ready` would hide the fact that Heimdall is now waiting on the user.
 * Windows goes straight from `ready` to `capturing` and never enters it.
 */
export type Screen = "onboarding" | "ready" | "armed" | "capturing" | "complete";

export interface AnalyzedCapture {
  /**
   * The capture as the exact bytes the upload sends. Encoded once, on analyze:
   * holding the CSV string here instead would mean a second full UTF-8 encode
   * on upload, and both copies of a multi-megabyte capture resident for as long
   * as the Complete screen is open.
   */
  bytes: Uint8Array;
  summary: RunSummary;
  warnings: ParseWarning[];
  frames: number;
}

export type UploadPhase =
  | { status: "idle" }
  | { status: "running"; label: string; sentBytes?: number; totalBytes?: number }
  | {
      status: "claim";
      runId: string;
      managementToken: string;
      context: "confirmed" | "recovery";
      handoff: "opening" | "failed";
      message?: string;
      handoffMessage?: string;
    }
  | { status: "done"; runId: string; context: "confirmed" | "recovery" }
  | { status: "failed"; code: string; message: string };

export interface State {
  screen: Screen;
  environment: Environment | null;
  hotkey: HotkeyState | null;
  target: CaptureTarget | null;
  antiCheat: string | null;
  /** Set while `screen === "armed"`; carries the folders being watched. */
  armed: CaptureArmed | null;
  /** Milliseconds since the capture started; the timer ticks it. */
  elapsedMs: number;
  frames: number;
  capture: AnalyzedCapture | null;
  upload: UploadPhase;
  /** Non-fatal notice shown under the hero (sidecar exit, overflow, errors). */
  notice: string | null;
  /** True between "stop pressed" and the parse finishing. */
  analyzing: boolean;
}

export type Action =
  | { type: "environment"; environment: Environment }
  | { type: "hotkey-state"; hotkey: HotkeyState }
  | { type: "continue-from-onboarding" }
  | { type: "capture-armed"; armed: CaptureArmed }
  | { type: "capture-started"; started: CaptureStarted }
  | { type: "capture-rows"; frames: number }
  | { type: "tick"; deltaMs: number }
  | { type: "capture-ended"; frames: number; reason: "exited" | "overflow" }
  | { type: "analyzing" }
  | { type: "analyzed"; capture: AnalyzedCapture }
  | { type: "capture-failed"; message: string }
  | { type: "discard" }
  | { type: "upload"; phase: UploadPhase };

export const initialState: State = {
  screen: "onboarding",
  environment: null,
  hotkey: null,
  target: null,
  antiCheat: null,
  armed: null,
  elapsedMs: 0,
  frames: 0,
  capture: null,
  upload: { status: "idle" },
  notice: null,
  analyzing: false,
};

/**
 * Onboarding is shown until the machine can actually capture.
 *
 * Reads the checks Rust produced rather than named booleans, so a platform or a
 * check can be added without touching this file (§23.1). Only `blocking` checks
 * count: a missing MangoHud sensor parameter costs diagnostics, and diagnostics
 * skip rather than fail — sending someone to a setup screen over it would be
 * wrong.
 *
 * `unknown` is treated as "show the setup screen", exactly as before: sending
 * someone to a capture button that will fail with a permissions error, or to a
 * watcher that can never fire, is worse than one extra click.
 */
export function needsOnboarding(environment: Environment): boolean {
  return environment.checks.some((check) => check.blocking && check.state !== "ok");
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "environment":
      return {
        ...state,
        environment: action.environment,
        hotkey: action.environment.hotkey,
        // Never bounce a user mid-capture back to onboarding on a refresh —
        // `armed` included: the watcher is live and a re-check must not silently
        // drop it.
        screen:
          state.screen === "armed" ||
          state.screen === "capturing" ||
          state.screen === "complete"
            ? state.screen
            : needsOnboarding(action.environment)
              ? "onboarding"
              : "ready",
      };

    case "hotkey-state":
      return { ...state, hotkey: action.hotkey };

    case "continue-from-onboarding":
      return { ...state, screen: "ready" };

    case "capture-armed":
      // Linux (§23.1). The watcher is running; MangoHud has written nothing yet.
      // No timer starts here — elapsed time measures the capture, not how long
      // the user took to press MangoHud's hotkey.
      return {
        ...state,
        screen: "armed",
        armed: action.armed,
        target: null,
        antiCheat: null,
        elapsedMs: 0,
        frames: 0,
        capture: null,
        upload: { status: "idle" },
        notice: null,
        analyzing: false,
      };

    case "capture-started":
      return {
        ...state,
        screen: "capturing",
        // The watcher has found its log, so the armed state is spent. Its
        // fields are cleared rather than left behind for a later render to
        // read as though the client were still waiting.
        armed: null,
        target: { pid: action.started.pid, process: action.started.process },
        antiCheat: action.started.antiCheat ?? null,
        elapsedMs: 0,
        frames: 0,
        capture: null,
        upload: { status: "idle" },
        notice: null,
        analyzing: false,
      };

    case "capture-rows":
      // Ignore late rows that arrive after stop: the frame count on the
      // Complete screen must match the capture that was actually analyzed.
      return state.screen === "capturing" ? { ...state, frames: action.frames } : state;

    case "tick":
      return state.screen === "capturing"
        ? { ...state, elapsedMs: state.elapsedMs + action.deltaMs }
        : state;

    case "capture-ended":
      // The sidecar stopped on its own — the game closed, or the retained CSV
      // hit its cap. Either way the session is over and the user is told why
      // rather than left watching a frozen timer.
      if (state.screen !== "capturing") return state;
      return {
        ...state,
        frames: action.frames,
        notice:
          action.reason === "overflow"
            ? "Capture stopped: it grew past the size limit. Analyze what was recorded, or discard it."
            : "Capture stopped: the game exited.",
      };

    case "analyzing":
      return { ...state, analyzing: true };

    case "analyzed":
      return {
        ...state,
        screen: "complete",
        analyzing: false,
        capture: action.capture,
        frames: action.capture.frames,
      };

    case "capture-failed":
      return {
        ...state,
        screen: "ready",
        armed: null,
        analyzing: false,
        capture: null,
        notice: action.message,
      };

    case "discard":
      return {
        ...state,
        screen: "ready",
        armed: null,
        capture: null,
        frames: 0,
        elapsedMs: 0,
        upload: { status: "idle" },
        notice: null,
        analyzing: false,
      };

    case "upload":
      return { ...state, upload: action.phase };
  }
}

/**
 * Whether the hotkey / tray toggle should start or stop.
 *
 * Uploading is deliberately NOT a toggle target: pressing the hotkey while a
 * run is being uploaded must not silently start a second capture over the top
 * of it.
 *
 * `armed` toggles to `disarm`, not `stop`: there is no capture to stop, and
 * routing it through `stop_capture` would surface `no-capture-log` as an error
 * for a user who simply changed their mind (§23.1).
 */
export function toggleIntent(state: State): "start" | "stop" | "disarm" | "ignore" {
  if (state.screen === "capturing") return state.analyzing ? "ignore" : "stop";
  if (state.screen === "armed") return state.analyzing ? "ignore" : "disarm";
  if (state.screen === "ready") return "start";
  return "ignore";
}

/** `mm:ss` for the elapsed readout. */
export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
