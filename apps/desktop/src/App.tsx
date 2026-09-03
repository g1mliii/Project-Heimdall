/**
 * Heimdall Capture — the whole webview (§22.4).
 *
 * Everything below the IPC layer is the SAME code the web hub runs:
 * `parseAnyCapture` / `computeRunSummary` from @heimdall/parsers and the §11
 * create → PUT → finalize engine from @heimdall/ingest-client. The desktop
 * client is a different front door onto one implementation, not a second one.
 */

import * as React from "react";
import { Badge, Button, Diagnostic, Spinner, Stat } from "@heimdall/ui";
import { computeRunSummary, parseAnyCapture } from "@heimdall/parsers";
import {
  INGEST_LIMITS,
  type HardwareSnapshot,
  type MethodologyManifest,
} from "@heimdall/shared";
import { uploadCaptureBytes } from "@heimdall/ingest-client";
import { FrameTimeChart } from "./components/FrameTimeChart";
import { Onboarding } from "./components/Onboarding";
import { RunDetailsPanel } from "./components/RunDetailsPanel";
import { HardwareRows, StatusHero } from "./components/StatusHero";
import { TitleBar } from "./components/TitleBar";
import { CircleIcon, SquareIcon, UploadIcon } from "./components/icons";
import { deferToCapture } from "./lib/hardware";
import * as ipc from "./lib/ipc";
import { LiveFrameTimes } from "./lib/live-frames";
import { formatElapsed, initialState, reducer, toggleIntent, type State } from "./lib/machine";
import {
  applyDetection,
  missingFields,
  prefillForm,
  toMethodology,
  type RunDetailsForm,
} from "./lib/run-details";
import { createDesktopTransport, createSigner } from "./lib/transport";

const TICK_MS = 200;

type UpdateState =
  | { status: "idle" | "checking" | "current" }
  | { status: "available"; info: ipc.UpdateInfo }
  | { status: "installing"; info: ipc.UpdateInfo }
  | { status: "failed"; message: string };

export function App() {
  const [state, dispatch] = React.useReducer(reducer, initialState);
  const [detected, setDetected] = React.useState<ipc.DeclaredHardware | null>(null);
  /**
   * Hardware the capture file itself declared — MangoHud's sysinfo row (§23.2).
   * Held separately from `detected` so the two sources stay distinguishable at
   * upload time; merging them on arrival would lose which one knew what.
   */
  const [captureHardware, setCaptureHardware] = React.useState<
    Partial<HardwareSnapshot> | null
  >(null);
  const [form, setForm] = React.useState<RunDetailsForm>(prefillForm(null, undefined));
  const [crashReport, setCrashReport] = React.useState<string | null>(null);
  const [update, setUpdate] = React.useState<UpdateState>({ status: "idle" });
  // Which fields the user has actually touched. Detection re-fills everything
  // else on the next capture, so a second run cannot inherit the first run's
  // game name (§16c) — a ref because it is read inside a setState updater and
  // must never itself trigger a render.
  const editedRef = React.useRef(new Set<keyof RunDetailsForm>());
  // A ref, not state: the readout is mutated on every stdout chunk and the
  // re-render is already driven by the frame count in the reducer. Holding it
  // in state would either lose updates (same instance, so React bails) or
  // reallocate the whole window several times a second.
  const liveRef = React.useRef<LiveFrameTimes | null>(null);
  liveRef.current ??= new LiveFrameTimes();
  const live = liveRef.current;
  /** Latest frame count from the row stream, drained by the elapsed tick. */
  const pendingFramesRef = React.useRef<number | null>(null);
  const startPromiseRef = React.useRef<Promise<void> | null>(null);
  const analyzePromiseRef = React.useRef<Promise<void> | null>(null);
  const captureHardwarePromiseRef = React.useRef<Promise<ipc.DeclaredHardware | null> | null>(
    null,
  );

  // The reducer is pure, so event handlers registered once would close over a
  // stale state. A ref keeps the toggle decision reading the current one.
  const stateRef = React.useRef<State>(state);
  stateRef.current = state;

  const refreshEnvironment = React.useCallback(async () => {
    dispatch({ type: "environment", environment: await ipc.getEnvironment() });
  }, []);

  const checkForUpdate = React.useCallback(async () => {
    setUpdate({ status: "checking" });
    try {
      const info = await ipc.checkForUpdate();
      setUpdate(info === null ? { status: "current" } : { status: "available", info });
    } catch (error) {
      setUpdate({
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  /**
   * Collect hardware against the captured process rather than the boot-time
   * foreground window: that can point at the desktop or adapter 0 on a hybrid
   * laptop, both of which poison comparability metadata. On Linux the pid is 0
   * and ignored — the watcher has no handle on the game's process.
   */
  const refreshCaptureHardware = React.useCallback((pid: number) => {
    captureHardwarePromiseRef.current = ipc
      .getHardwareForPid(pid)
      .then((hardware) => {
        setDetected(hardware);
        return hardware;
      })
      .catch(() => {
        // Hardware facts skip rather than fail; retain the last honest
        // snapshot when collection becomes unavailable mid-session.
        return null;
      });
  }, []);

  const startCapture = React.useCallback(() => {
    if (startPromiseRef.current !== null) return startPromiseRef.current;
    const task = (async () => {
      try {
        liveRef.current = new LiveFrameTimes();
        const start = await ipc.startCapture();
        if (start.state === "armed") {
          // Linux (§23.1). Nothing is recording yet, and hardware collection
          // waits for `capture://started` — asking now would read the machine
          // before the user has even launched the game.
          dispatch({ type: "capture-armed", armed: start });
          return;
        }
        refreshCaptureHardware(start.pid);
      } catch (error) {
        dispatch({
          type: "capture-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    startPromiseRef.current = task;
    void task.finally(() => {
      if (startPromiseRef.current === task) startPromiseRef.current = null;
    });
    return task;
  }, [refreshCaptureHardware]);

  /**
   * Stand the watcher down without recording anything (§23.1).
   *
   * Goes through `stop_capture` because that is what releases the native
   * session and its activity permit, but `no-capture-log` is the EXPECTED
   * outcome here and must not surface as an error — the user changed their mind,
   * they did not hit a fault.
   */
  const disarm = React.useCallback(async () => {
    try {
      await ipc.stopCapture();
    } catch (error) {
      if (!(error instanceof ipc.IpcError) || error.code !== "no-capture-log") {
        dispatch({
          type: "capture-failed",
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    dispatch({ type: "discard" });
  }, []);

  const analyzeCapture = React.useCallback(() => {
    if (analyzePromiseRef.current !== null) return analyzePromiseRef.current;
    const task = (async () => {
      dispatch({ type: "analyzing" });
      try {
        const result = await ipc.stopCapture();
        // Collection starts as soon as PresentMon identifies the pid. Await it
        // here so a short capture cannot upload the boot-time foreground
        // window's monitor/adapter merely because WMI/DXGI finished late.
        const hardwareTask = captureHardwarePromiseRef.current;
        const captureHardware = (hardwareTask === null ? null : await hardwareTask) ?? detected;
        if (captureHardwarePromiseRef.current === hardwareTask) {
          captureHardwarePromiseRef.current = null;
        }
        const bytes = new TextEncoder().encode(result.csv);
        if (bytes.byteLength > INGEST_LIMITS.maxCaptureBytes) {
          dispatch({
            type: "capture-failed",
            message: `Capture is ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB; maximum is ${INGEST_LIMITS.maxCaptureBytes / (1024 * 1024)} MiB.`,
          });
          return;
        }
        // Same parser, same limits as the browser upload path (§22.1).
        const parsed = parseAnyCapture(bytes, { maxFrames: INGEST_LIMITS.maxFramesPerRun });
        if (!parsed.ok) {
          dispatch({ type: "capture-failed", message: parsed.error.message });
          return;
        }
        // MangoHud's sysinfo row outranks the client's own /sys reads (§23.2) —
        // see lib/hardware.ts. A no-op for PresentMon, whose CSV carries none.
        setCaptureHardware(parsed.capture.hardware ?? null);
        if (parsed.capture.frames.length < INGEST_LIMITS.minFramesPerRun) {
          dispatch({
            type: "capture-failed",
            message: `Only ${parsed.capture.frames.length} frames were captured (minimum ${INGEST_LIMITS.minFramesPerRun}). Capture for longer.`,
          });
          return;
        }
        // Re-detect everything the client can see; keep only what the user typed.
        // A "keep every non-empty field" merge would carry the previous capture's
        // game name onto this one — see `applyDetection`.
        setForm((current) =>
          applyDetection(current, editedRef.current, captureHardware, result.target.process),
        );
        dispatch({
          type: "analyzed",
          capture: {
            bytes,
            summary: computeRunSummary(parsed.capture.frames),
            warnings: parsed.warnings,
            frames: parsed.capture.frames.length,
          },
        });
      } catch (error) {
        dispatch({
          type: "capture-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    analyzePromiseRef.current = task;
    void task.finally(() => {
      if (analyzePromiseRef.current === task) analyzePromiseRef.current = null;
    });
    return task;
  }, [detected]);

  const toggleCapture = React.useCallback(() => {
    const intent = toggleIntent(stateRef.current);
    if (intent === "start") void startCapture();
    if (intent === "stop") void analyzeCapture();
    if (intent === "disarm") void disarm();
  }, [startCapture, analyzeCapture, disarm]);

  /* ── Boot + event wiring ────────────────────────────────────────────── */

  React.useEffect(() => {
    void refreshEnvironment();
    void ipc.getHardware().then(setDetected);
    void ipc.pendingCrashReport().then(setCrashReport);
  }, [refreshEnvironment]);

  React.useEffect(() => {
    if (state.environment?.updatesEnabled === true && update.status === "idle") {
      void checkForUpdate();
    }
  }, [state.environment?.updatesEnabled, update.status, checkForUpdate]);

  React.useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      ipc.on<ipc.CaptureArmed>(ipc.EVENTS.armed, (armed) =>
        dispatch({ type: "capture-armed", armed }),
      ),
      ipc.on<ipc.CaptureStarted>(ipc.EVENTS.started, (started) => {
        dispatch({ type: "capture-started", started });
        // On Linux this event is the FIRST moment a capture exists, so it is
        // also the first useful moment to read the machine. On Windows the
        // start path has already kicked this off; re-reading is cheap next to
        // getting a stale adapter into the run's metadata.
        refreshCaptureHardware(started.pid);
      }),
      ipc.on<ipc.CaptureRows>(ipc.EVENTS.rows, (rows) => {
        liveRef.current?.push(rows.lines);
        // Rust batches rows before IPC, but the batch cadence is still faster
        // than this readout needs. Hold the latest count and let the 200 ms tick
        // carry it without coupling renders to transport frequency.
        pendingFramesRef.current = rows.frames;
      }),
      ipc.on<ipc.CaptureEnded>(ipc.EVENTS.ended, (ended) => {
        dispatch({ type: "capture-ended", ...ended });
        // The sidecar is already gone; draining it into a result is the only
        // way the user gets the frames they did record.
        void analyzeCapture();
      }),
      ipc.on<ipc.HotkeyState>(ipc.EVENTS.hotkeyState, (hotkey) =>
        dispatch({ type: "hotkey-state", hotkey }),
      ),
      ipc.on(ipc.EVENTS.hotkey, toggleCapture),
      ipc.on(ipc.EVENTS.trayToggle, toggleCapture),
    ];
    return () => {
      for (const pending of unlisteners) void pending.then((unlisten) => unlisten());
    };
    // `toggleCapture` reads the live state through `stateRef`, so it does not
    // need a ref of its own — re-subscribing when its identity changes is
    // exactly as often as this effect already re-runs.
  }, [analyzeCapture, refreshCaptureHardware, toggleCapture]);

  // Elapsed timer. Driven off wall-clock deltas rather than a tick count so a
  // throttled background window does not under-report the capture length.
  React.useEffect(() => {
    if (state.screen !== "capturing") return;
    let previous = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      const frames = pendingFramesRef.current;
      if (frames !== null) {
        pendingFramesRef.current = null;
        dispatch({ type: "capture-rows", frames });
      }
      dispatch({ type: "tick", deltaMs: now - previous });
      previous = now;
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [state.screen]);

  /* ── Upload ─────────────────────────────────────────────────────────── */

  const handoffClaim = React.useCallback(
    async (
      runId: string,
      managementToken: string,
      context: "confirmed" | "recovery",
      message?: string,
    ) => {
      dispatch({
        type: "upload",
        phase: {
          status: "claim",
          runId,
          managementToken,
          context,
          handoff: "opening",
          ...(message === undefined ? {} : { message }),
        },
      });
      try {
        await ipc.openClaim(runId, managementToken);
        // Once the opener accepts the URL, the only plaintext token has moved
        // into the browser fragment and no longer needs to stay in webview
        // state. A failed opener keeps it in the `claim` phase for retry.
        dispatch({ type: "upload", phase: { status: "done", runId, context } });
      } catch (error) {
        dispatch({
          type: "upload",
          phase: {
            status: "claim",
            runId,
            managementToken,
            context,
            handoff: "failed",
            ...(message === undefined ? {} : { message }),
            handoffMessage: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
    [],
  );

  const upload = React.useCallback(async () => {
    if (state.capture === null || state.environment === null) return;
    const hags = detected?.methodology.hags;
    const methodology = {
      ...toMethodology(form),
      captureTool: detected?.methodology.captureTool,
      // Omitted entirely when unknown: an undeclared field is honest, a
      // fabricated "disabled" is not.
      ...(hags === undefined ? {} : { hags: hags ? "enabled" : "disabled" }),
      // OBSERVED build identity (§8.8a), read from the local Steam install at
      // capture time. It sits beside the uploader's `gameBuild` claim and never
      // replaces it: one is what they said, this is what was installed. Omitted
      // when unknown, for the same reason `hags` is.
      ...(state.steamBuild === null
        ? {}
        : {
            steamAppId: state.steamBuild.appid,
            steamBuildId: state.steamBuild.buildid,
            ...(state.steamBuild.branch ? { steamBranch: state.steamBuild.branch } : {}),
          }),
    } as Omit<MethodologyManifest, "version" | "frameGeneration">;

    dispatch({ type: "upload", phase: { status: "running", label: "Preparing" } });
    let result: Awaited<ReturnType<typeof uploadCaptureBytes>>;
    let uploadReserved = false;
    try {
      await ipc.beginUpload();
      uploadReserved = true;
      result = await uploadCaptureBytes(state.capture.bytes, {
        game: form.game.trim() || "Unknown game",
        visibility: form.visibility,
        // `options.hardware` overrides what the parser found, so anything the
        // capture itself declared is dropped from the override first (§23.2).
        ...(detected === null
          ? {}
          : { hardware: deferToCapture(detected.hardware, captureHardware ?? undefined) }),
        methodology,
        // Declared, because the capture cannot show it (§22.11). Omitted when
        // the user did not answer, so the server records `unknown` rather than
        // an unearned `none`.
        ...(form.frameGeneration === "" ? {} : { frameGeneration: form.frameGeneration }),
        transport: createDesktopTransport(state.environment.apiBaseUrl),
        signPayload: createSigner(),
        onProgress: (progress) => {
          dispatch({
            type: "upload",
            phase:
              progress.stage === "uploading"
                ? {
                    status: "running",
                    label: "Uploading",
                    sentBytes: progress.sentBytes,
                    totalBytes: progress.totalBytes,
                  }
                : { status: "running", label: LABELS[progress.stage] ?? "Working" },
          });
        },
      });
    } catch (error) {
      dispatch({
        type: "upload",
        phase: {
          status: "failed",
          code: "upload-failed",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    } finally {
      if (uploadReserved) {
        try {
          await ipc.endUpload();
        } catch (error) {
          // The shared engine has settled, so this is a local state failure,
          // not grounds to discard a recovery token returned below.
          console.error("failed to release native upload activity", error);
        }
      }
    }

    if (!result.ok) {
      if (result.recovery !== undefined) {
        await handoffClaim(
          result.recovery.runId,
          result.recovery.managementToken,
          "recovery",
          result.message,
        );
        return;
      }
      dispatch({ type: "upload", phase: { status: "failed", ...result } });
      return;
    }
    await handoffClaim(result.runId, result.managementToken, "confirmed");
  }, [captureHardware, detected, form, handoffClaim, state.capture, state.environment]);

  const discard = React.useCallback(() => {
    void ipc.discardPayload();
    dispatch({ type: "discard" });
  }, []);

  /* ── Render ─────────────────────────────────────────────────────────── */

  if (state.environment === null) {
    return (
      <div className="win">
        <TitleBar />
        <div className="body" style={{ display: "grid", placeItems: "center" }}>
          <Spinner label="Checking this machine" />
        </div>
      </div>
    );
  }

  const missing = missingFields(form);
  const averageFps = live.averageFps();
  const claimCapabilityHeld = state.upload.status === "claim";
  const uploadActive = state.upload.status === "running";

  return (
    <div className="win">
      <TitleBar />
      <div className="body">
        {crashReport === null ? null : (
          <div style={{ marginBottom: 16 }}>
            <Diagnostic severity="warn" title="Heimdall Capture closed unexpectedly last time">
              Nothing has been sent. You can review the local crash log and open a pre-filled report,
              or dismiss it.
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    void ipc.openCrashReport(crashReport);
                    setCrashReport(null);
                  }}
                >
                  Send crash report
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void ipc.dismissCrashReport();
                    setCrashReport(null);
                  }}
                >
                  Dismiss
                </Button>
              </div>
            </Diagnostic>
          </div>
        )}

        {update.status === "available" || update.status === "installing" ? (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Diagnostic
              severity="info"
              title={`Heimdall Capture ${update.info.version} is available`}
            >
              The update manifest and package signature will be verified before installation.
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  marginTop: "var(--space-3)",
                }}
              >
                <Button
                  size="sm"
                  loading={update.status === "installing"}
                  disabled={state.screen === "capturing" || uploadActive || claimCapabilityHeld}
                  onClick={() => {
                    const info = update.info;
                    setUpdate({ status: "installing", info });
                    void ipc.installUpdate().catch((error: unknown) => {
                      setUpdate({
                        status: "failed",
                        message: error instanceof Error ? error.message : String(error),
                      });
                    });
                  }}
                >
                  Install and restart
                </Button>
              </div>
            </Diagnostic>
          </div>
        ) : update.status === "failed" ? (
          <div style={{ marginBottom: "var(--space-4)" }}>
            <Diagnostic severity="warn" title="Could not check for updates">
              {update.message}
              <div style={{ marginTop: "var(--space-3)" }}>
                <Button size="sm" variant="secondary" onClick={() => void checkForUpdate()}>
                  Retry
                </Button>
              </div>
            </Diagnostic>
          </div>
        ) : null}

        {state.screen === "onboarding" ? (
          <Onboarding
            environment={state.environment}
            onContinue={() => dispatch({ type: "continue-from-onboarding" })}
            onOpenGuide={() => void ipc.openSetupGuide()}
            onRecheck={() => void refreshEnvironment()}
          />
        ) : (
          <>
            <StatusHero
              screen={state.screen}
              captureTool={state.environment.captureTool}
              platformLabel={PLATFORM_LABELS[state.environment.platform]}
            />

            {state.screen === "armed" && state.armed !== null && (
              <div className="panel panel--roomy" style={{ marginBottom: 16 }}>
                <p style={{ font: "var(--type-body-sm)", color: "var(--fg-2)", margin: 0 }}>
                  {state.armed.hint}
                </p>
                <span
                  className="heimdall-overline"
                  style={{ display: "block", marginTop: 12, marginBottom: 6 }}
                >
                  Watching for logs in
                </span>
                {state.armed.logDirs.map((dir) => (
                  <div key={dir} className="hw-row">
                    <span data-mono className="hw-row__value" title={dir}>
                      {dir}
                    </span>
                  </div>
                ))}
                {state.armed.liveTraceExpected ? null : (
                  <p
                    style={{
                      font: "var(--type-caption)",
                      color: "var(--fg-3)",
                      marginBottom: 0,
                      marginTop: 10,
                    }}
                  >
                    No log_interval is set, so MangoHud may only write the log when you stop
                    logging. The capture still works — Heimdall just cannot draw a live chart
                    while it runs.
                  </p>
                )}
              </div>
            )}

            {state.screen === "capturing" && (
              <div className="panel panel--roomy" style={{ marginBottom: 16 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "baseline",
                    marginBottom: 10,
                  }}
                >
                  <span className="heimdall-overline">Elapsed</span>
                  <span data-mono style={{ font: "var(--type-metric)", color: "var(--fg-1)" }}>
                    {formatElapsed(state.elapsedMs)}
                  </span>
                </div>
                {/* An empty chart reads as broken. When no rows have been
                    framed yet — MangoHud between flushes (§23.1) — say why
                    instead of drawing nothing. Skip, never fail. */}
                {state.frames === 0 && live.awaitingHeader() ? (
                  <p
                    style={{
                      font: "var(--type-body-sm)",
                      color: "var(--fg-3)",
                      margin: "var(--space-2) 0",
                    }}
                  >
                    {state.environment.watcherMode
                      ? "MangoHud is logging — the trace appears when it flushes."
                      : "Waiting for the first frames."}
                  </p>
                ) : (
                  <FrameTimeChart samples={live.window()} />
                )}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
                  <span data-mono style={{ font: "var(--type-data)", color: "var(--tier-avg)" }}>
                    {averageFps === null ? "— fps" : `${averageFps.toFixed(1)} fps`}
                  </span>
                  <span data-mono style={{ font: "var(--type-data)", color: "var(--fg-3)" }}>
                    {`${state.frames.toLocaleString()} frames`}
                  </span>
                </div>
              </div>
            )}

            {state.screen === "complete" && state.capture !== null && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 8,
                  marginBottom: 16,
                }}
              >
                <Stat
                  label="Avg"
                  value={state.capture.summary.avgFps.toFixed(0)}
                  accent="var(--tier-avg)"
                />
                <Stat
                  label="1% low"
                  value={state.capture.summary.onePercentLowFps.toFixed(0)}
                  accent="var(--tier-p1)"
                />
                <Stat
                  label="0.1%"
                  value={state.capture.summary.pointOnePercentLowFps.toFixed(0)}
                  accent="var(--tier-p01)"
                />
              </div>
            )}

            {state.screen !== "capturing" && state.screen !== "armed" && (
              <HardwareRows
                game={form.game || state.target?.process || ""}
                hardware={detected?.hardware ?? null}
                hotkey={state.hotkey}
              />
            )}

            {state.notice === null ? null : (
              <div style={{ marginBottom: 16 }}>
                <Diagnostic severity="warn" title="Capture notice">
                  {state.notice}
                </Diagnostic>
              </div>
            )}

            {state.screen === "ready" && state.antiCheat !== null && (
              <div style={{ marginBottom: 16 }}>
                <Diagnostic severity="warn" title="Anti-cheat detected">
                  The foreground title runs {state.antiCheat}. Capture still works; keep it to
                  single-player or benchmark scenes to avoid conflicts.
                </Diagnostic>
              </div>
            )}

            {state.hotkey !== null && state.hotkey.status !== "registered" && (
              <div style={{ marginBottom: 16 }}>
                <Diagnostic severity="warn" title="Capture hotkey is not active">
                  {state.hotkey.message ?? "The shortcut could not be registered."} Use the button
                  below, or the tray menu, until it is free.
                </Diagnostic>
              </div>
            )}

            {state.screen === "ready" && (
              <Button
                size="lg"
                block
                loading={state.analyzing}
                iconLeft={<CircleIcon size={16} />}
                onClick={() => void startCapture()}
              >
                {state.environment.watcherMode ? "Arm capture" : "Start capture"}
              </Button>
            )}

            {state.screen === "armed" && (
              <Button
                size="lg"
                block
                variant="secondary"
                loading={state.analyzing}
                iconLeft={<SquareIcon size={14} />}
                onClick={() => void disarm()}
              >
                Cancel
              </Button>
            )}

            {state.screen === "capturing" && (
              <Button
                size="lg"
                block
                variant="danger"
                loading={state.analyzing}
                iconLeft={<SquareIcon size={14} />}
                onClick={() => void analyzeCapture()}
              >
                Stop &amp; analyze
              </Button>
            )}

            {state.screen === "complete" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <RunDetailsPanel
                  form={form}
                  missing={missing}
                  onChange={(key, value) => {
                    editedRef.current.add(key);
                    setForm((current) => ({ ...current, [key]: value }));
                  }}
                />

                <Diagnostic
                  severity="info"
                  title={
                    state.environment.signingAvailable
                      ? "Frame data signed and ready to upload"
                      : "Ready to upload (this build is unsigned)"
                  }
                >
                  The signature covers the frame data only — the hardware and settings above are
                  declared, not signed. It is recorded as evidence and never decides whether a run
                  is accepted.
                </Diagnostic>

                {state.upload.status === "failed" && (
                  <Diagnostic severity="bad" title="Upload failed">
                    {state.upload.message}
                  </Diagnostic>
                )}

                {state.upload.status === "claim" ? (
                  <Diagnostic
                    severity="warn"
                    title={
                      state.upload.context === "recovery"
                        ? "Upload status needs recovery"
                        : "Run uploaded — browser handoff failed"
                    }
                  >
                    {state.upload.message === undefined ? null : (
                      <div style={{ marginBottom: "var(--space-2)" }}>
                        {state.upload.message}
                      </div>
                    )}
                    {state.upload.handoff === "failed" ? (
                      <div style={{ marginBottom: "var(--space-2)" }}>
                        The claim page could not be opened: {state.upload.handoffMessage}. The
                        one-time management credential is still held in this window.
                      </div>
                    ) : (
                      <div style={{ marginBottom: "var(--space-2)" }}>
                        Opening the claim page while this window retains the one-time management
                        credential.
                      </div>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={state.upload.handoff === "opening"}
                      onClick={() => {
                        const phase = stateRef.current.upload;
                        if (phase.status !== "claim") return;
                        void handoffClaim(
                          phase.runId,
                          phase.managementToken,
                          phase.context,
                          phase.message,
                        );
                      }}
                    >
                      Open claim page
                    </Button>
                  </Diagnostic>
                ) : state.upload.status === "done" ? (
                  <>
                    <Diagnostic severity="good" title="Uploaded">
                      {state.upload.context === "recovery"
                        ? "The recovery page opened in your browser. Keep it open until the run is confirmed or claimed."
                        : "The run report opened in your browser. Sign in there to claim it — the claim link works once."}
                    </Diagnostic>
                    <Badge tone="neutral">Run {state.upload.runId}</Badge>
                    <Button variant="secondary" block onClick={discard}>
                      Capture another run
                    </Button>
                  </>
                ) : (
                  <div style={{ display: "flex", gap: 8 }}>
                    <Button
                      variant="secondary"
                      style={{ flex: 1 }}
                      disabled={state.upload.status === "running"}
                      onClick={discard}
                    >
                      Discard
                    </Button>
                    <Button
                      style={{ flex: 2 }}
                      loading={state.upload.status === "running"}
                      iconLeft={<UploadIcon size={16} />}
                      onClick={() => void upload()}
                    >
                      {state.upload.status === "running"
                        ? uploadLabel(state.upload)
                        : "Upload & share"}
                    </Button>
                  </div>
                )}
              </div>
            )}

            <p
              style={{
                font: "var(--type-caption)",
                color: "var(--fg-4)",
                textAlign: "center",
                marginTop: 14,
              }}
            >
              {state.screen === "ready" &&
                (state.hotkey?.status === "registered"
                  ? `Press ${state.hotkey.accelerator} in-game to start hands-free.`
                  : "Set a working hotkey to capture hands-free.")}
              {state.screen === "armed" &&
                "Heimdall records nothing until MangoHud starts writing a log."}
              {state.screen === "capturing" && "Recommended capture length: 60 seconds."}
              {state.screen === "complete" &&
                "Uploads are public or unlisted; claim the run to make it private."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** Badge copy for the running backend (§23.1). */
const PLATFORM_LABELS: Record<ipc.Environment["platform"], string> = {
  windows: "Windows",
  linux: "Linux",
  other: "Unsupported platform",
};

const LABELS: Record<string, string> = {
  parsing: "Parsing",
  "building-parquet": "Encoding",
  creating: "Creating run",
  uploading: "Uploading",
  finalizing: "Finalizing",
  done: "Done",
};

function uploadLabel(phase: Extract<State["upload"], { status: "running" }>): string {
  if (phase.totalBytes === undefined || phase.sentBytes === undefined) return phase.label;
  const pct = phase.totalBytes === 0 ? 0 : Math.round((phase.sentBytes / phase.totalBytes) * 100);
  return `${phase.label} ${pct}%`;
}
