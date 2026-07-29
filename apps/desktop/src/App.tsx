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
import { INGEST_LIMITS, type MethodologyManifest } from "@heimdall/shared";
import { uploadCaptureBytes } from "@heimdall/ingest-client";
import { FrameTimeChart } from "./components/FrameTimeChart";
import { Onboarding } from "./components/Onboarding";
import { RunDetailsPanel } from "./components/RunDetailsPanel";
import { HardwareRows, StatusHero } from "./components/StatusHero";
import { TitleBar } from "./components/TitleBar";
import { CircleIcon, ShieldAlertIcon, ShieldCheckIcon, SquareIcon, UploadIcon } from "./components/icons";
import * as ipc from "./lib/ipc";
import { LiveFrameTimes } from "./lib/live-frames";
import { formatElapsed, initialState, reducer, toggleIntent, type State } from "./lib/machine";
import { missingFields, prefillForm, toMethodology, type RunDetailsForm } from "./lib/run-details";
import { createDesktopTransport, createSigner } from "./lib/transport";

const TICK_MS = 200;

export function App() {
  const [state, dispatch] = React.useReducer(reducer, initialState);
  const [detected, setDetected] = React.useState<ipc.DeclaredHardware | null>(null);
  const [form, setForm] = React.useState<RunDetailsForm>(prefillForm(null, undefined));
  const [crashReport, setCrashReport] = React.useState<string | null>(null);
  // A ref, not state: the readout is mutated on every stdout chunk and the
  // re-render is already driven by the frame count in the reducer. Holding it
  // in state would either lose updates (same instance, so React bails) or
  // reallocate the whole window several times a second.
  const liveRef = React.useRef<LiveFrameTimes | null>(null);
  liveRef.current ??= new LiveFrameTimes();
  const live = liveRef.current;

  // The reducer is pure, so event handlers registered once would close over a
  // stale state. A ref keeps the toggle decision reading the current one.
  const stateRef = React.useRef<State>(state);
  stateRef.current = state;

  const refreshEnvironment = React.useCallback(async () => {
    dispatch({ type: "environment", environment: await ipc.getEnvironment() });
  }, []);

  const startCapture = React.useCallback(async () => {
    try {
      liveRef.current = new LiveFrameTimes();
      const started = await ipc.startCapture();
      dispatch({ type: "capture-started", started });
    } catch (error) {
      dispatch({
        type: "capture-failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const analyzeCapture = React.useCallback(async () => {
    dispatch({ type: "analyzing" });
    try {
      const result = await ipc.stopCapture();
      const bytes = new TextEncoder().encode(result.csv);
      // Same parser, same limits as the browser upload path (§22.1).
      const parsed = parseAnyCapture(bytes, { maxFrames: INGEST_LIMITS.maxFramesPerRun });
      if (!parsed.ok) {
        dispatch({ type: "capture-failed", message: parsed.error.message });
        return;
      }
      if (parsed.capture.frames.length < INGEST_LIMITS.minFramesPerRun) {
        dispatch({
          type: "capture-failed",
          message: `Only ${parsed.capture.frames.length} frames were captured (minimum ${INGEST_LIMITS.minFramesPerRun}). Capture for longer.`,
        });
        return;
      }
      setForm((current) => ({
        ...current,
        ...prefillForm(detected, result.target.process),
        // Anything the user already typed wins over a re-detected default.
        ...Object.fromEntries(Object.entries(current).filter(([, value]) => value !== "")),
      }));
      dispatch({
        type: "analyzed",
        capture: {
          csv: result.csv,
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
  }, [detected]);

  const toggleCapture = React.useCallback(() => {
    const intent = toggleIntent(stateRef.current);
    if (intent === "start") void startCapture();
    if (intent === "stop") void analyzeCapture();
  }, [startCapture, analyzeCapture]);

  const toggleRef = React.useRef(toggleCapture);
  toggleRef.current = toggleCapture;

  /* ── Boot + event wiring ────────────────────────────────────────────── */

  React.useEffect(() => {
    void refreshEnvironment();
    void ipc.getHardware().then(setDetected);
    void ipc.pendingCrashReport().then(setCrashReport);
  }, [refreshEnvironment]);

  React.useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      ipc.on<ipc.CaptureStarted>(ipc.EVENTS.started, (started) =>
        dispatch({ type: "capture-started", started }),
      ),
      ipc.on<ipc.CaptureRows>(ipc.EVENTS.rows, (rows) => {
        liveRef.current?.push(rows.lines);
        dispatch({ type: "capture-rows", frames: rows.frames });
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
      ipc.on(ipc.EVENTS.hotkey, () => toggleRef.current()),
      ipc.on(ipc.EVENTS.trayToggle, () => toggleRef.current()),
    ];
    return () => {
      for (const pending of unlisteners) void pending.then((unlisten) => unlisten());
    };
  }, [analyzeCapture]);

  // Elapsed timer. Driven off wall-clock deltas rather than a tick count so a
  // throttled background window does not under-report the capture length.
  React.useEffect(() => {
    if (state.screen !== "capturing") return;
    let previous = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      dispatch({ type: "tick", deltaMs: now - previous });
      previous = now;
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [state.screen]);

  /* ── Upload ─────────────────────────────────────────────────────────── */

  const upload = React.useCallback(async () => {
    if (state.capture === null || state.environment === null) return;
    const hags = detected?.methodology.hags;
    const methodology = {
      ...toMethodology(form),
      captureTool: detected?.methodology.captureTool,
      // Omitted entirely when unknown: an undeclared field is honest, a
      // fabricated "disabled" is not.
      ...(hags === undefined ? {} : { hags: hags ? "enabled" : "disabled" }),
    } as Omit<MethodologyManifest, "version" | "frameGeneration">;

    dispatch({ type: "upload", phase: { status: "running", label: "Preparing" } });
    const result = await uploadCaptureBytes(new TextEncoder().encode(state.capture.csv), {
      game: form.game.trim() || "Unknown game",
      visibility: form.visibility,
      ...(detected === null ? {} : { hardware: detected.hardware }),
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

    if (!result.ok) {
      dispatch({ type: "upload", phase: { status: "failed", ...result } });
      return;
    }
    dispatch({
      type: "upload",
      phase: {
        status: "done",
        runId: result.runId,
        managementToken: result.managementToken,
      },
    });
    // Claim handoff (§22.5): the plaintext token goes to the browser and
    // nowhere else.
    await ipc.openClaim(result.runId, result.managementToken);
  }, [detected, form, state.capture, state.environment]);

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

        {state.screen === "onboarding" ? (
          <Onboarding
            environment={state.environment}
            onContinue={() => dispatch({ type: "continue-from-onboarding" })}
            onOpenGuide={() => void ipc.openSetupGuide()}
            onRecheck={() => void refreshEnvironment()}
          />
        ) : (
          <>
            <StatusHero screen={state.screen} captureTool={state.environment.captureTool} />

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
                <FrameTimeChart samples={live.window()} />
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

            {state.screen !== "capturing" && (
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
                  <ShieldAlertIcon size={0} />
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
                Start capture
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
                  onChange={(key, value) => setForm((current) => ({ ...current, [key]: value }))}
                />

                <Diagnostic
                  severity="info"
                  title={
                    state.environment.signingAvailable
                      ? "Frame data signed and ready to upload"
                      : "Ready to upload (this build is unsigned)"
                  }
                >
                  <ShieldCheckIcon size={0} />
                  The signature covers the frame data only — the hardware and settings above are
                  declared, not signed. It is recorded as evidence and never decides whether a run
                  is accepted.
                </Diagnostic>

                {state.upload.status === "failed" && (
                  <Diagnostic severity="bad" title="Upload failed">
                    {state.upload.message}
                  </Diagnostic>
                )}

                {state.upload.status === "done" ? (
                  <>
                    <Diagnostic severity="good" title="Uploaded">
                      The run report is opening in your browser. Sign in there to claim it — the
                      claim link works once.
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
