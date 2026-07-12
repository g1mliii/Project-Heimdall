"use client";

/**
 * The shareable run report (§13) — production port of
 * design/ui_kits/web/RunPage.jsx. The run row (summary/hardware/badges)
 * arrives server-rendered; per-frame data loads client-side through the typed
 * API client (§13.5 states: loading / still-processing / error / ready).
 * The frames loader is injectable so component tests drive every state.
 */

import * as React from "react";
import { Card, Diagnostic, Button, Segmented, Spinner } from "@heimdall/ui";
import { RUN_STATUS, type Run } from "@heimdall/shared";
import { loadRunFrames, type ApiResult } from "@/lib/api/client";
import type { FrameSeries } from "@/lib/run/frame-series";
import { findStutterIndices, medianFrameTimeMs } from "@/lib/run/stutters";
import { CHART_UNITS, type ChartUnit } from "@/lib/run/units";
import { FrameTimeChart } from "./chart/FrameTimeChart";
import { RunHeader } from "./RunHeader";
import { RunStatTiles } from "./RunStatTiles";
import { SmoothnessBars } from "./SmoothnessBars";
import { DiagnosticsCard } from "./DiagnosticsCard";
import { HardwareCard } from "./HardwareCard";
import styles from "./RunPageClient.module.css";

export type FramesLoader = (id: string, signal?: AbortSignal) => Promise<ApiResult<FrameSeries>>;

type FramesState =
  | { kind: "loading" }
  | { kind: "not-finalized" }
  | { kind: "error"; message: string }
  | { kind: "ready"; series: FrameSeries; stutterIndices: Uint32Array };

const CHART_WELL_MIN_HEIGHT = 260;
const defaultFramesLoader: FramesLoader = (id, signal) => loadRunFrames(id, undefined, signal);

export function RunPageClient({
  run,
  loadFrames = defaultFramesLoader,
}: {
  run: Run;
  loadFrames?: FramesLoader;
}) {
  const [frames, setFrames] = React.useState<FramesState>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  const [unit, setUnit] = React.useState<ChartUnit>("ms");

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setFrames({ kind: "loading" });
    void loadFrames(run.id, controller.signal)
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
  }, [run.id, run.status, run.summary.frameTimeP50Ms, loadFrames, attempt]);

  return (
    <main id="main-content" tabIndex={-1} className={styles.page}>
      <RunHeader run={run} />
      <RunStatTiles summary={run.summary} />

      <div className={styles.mainGrid}>
        {/* Frame-time chart card */}
        <Card className={styles.chartColumn}>
          <Card.Header
            title="Frame-time progression"
            actions={
              <div className={styles.chartActions}>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--space-1)",
                    font: "var(--type-caption)",
                    color: "var(--fg-3)",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "var(--radius-pill)",
                      background: "var(--chart-stutter)",
                    }}
                  />
                  stutter
                </span>
                <Segmented
                  value={unit}
                  onChange={(value) => setUnit(value as ChartUnit)}
                  options={CHART_UNITS.map((u) => ({ value: u, label: u === "ms" ? "ms" : "FPS" }))}
                  disabled={frames.kind !== "ready"}
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
                  />
                )}
              </div>
            </Card>
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
          <DiagnosticsCard />
          <HardwareCard
            hardware={run.hardware}
            series={frames.kind === "ready" ? frames.series : undefined}
          />
        </div>
      </div>
    </main>
  );
}
