"use client";

/**
 * The shareable run report (§13) — production port of
 * design/ui_kits/web/RunPage.jsx. The run row (summary/hardware/badges)
 * arrives server-rendered; per-frame data loads client-side through the typed
 * API client (§13.5 states: loading / still-processing / error / ready).
 * The frames loader is injectable so component tests drive every state.
 */

import * as React from "react";
import { Card, Diagnostic, Button, Segmented, Spinner, Switch } from "@heimdall/ui";
import { RUN_STATUS, type Run } from "@heimdall/shared";
import type { BenchmarkSetStats } from "@heimdall/parsers";
import { loadRunFrames, type ApiResult, type FrameDecodeOptions } from "@/lib/api/client";
import type { FrameSeries } from "@/lib/run/frame-series";
import { findStutterIndices, medianFrameTimeMs } from "@/lib/run/stutters";
import { CHART_UNITS, type ChartUnit } from "@/lib/run/units";
import { CAPTION_STYLE } from "../primitives";
import { FrameTimeChart } from "./chart/FrameTimeChart";
import {
  busyOverlayReason,
  busyReadinessFromManifest,
  hagsQualification,
  type BusyReadiness,
} from "./busy-readiness";
import { RunHeader } from "./RunHeader";
import { RunStatTiles } from "./RunStatTiles";
import { SmoothnessBars } from "./SmoothnessBars";
import { CapabilityCard } from "./CapabilityCard";
import { DiagnosticsCard } from "./DiagnosticsCard";
import { HardwareCard } from "./HardwareCard";
import { BenchmarkSetCard } from "./BenchmarkSetCard";
import { IncompleteProfileCard } from "./IncompleteProfileCard";
import { ClaimRunCard } from "./ClaimRunCard";
import styles from "./RunPageClient.module.css";

export type FramesLoader = (
  id: string,
  signal?: AbortSignal,
  decode?: FrameDecodeOptions,
) => Promise<ApiResult<FrameSeries>>;

type FramesState =
  | { kind: "loading" }
  | { kind: "not-finalized" }
  | { kind: "error"; message: string }
  | { kind: "ready"; series: FrameSeries; stutterIndices: Uint32Array };

const CHART_WELL_MIN_HEIGHT = 260;
const defaultFramesLoader: FramesLoader = (id, signal, decode) =>
  loadRunFrames(id, undefined, signal, decode);

/** Busy time is a duration, so it is never converted to the FPS axis. */
const BUSY_UNIT_REASON = "Busy time is a duration — switch to ms";

/**
 * §8.6.8 gating, skip-never-fail: the overlay is offered only when the
 * capability manifest declares BOTH busy sensors present and frame-aligned,
 * and the decoded frames actually carry samples. Returns the reason it is not
 * offered, or `undefined` when it is — an unavailable state always names
 * itself instead of hiding the control silently. The manifest half of the
 * ladder is shared with the capability panel and the diagnostics engine so
 * every surface states one verdict (`busy-readiness.ts`).
 */
function busyUnavailableReason(declared: BusyReadiness, series?: FrameSeries): string | undefined {
  if (declared.kind === "unavailable") return busyOverlayReason(declared.cause);
  // Belt-and-braces: never fabricate a trace the decoded frames don't carry,
  // even when the manifest says they should. Either column missing is enough —
  // the legend advertises both, so one-sided data must not read as available.
  if (series && (series.cpuBusyMs === undefined || series.gpuBusyMs === undefined)) {
    return busyOverlayReason("no-samples");
  }
  return undefined;
}

/** One dot + label chart legend chip, one shape for every trace. */
function LegendChip({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        ...CAPTION_STYLE,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: "var(--radius-pill)", background: color }} />
      {children}
    </span>
  );
}

export function RunPageClient({
  run,
  benchmarkSet,
  loadFrames = defaultFramesLoader,
  claimToken,
}: {
  run: Run;
  benchmarkSet?: BenchmarkSetStats | null;
  loadFrames?: FramesLoader;
  /**
   * Plaintext management token from a desktop handoff's `?claim=` parameter
   * (§22.5). Only ever set when the run is still unowned; the server decides.
   */
  claimToken?: string;
}) {
  const [frames, setFrames] = React.useState<FramesState>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  const [unit, setUnit] = React.useState<ChartUnit>("ms");
  const [busyOverlay, setBusyOverlay] = React.useState(false);

  // The manifest verdict, derived once: it gates both the overlay control and
  // whether the busy columns are worth decoding at all.
  const declaredReadiness = busyReadinessFromManifest(run.capabilityManifest);
  const unavailableReason = busyUnavailableReason(
    declaredReadiness,
    frames.kind === "ready" ? frames.series : undefined,
  );
  const busyToggleable = unavailableReason === undefined && unit === "ms" && frames.kind === "ready";
  const busyDrawn = busyToggleable && busyOverlay;
  // Why the toggle is off, as text the reader can actually see. The Switch
  // forwards `title` to its visible label for pointer users, but a tooltip alone
  // is still insufficient — the same visible-text rule §8.6.6 applies to the
  // smoothness sample count.
  const busyOffReason = unavailableReason ?? (unit !== "ms" ? BUSY_UNIT_REASON : undefined);

  // Decode busy columns in the same pass only for a manifest that can expose
  // the overlay. Deferring until the first toggle would require retaining up to
  // a 64 MiB Parquet buffer for the page lifetime or downloading the signed
  // object a second time; two bounded column passes during the existing decode
  // are the cheaper and lower-memory trade-off (§8.6.8).
  const busyDeclared = declaredReadiness.kind === "ready";

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setFrames({ kind: "loading" });
    void loadFrames(run.id, controller.signal, { busyColumns: busyDeclared })
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          // Pending summaries originate with the uploader. Only a validated run
          // may reuse its server-recomputed median; every other status derives
          // the threshold from the decoded frames.
          const medianMs =
            run.status === RUN_STATUS.validated
              ? run.summary.frameTimeP50Ms
              : medianFrameTimeMs(result.data.frameTimes);
          const stutterIndices = findStutterIndices(result.data.frameTimes, medianMs);
          setFrames({ kind: "ready", series: result.data, stutterIndices });
        } else if (result.code === "not-finalized") {
          setFrames({ kind: "not-finalized" });
        } else {
          setFrames({ kind: "error", message: result.message });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFrames({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [run.id, run.status, run.summary.frameTimeP50Ms, loadFrames, busyDeclared, attempt]);

  return (
    <main id="main-content" tabIndex={-1} className={styles.page}>
      <RunHeader run={run} />
      {claimToken === undefined ? null : (
        <ClaimRunCard runId={run.id} token={claimToken} />
      )}
      <RunStatTiles summary={run.summary} />

      <div className={styles.mainGrid}>
        {/* Frame-time chart card */}
        <Card className={styles.chartColumn}>
          <Card.Header
            title="Frame-time progression"
            actions={
              <div className={styles.chartActions}>
                <LegendChip color="var(--chart-stutter)">stutter</LegendChip>
                {/* §8.6.8 overlay legend chips — only while the overlay draws */}
                {busyDrawn && (
                  <>
                    <LegendChip color="var(--chart-cpu-busy)">CPU busy</LegendChip>
                    <LegendChip color="var(--chart-gpu-busy)">GPU busy</LegendChip>
                  </>
                )}
                <Segmented
                  value={unit}
                  onChange={(value) => setUnit(value as ChartUnit)}
                  options={CHART_UNITS.map((u) => ({ value: u, label: u === "ms" ? "ms" : "FPS" }))}
                  disabled={frames.kind !== "ready"}
                />
                <Switch
                  label="Busy time"
                  checked={busyDrawn}
                  onChange={(event) => setBusyOverlay(event.target.checked)}
                  disabled={!busyToggleable}
                  title={busyOffReason}
                />
              </div>
            }
          />
          <Card.Body>
            <Card variant="inset">
              <div
                style={{
                  minHeight: CHART_WELL_MIN_HEIGHT,
                  display: "grid",
                  placeItems: frames.kind === "ready" ? "stretch" : "center",
                  padding: "var(--space-3)",
                }}
              >
                {frames.kind === "loading" && (
                  <Spinner size={28} label="Loading frame data" />
                )}
                {frames.kind === "not-finalized" && (
                  <div style={{ textAlign: "center" }}>
                    <p style={{ font: "var(--type-subheading)", color: "var(--fg-1)" }}>
                      Frames still processing
                    </p>
                    <p
                      style={{
                        font: "var(--type-body-sm)",
                        color: "var(--fg-3)",
                        marginTop: "var(--space-1)",
                      }}
                    >
                      The chart appears once the upload finishes — summary numbers above are
                      already in.
                    </p>
                  </div>
                )}
                {frames.kind === "error" && (
                  <div style={{ width: "100%" }}>
                    <Diagnostic severity="bad" title="Could not load frame data">
                      <span>{frames.message}</span>
                      <span style={{ display: "block", marginTop: "var(--space-3)" }}>
                        <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
                          Retry
                        </Button>
                      </span>
                    </Diagnostic>
                  </div>
                )}
                {frames.kind === "ready" && (
                  <FrameTimeChart
                    series={frames.series}
                    stutterIndices={frames.stutterIndices}
                    unit={unit}
                    avgFps={run.summary.avgFps}
                    showBusy={busyDrawn}
                  />
                )}
              </div>
            </Card>
            {/* §8.6.8 overlay caption: honest reading notes while it draws, the
                named reason when the capture can't support it. Mutually
                exclusive — `busyDrawn` implies no `busyOffReason`. */}
            {(busyDrawn || busyOffReason) && (
              <p style={{ ...CAPTION_STYLE, marginTop: "var(--space-2)" }}>
                {busyDrawn
                  ? `Gaps mark frames the sensor did not report.${hagsQualification(run.methodologyManifest?.hags)}`
                  : busyOffReason}
              </p>
            )}
            <div style={{ marginTop: "var(--space-5)" }}>
              <span
                className="heimdall-overline"
                style={{ display: "block", marginBottom: "var(--space-3)" }}
              >
                Smoothness tiers
              </span>
              <SmoothnessBars summary={run.summary} />
            </div>
          </Card.Body>
        </Card>

        {/* Right column: diagnostics + hardware */}
        <div className={styles.sideColumn}>
          <DiagnosticsCard diagnostics={run.diagnostics} status={run.status} />
          <HardwareCard
            hardware={run.hardware}
            capabilityManifest={run.capabilityManifest}
            series={frames.kind === "ready" ? frames.series : undefined}
          />
          <CapabilityCard
            manifest={run.capabilityManifest}
            captureSource={run.captureSource}
            hags={run.methodologyManifest?.hags}
          />
          {benchmarkSet ? (
            <BenchmarkSetCard
              stats={benchmarkSet}
              currentRunIsWarmup={run.isWarmup === true}
            />
          ) : run.benchmarkSetId ? (
            <IncompleteProfileCard manifest={run.methodologyManifest} />
          ) : null}
        </div>
      </div>
    </main>
  );
}
