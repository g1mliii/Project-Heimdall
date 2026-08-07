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
import { buildRenderedSeries } from "@/lib/run/rendered-series";
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
import {
  BUSY_RENDERED_MODE_REASON,
  RATE_MODE,
  SERIES_UNAVAILABLE_REASON,
  renderedRateCaption,
  renderedRateReadiness,
  renderedRateToggleReadiness,
  type RateMode,
} from "./rendered-rate-readiness";
import { RunHeader } from "./RunHeader";
import { RunStatTiles } from "./RunStatTiles";
import { SmoothnessBars } from "./SmoothnessBars";
import { CapabilityCard } from "./CapabilityCard";
import { DiagnosticsCard } from "./DiagnosticsCard";
import { HardwareCard } from "./HardwareCard";
import { BenchmarkSetCard } from "./BenchmarkSetCard";
import { IncompleteProfileCard } from "./IncompleteProfileCard";
import { ClaimRunCard } from "./ClaimRunCard";
import { clearClaimHandoff, consumeClaimHandoff } from "./claim-handoff";
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
  claimable = false,
}: {
  run: Run;
  benchmarkSet?: BenchmarkSetStats | null;
  loadFrames?: FramesLoader;
  /**
   * Whether the server-side row is still unowned. The plaintext token itself
   * stays in the browser fragment/tab and never crosses the server-component
   * boundary.
   */
  claimable?: boolean;
}) {
  const [frames, setFrames] = React.useState<FramesState>({ kind: "loading" });
  const [attempt, setAttempt] = React.useState(0);
  const [unit, setUnit] = React.useState<ChartUnit>("ms");
  const [busyOverlay, setBusyOverlay] = React.useState(false);
  const [rateMode, setRateMode] = React.useState<RateMode>(RATE_MODE.presented);
  const [claimToken, setClaimToken] = React.useState<string>();

  React.useEffect(() => {
    setClaimToken(consumeClaimHandoff(run.id, claimable));
  }, [run.id, claimable]);

  // §22.12 rate toggle. The verdict is server-decided; this only reads it.
  const rateReadiness = renderedRateReadiness(run.renderedFrameAnalysis);
  const serverAnalysis = rateReadiness.kind === "ready" ? rateReadiness.analysis : undefined;

  // Coalescing up to 500k frames is a visible hang, so it happens at most ONCE
  // per loaded capture: lazily (nothing is paid by a reader who never switches)
  // and cached in a ref keyed on the series identity (so the second, third and
  // tenth switch are free). A `useMemo` keyed on the toggle cannot do this —
  // its cache is discarded the moment the toggle flips back, which is exactly
  // when it would need to be kept.
  const renderedCacheRef = React.useRef<{
    source: FrameSeries;
    series: FrameSeries | undefined;
    stutterIndices: Uint32Array | undefined;
  }>(undefined);
  // Whether the control may be offered — server verdict plus loaded frames.
  const toggleReadiness = renderedRateToggleReadiness(rateReadiness, frames.kind === "ready");
  const rateToggleable = toggleReadiness.kind === "ready";
  const wantsRendered = rateToggleable && rateMode === RATE_MODE.rendered;

  // `serverAnalysis` is non-null whenever `wantsRendered` is — both derive from
  // `rateReadiness.kind === "ready"` — but naming it in the guard is what lets
  // the compiler see that, and it documents the dependency besides.
  if (
    wantsRendered &&
    serverAnalysis &&
    frames.kind === "ready" &&
    renderedCacheRef.current?.source !== frames.series
  ) {
    const series = buildRenderedSeries(frames.series);
    renderedCacheRef.current = {
      source: frames.series,
      series,
      // The rendered stream has its own median, hence its own stutter
      // threshold — reusing the presented one would mark the wrong frames.
      stutterIndices: series
        ? findStutterIndices(series.frameTimes, serverAnalysis.summary.frameTimeP50Ms)
        : undefined,
    };
  }
  const cachedRendered =
    frames.kind === "ready" && renderedCacheRef.current?.source === frames.series
      ? renderedCacheRef.current
      : undefined;

  // Rendered mode requires the series to have ACTUALLY built. Every rendered
  // surface reads `renderedAnalysis`/`showRendered`, so a coalesce that yields
  // nothing keeps the whole page on the presented view instead of switching the
  // numbers and leaving the trace behind.
  const renderedSeries = wantsRendered ? cachedRendered?.series : undefined;
  const showRendered = wantsRendered && renderedSeries !== undefined;
  const renderedSeriesFailed = wantsRendered && renderedSeries === undefined;
  const renderedStutterIndices = showRendered ? cachedRendered?.stutterIndices : undefined;
  const renderedAnalysis = showRendered ? serverAnalysis : undefined;

  // What the tiles, bars and chart all read. One source, so they cannot drift
  // into showing a rendered chart under presented numbers.
  const activeSummary = renderedAnalysis ? renderedAnalysis.summary : run.summary;

  // The single line under the toggle, resolved once so the three cases stay
  // mutually exclusive and none of them can go unstated.
  const rateCaption =
    toggleReadiness.kind === "unavailable"
      ? toggleReadiness.reason
      : renderedSeriesFailed
        ? SERIES_UNAVAILABLE_REASON
        : renderedAnalysis
          ? renderedRateCaption(renderedAnalysis)
          : undefined;

  // The manifest verdict, derived once: it gates both the overlay control and
  // whether the busy columns are worth decoding at all.
  const declaredReadiness = busyReadinessFromManifest(run.capabilityManifest);
  const unavailableReason = busyUnavailableReason(
    declaredReadiness,
    frames.kind === "ready" ? frames.series : undefined,
  );
  // Busy time is forced off in rendered mode: `cpuBusyMs`/`gpuBusyMs` are
  // per-present and do not survive coalescing, so drawing them against rendered
  // intervals would be a fabricated trace.
  const busyToggleable =
    unavailableReason === undefined &&
    unit === "ms" &&
    !showRendered &&
    frames.kind === "ready";
  const busyDrawn = busyToggleable && busyOverlay;
  // Why the toggle is off, as text the reader can actually see. The Switch
  // forwards `title` to its visible label for pointer users, but a tooltip alone
  // is still insufficient — the same visible-text rule §8.6.6 applies to the
  // smoothness sample count.
  const busyOffReason =
    unavailableReason ??
    (showRendered ? BUSY_RENDERED_MODE_REASON : undefined) ??
    (unit !== "ms" ? BUSY_UNIT_REASON : undefined);

  // Decode busy columns in the same pass only for a manifest that can expose
  // the overlay. Deferring until the first toggle would require retaining up to
  // a 64 MiB Parquet buffer for the page lifetime or downloading the signed
  // object a second time; two bounded column passes during the existing decode
  // are the cheaper and lower-memory trade-off (§8.6.8).
  const busyDeclared = declaredReadiness.kind === "ready";
  // Same trade-off for the frame-type column: decode it during the existing
  // pass only when the stored analysis says a rendered rate exists, so a run
  // that will never offer the toggle pays nothing.
  const generatedDeclared = rateReadiness.kind === "ready";

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setFrames({ kind: "loading" });
    void loadFrames(run.id, controller.signal, {
      busyColumns: busyDeclared,
      generatedColumn: generatedDeclared,
    })
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
  }, [
    run.id,
    run.status,
    run.summary.frameTimeP50Ms,
    loadFrames,
    busyDeclared,
    generatedDeclared,
    attempt,
  ]);

  return (
    <main id="main-content" tabIndex={-1} className={styles.page}>
      <RunHeader run={run} />
      {claimToken === undefined ? null : (
        <ClaimRunCard
          runId={run.id}
          token={claimToken}
          onConsumed={() => {
            clearClaimHandoff(run.id);
            setClaimToken(undefined);
          }}
        />
      )}
      {/* §22.12 rate toggle. Above the tiles rather than in the chart header,
          which would imply chart-only scope — it switches the tiles, the
          smoothness bars and the trace together. Disabled with a VISIBLE
          reason, the same rule the busy Switch follows. */}
      <div className={styles.rateHeader}>
        <div className={styles.rateSwitch}>
          <span className="heimdall-overline">Rate</span>
          <Segmented
            value={showRendered ? RATE_MODE.rendered : RATE_MODE.presented}
            onChange={(value) => setRateMode(value as RateMode)}
            options={[
              { value: RATE_MODE.presented, label: "Presented" },
              { value: RATE_MODE.rendered, label: "Rendered" },
            ]}
            disabled={!rateToggleable}
            title={toggleReadiness.kind === "unavailable" ? toggleReadiness.reason : undefined}
          />
        </div>
        {/* Exactly one of: why the control is off, why the rendered view could
            not be drawn, or what the rendered numbers mean. Never nothing while
            the control is disabled — that is the §8.6.6 rule. */}
        {rateCaption === undefined ? null : <p style={CAPTION_STYLE}>{rateCaption}</p>}
      </div>
      <RunStatTiles
        summary={activeSummary}
        {...(showRendered && renderedAnalysis
          ? { interpolatedPresents: renderedAnalysis.generatedCount }
          : {})}
      />

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
                    series={renderedSeries ?? frames.series}
                    stutterIndices={renderedStutterIndices ?? frames.stutterIndices}
                    unit={unit}
                    // Drives the good-zone band, so it must be the rate the
                    // trace is actually drawn from.
                    avgFps={activeSummary.avgFps}
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
              {/* Derived from the same three FPS numbers as the tiles, so it
                  switches with them — leaving it on presented values directly
                  beneath a rendered chart is the inconsistency §22.12 is about. */}
              <SmoothnessBars summary={activeSummary} />
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
