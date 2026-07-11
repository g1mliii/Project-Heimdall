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
import type { FrameSample, Run } from "@heimdall/shared";
import { loadRunFrames, type ApiResult } from "@/lib/api/client";
import { buildFrameSeries, type FrameSeries } from "@/lib/run/frame-series";
import { findStutterIndices } from "@/lib/run/stutters";
import { CHART_UNITS, type ChartUnit } from "@/lib/run/units";
import { RunHeader } from "./RunHeader";
import { RunStatTiles } from "./RunStatTiles";
import { SmoothnessBars } from "./SmoothnessBars";
import { DiagnosticsCard } from "./DiagnosticsCard";
import { HardwareCard } from "./HardwareCard";

export type FramesLoader = (id: string) => Promise<ApiResult<FrameSample[]>>;

type FramesState =
  | { kind: "loading" }
  | { kind: "not-finalized" }
  | { kind: "error"; message: string }
  | { kind: "ready"; series: FrameSeries; stutterIndices: Uint32Array };

const CHART_WELL_MIN_HEIGHT = 260;

export function RunPageClient({
  run,
  loadFrames = loadRunFrames,
}: {
  run: Run;
  loadFrames?: FramesLoader;
}) {
  const [frames, setFrames] = React.useState<FramesState>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  const [unit, setUnit] = React.useState<ChartUnit>("ms");

  React.useEffect(() => {
    let cancelled = false;
    setFrames({ kind: "loading" });
    void loadFrames(run.id).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        const series = buildFrameSeries(result.data);
        setFrames({ kind: "ready", series, stutterIndices: findStutterIndices(series.frameTimes) });
      } else if (result.code === "not-finalized") {
        setFrames({ kind: "not-finalized" });
      } else {
        setFrames({ kind: "error", message: result.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [run.id, loadFrames, attempt]);

  return (
    <div
      style={{
        maxWidth: "var(--container-max)",
        margin: "0 auto",
        padding: "var(--space-8) var(--space-6) var(--space-16)",
      }}
    >
      <RunHeader run={run} />
      <RunStatTiles summary={run.summary} />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 21.25rem",
          gap: "var(--space-5)",
          marginTop: "var(--space-5)",
          alignItems: "start",
        }}
      >
        {/* Frame-time chart card */}
        <Card>
          <Card.Header
            title="Frame-time progression"
            actions={
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
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
                  placeItems: "center",
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
                  <p
                    data-chart-placeholder
                    style={{ font: "var(--type-caption)", color: "var(--fg-3)" }}
                  >
                    {frames.series.count.toLocaleString()} frames loaded
                  </p>
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
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
          <DiagnosticsCard />
          <HardwareCard
            hardware={run.hardware}
            series={frames.kind === "ready" ? frames.series : undefined}
          />
        </div>
      </div>
    </div>
  );
}
