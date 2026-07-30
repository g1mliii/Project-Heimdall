/**
 * Capture state-machine coverage (§22.4).
 *
 * Pure reducer, so every edge the UI has — including the ones that are awkward
 * to reach by hand (hotkey during upload, sidecar exiting mid-capture) — is
 * exercised here rather than left to manual testing on a Windows box.
 */

import { describe, expect, it } from "vitest";
import type { EnvCheck, Environment } from "./ipc";
import {
  formatElapsed,
  initialState,
  needsOnboarding,
  reducer,
  toggleIntent,
  type Action,
  type State,
} from "./machine";

const check = (over: Partial<EnvCheck> = {}): EnvCheck => ({
  id: "performance-log-users",
  label: "This account is in Performance Log Users",
  state: "ok",
  blocking: true,
  ...over,
});

const READY_ENV: Environment = {
  platform: "windows",
  checks: [check(), check({ id: "capture-tool", label: "Bundled capture tool detected" })],
  watcherMode: false,
  captureTool: "PresentMon 2.4.1",
  hotkey: { status: "registered", accelerator: "Shift+F11" },
  apiBaseUrl: "http://localhost:3000",
  appVersion: "0.1.0",
  signingAvailable: false,
  updatesEnabled: false,
};

/** Linux: the watcher backend, with all four checks passing. */
const LINUX_ENV: Environment = {
  ...READY_ENV,
  platform: "linux",
  watcherMode: true,
  captureTool: "MangoHud 0.8.1",
  checks: [
    check({ id: "mangohud-installed", label: "MangoHud detected" }),
    check({ id: "output-folder", label: "MangoHud writes its logs somewhere watchable" }),
    check({ id: "sensor-params", label: "Sensors enabled", blocking: false }),
    check({ id: "log-interval", label: "A logging interval is set", blocking: false }),
  ],
};

const ARMED = {
  logDirs: ["/home/player/mangohud-logs"],
  hint: "Press MangoHud's logging hotkey in-game to start recording.",
  liveTraceExpected: true,
};

function run(actions: Action[], from: State = initialState): State {
  return actions.reduce(reducer, from);
}

const analyzed = {
  bytes: new TextEncoder().encode("Application,FrameTime\ngame.exe,10\n"),
  summary: {} as never,
  warnings: [],
  frames: 1200,
};

describe("onboarding gate", () => {
  it("shows setup until every blocking check affirmatively passes", () => {
    expect(needsOnboarding(READY_ENV)).toBe(false);
    expect(
      needsOnboarding({ ...READY_ENV, checks: [check({ state: "missing" }), check()] }),
    ).toBe(true);
    // Unknown is treated as "not ready": sending someone to a capture button
    // that will fail on permissions is worse than a click.
    expect(needsOnboarding({ ...READY_ENV, checks: [check({ state: "unknown" })] })).toBe(true);
  });

  it("a non-blocking check never sends the user to setup", () => {
    // Missing MangoHud sensor parameters cost diagnostics, and diagnostics skip
    // rather than fail (§23.1). Gating the whole app on one would be wrong.
    expect(
      needsOnboarding({
        ...LINUX_ENV,
        checks: LINUX_ENV.checks.map((c) =>
          c.id === "sensor-params" ? { ...c, state: "missing" as const } : c,
        ),
      }),
    ).toBe(false);
  });

  it("reads the check list without knowing what any check means", () => {
    // The whole point of the contract: a platform Rust invents tomorrow gates
    // correctly here with no change to this file.
    expect(
      needsOnboarding({
        ...READY_ENV,
        platform: "other",
        checks: [check({ id: "some-future-check", state: "missing" })],
      }),
    ).toBe(true);
  });

  it("a refreshed environment never yanks a live capture back to setup", () => {
    const capturing = run([
      { type: "environment", environment: READY_ENV },
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
    ]);
    const refreshed = reducer(capturing, {
      type: "environment",
      environment: { ...READY_ENV, checks: [check({ state: "unknown" })] },
    });
    expect(refreshed.screen).toBe("capturing");
  });

  it("a refreshed environment never disarms a live watcher either", () => {
    // The watcher is running natively; bouncing the UI to setup would leave the
    // user with no way to see or cancel it.
    const armed = run([
      { type: "environment", environment: LINUX_ENV },
      { type: "capture-armed", armed: ARMED },
    ]);
    const refreshed = reducer(armed, {
      type: "environment",
      environment: { ...LINUX_ENV, checks: [check({ state: "missing" })] },
    });
    expect(refreshed.screen).toBe("armed");
  });

  it("lets the user continue past a failing check", () => {
    const state = run([
      { type: "environment", environment: { ...READY_ENV, checks: [check({ state: "missing" })] } },
      { type: "continue-from-onboarding" },
    ]);
    expect(state.screen).toBe("ready");
  });
});

describe("armed → capturing (Linux watcher, §23.1)", () => {
  it("arms without starting the elapsed timer", () => {
    // Elapsed time measures the capture, not how long the user took to press
    // MangoHud's hotkey.
    const state = run([
      { type: "environment", environment: LINUX_ENV },
      { type: "capture-armed", armed: ARMED },
      { type: "tick", deltaMs: 5000 },
    ]);
    expect(state.screen).toBe("armed");
    expect(state.elapsedMs).toBe(0);
    expect(state.frames).toBe(0);
    expect(state.armed).toEqual(ARMED);
    expect(state.target).toBeNull();
  });

  it("rows arriving while merely armed are ignored", () => {
    const state = run([
      { type: "environment", environment: LINUX_ENV },
      { type: "capture-armed", armed: ARMED },
      { type: "capture-rows", frames: 300 },
    ]);
    expect(state.frames).toBe(0);
  });

  it("the watcher finding a log moves to capturing and spends the armed state", () => {
    const state = run([
      { type: "environment", environment: LINUX_ENV },
      { type: "capture-armed", armed: ARMED },
      { type: "capture-started", started: { pid: 0, process: "Cyberpunk2077" } },
    ]);
    expect(state.screen).toBe("capturing");
    // Left behind, a later render would read it as "still waiting".
    expect(state.armed).toBeNull();
    expect(state.target).toEqual({ pid: 0, process: "Cyberpunk2077" });
  });

  it("the toggle disarms rather than stopping a capture that never began", () => {
    // Routing this through stop_capture as a `stop` would surface
    // `no-capture-log` as an error for a user who simply changed their mind.
    const armed = run([
      { type: "environment", environment: LINUX_ENV },
      { type: "capture-armed", armed: ARMED },
    ]);
    expect(toggleIntent(armed)).toBe("disarm");
    expect(toggleIntent(reducer(armed, { type: "analyzing" }))).toBe("ignore");
  });

  it("cancelling returns to ready with nothing left over", () => {
    const state = run([
      { type: "environment", environment: LINUX_ENV },
      { type: "capture-armed", armed: ARMED },
      { type: "discard" },
    ]);
    expect(state.screen).toBe("ready");
    expect(state.armed).toBeNull();
  });

  it("Windows never enters the armed screen", () => {
    const state = run([
      { type: "environment", environment: READY_ENV },
      { type: "capture-started", started: { pid: 42, process: "game.exe" } },
    ]);
    expect(state.screen).toBe("capturing");
    expect(state.armed).toBeNull();
    expect(READY_ENV.watcherMode).toBe(false);
  });
});

describe("ready → capturing → complete", () => {
  it("walks the happy path and carries the analyzed frame count", () => {
    const state = run([
      { type: "environment", environment: READY_ENV },
      { type: "capture-started", started: { pid: 42, process: "Cyberpunk2077.exe" } },
      { type: "tick", deltaMs: 1500 },
      { type: "capture-rows", frames: 900 },
      { type: "analyzing" },
      { type: "analyzed", capture: analyzed },
    ]);

    expect(state.screen).toBe("complete");
    expect(state.target).toEqual({ pid: 42, process: "Cyberpunk2077.exe" });
    expect(state.frames).toBe(1200);
    expect(state.analyzing).toBe(false);
    expect(formatElapsed(state.elapsedMs)).toBe("00:01");
  });

  it("ignores rows that arrive after the stop, so the counts cannot disagree", () => {
    const complete = run([
      { type: "environment", environment: READY_ENV },
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
      { type: "analyzed", capture: analyzed },
    ]);
    expect(reducer(complete, { type: "capture-rows", frames: 99999 }).frames).toBe(1200);
  });

  it("surfaces an anti-cheat notice without blocking the capture", () => {
    const state = reducer(initialState, {
      type: "capture-started",
      started: { pid: 1, process: "game.exe", antiCheat: "Easy Anti-Cheat" },
    });
    expect(state.antiCheat).toBe("Easy Anti-Cheat");
    expect(state.screen).toBe("capturing");
  });
});

describe("the sidecar ending on its own", () => {
  it("explains a game exit rather than freezing the timer", () => {
    const state = run([
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
      { type: "capture-ended", frames: 400, reason: "exited" },
    ]);
    expect(state.notice).toContain("the game exited");
    expect(state.frames).toBe(400);
  });

  it("names the size cap when the retained capture overflows", () => {
    const state = run([
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
      { type: "capture-ended", frames: 9_000_000, reason: "overflow" },
    ]);
    expect(state.notice).toContain("size limit");
  });

  it("is inert once the capture is already complete", () => {
    const complete = run([
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
      { type: "analyzed", capture: analyzed },
    ]);
    expect(reducer(complete, { type: "capture-ended", frames: 0, reason: "exited" })).toBe(complete);
  });
});

describe("discard and failure", () => {
  it("discard returns to ready and drops the capture entirely", () => {
    const state = run([
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
      { type: "analyzed", capture: analyzed },
      { type: "upload", phase: { status: "failed", code: "rate-limited", message: "slow down" } },
      { type: "discard" },
    ]);
    expect(state).toMatchObject({
      screen: "ready",
      capture: null,
      frames: 0,
      elapsedMs: 0,
      upload: { status: "idle" },
      notice: null,
    });
  });

  it("a failed capture lands back on ready with the reason shown", () => {
    const state = run([
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
      { type: "analyzing" },
      { type: "capture-failed", message: "Only 12 frames were captured" },
    ]);
    expect(state.screen).toBe("ready");
    expect(state.analyzing).toBe(false);
    expect(state.notice).toContain("12 frames");
  });
});

describe("hotkey and tray toggle", () => {
  it("starts from ready and stops from capturing", () => {
    const ready = reducer(initialState, { type: "environment", environment: READY_ENV });
    expect(toggleIntent(ready)).toBe("start");

    const capturing = reducer(ready, {
      type: "capture-started",
      started: { pid: 1, process: "game.exe" },
    });
    expect(toggleIntent(capturing)).toBe("stop");
  });

  it("does nothing on the complete screen, so a stray press cannot clobber a run", () => {
    const complete = run([
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
      { type: "analyzed", capture: analyzed },
      { type: "upload", phase: { status: "running", label: "Uploading" } },
    ]);
    expect(toggleIntent(complete)).toBe("ignore");
  });

  it("does nothing while a stop is already being analyzed", () => {
    const analyzing = run([
      { type: "capture-started", started: { pid: 1, process: "game.exe" } },
      { type: "analyzing" },
    ]);
    expect(toggleIntent(analyzing)).toBe("ignore");
  });

  it("keeps a registration failure visible as its own state", () => {
    const state = reducer(initialState, {
      type: "hotkey-state",
      hotkey: {
        status: "conflict",
        accelerator: "Shift+F11",
        message: "already held by another application",
      },
    });
    expect(state.hotkey?.status).toBe("conflict");
    // A dead hotkey must never stop the button working.
    expect(toggleIntent(reducer(state, { type: "continue-from-onboarding" }))).toBe("start");
  });
});

describe("formatElapsed", () => {
  it("is mm:ss and never negative", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(61_000)).toBe("01:01");
    expect(formatElapsed(3_600_000)).toBe("60:00");
    expect(formatElapsed(-5)).toBe("00:00");
  });
});
