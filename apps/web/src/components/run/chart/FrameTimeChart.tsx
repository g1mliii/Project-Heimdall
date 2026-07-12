"use client";

/**
 * Frame-time progression chart (§13.1): canvas trace + DOM chrome, D3 for
 * math only. React owns every element; d3-zoom is the single DOM handoff
 * (attached to a transparent overlay, its transform mirrored into state).
 *
 * - Trace + good-zone band + stutter dots draw on canvas (a 500k-frame run
 *   can't be an SVG polyline); gridline labels are DOM so tests can read
 *   them. Points are min/max-binned per pixel (lib/run/downsample), so
 *   spikes always survive; stutter dots come from the precomputed index
 *   list, never from resampled data.
 * - Canvas colors resolve from the design tokens at mount via
 *   getComputedStyle — no hex literals, theme stays in @heimdall/ui.
 * - The ms/FPS toggle is presentational: values transform at scale time.
 * - Per-frame generated shading is deferred (mixes badly with min/max
 *   binning); the run-level share lives in the header badge + stat tile.
 * - jsdom guards: zero width → no plot; getContext may return null.
 *
 * `data-chart-state="ready"` flips after the first real paint — the e2e
 * suite waits on it before screenshotting.
 */

import * as React from "react";
import { bisectLeft } from "d3-array";
import { scaleLinear } from "d3-scale";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import type { FrameSeries } from "@/lib/run/frame-series";
import { downsampleMinMax, sliceVisible } from "@/lib/run/downsample";
import { bandThresholdMs, formatTimeTick, formatValueTick, toDisplay, type ChartUnit } from "@/lib/run/units";
import { useChartSize } from "./useChartSize";

const PAD = { left: 40, right: 8, top: 8, bottom: 22 } as const;
const DEFAULT_HEIGHT = 260;
const DOT_RADIUS = 3;
/** Zooming stops once ~this many frames fill the plot (raw, exact view). */
const MIN_VISIBLE_FRAMES = 50;
const HEADROOM = 1.05;

/**
 * Sample visible stutters into horizontal screen buckets. This bounds marker
 * selection and drawing to chart width even for hostile captures.
 */
export function bucketStutterIndices(
  stutterIndices: Uint32Array,
  times: Float64Array,
  start: number,
  end: number,
  domainStart: number,
  domainEnd: number,
  bucketCount: number,
): Int32Array {
  const markers = new Int32Array(Math.max(1, bucketCount)).fill(-1);
  const span = domainEnd - domainStart;
  if (span <= 0) return markers;

  const first = bisectLeft(stutterIndices, start);
  const last = bisectLeft(stutterIndices, end);
  const sampleCount = Math.min(markers.length, last - first);
  for (let sample = 0; sample < sampleCount; sample++) {
    const cursor =
      sampleCount === 1
        ? first
        : first + Math.floor((sample * (last - first - 1)) / (sampleCount - 1));
    const index = stutterIndices[cursor]!;
    const bucket = Math.min(
      markers.length - 1,
      Math.max(0, Math.floor(((times[index]! - domainStart) / span) * markers.length)),
    );
    if (markers[bucket]! < 0) markers[bucket] = index;
  }
  return markers;
}

interface ChartColors {
  trace: string;
  stutter: string;
  band: string;
  grid: string;
  halo: string;
}

function resolveColors(element: HTMLElement): ChartColors {
  const styles = getComputedStyle(element);
  // Fall back to a VALID canvas color per role — "currentColor" is not a legal
  // fillStyle/strokeStyle and the 2D context silently ignores it, leaving the
  // trace/dots black (invisible on the dark canvas). These literals only apply
  // if a --chart-* token ever fails to resolve.
  const token = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    trace: token("--chart-frametime", "turquoise"),
    stutter: token("--chart-stutter", "red"),
    band: token("--chart-band", "rgba(255, 255, 255, 0.03)"),
    grid: token("--chart-grid", "rgba(255, 255, 255, 0.06)"),
    halo: token("--bg-card", "black"),
  };
}

export function FrameTimeChart({
  series,
  stutterIndices,
  unit,
  avgFps,
  height = DEFAULT_HEIGHT,
}: {
  series: FrameSeries;
  stutterIndices: Uint32Array;
  unit: ChartUnit;
  avgFps: number;
  height?: number;
}) {
  const [containerRef, width] = useChartSize<HTMLDivElement>();
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const [transform, setTransform] = React.useState<ZoomTransform>(zoomIdentity);
  const [colors, setColors] = React.useState<ChartColors | null>(null);
  const [ready, setReady] = React.useState(false);

  const { minFrameTimeMs, maxFrameTimeMs } = React.useMemo(() => {
    let min = Infinity;
    let max = 0;
    for (const value of series.frameTimes) {
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return { minFrameTimeMs: min, maxFrameTimeMs: max };
  }, [series]);

  const yMax =
    unit === "ms" ? maxFrameTimeMs * HEADROOM : (1000 / Math.max(minFrameTimeMs, 0.01)) * HEADROOM;

  // Scales are pure functions of state — computed in render so tick labels
  // and the canvas paint from the exact same math.
  const plotRight = width - PAD.right;
  const plotBottom = height - PAD.bottom;
  const xBase = scaleLinear().domain([0, series.totalDurationMs]).range([PAD.left, plotRight]);
  const xScale = transform.rescaleX(xBase);
  const yScale = scaleLinear().domain([0, yMax]).range([plotBottom, PAD.top]);
  const hasPlot = width > PAD.left + PAD.right && series.count > 0;
  const xTicks = hasPlot ? xScale.ticks(6) : [];
  const yTicks = hasPlot ? yScale.ticks(4) : [];

  React.useEffect(() => {
    if (containerRef.current) setColors(resolveColors(containerRef.current));
  }, [containerRef]);

  // d3-zoom: the one place D3 touches the DOM.
  React.useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !hasPlot) return;
    const behavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent([1, Math.max(1, series.count / MIN_VISIBLE_FRAMES)])
      .extent([
        [PAD.left, PAD.top],
        [plotRight, plotBottom],
      ])
      .translateExtent([
        [PAD.left, 0],
        [plotRight, height],
      ])
      .on("zoom", (event: { transform: ZoomTransform }) => setTransform(event.transform));
    const selection = select(overlay);
    selection.call(behavior);
    return () => {
      selection.on(".zoom", null);
    };
  }, [hasPlot, series.count, plotRight, plotBottom, height]);

  // Canvas paint. Deliberately no dependency array: it must repaint after
  // every committed render (transform/unit/size/series all feed the scales,
  // and tick arrays are new each render). setReady(true) is idempotent, so
  // this cannot loop.
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasPlot || !colors) return;
    const context = canvas.getContext("2d");
    if (!context) return; // jsdom

    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    // Gridlines under everything.
    context.strokeStyle = colors.grid;
    context.lineWidth = 1;
    for (const tick of yTicks) {
      if (tick === 0) continue;
      const y = yScale(tick);
      context.beginPath();
      context.moveTo(PAD.left, y);
      context.lineTo(plotRight, y);
      context.stroke();
    }

    context.save();
    context.beginPath();
    context.rect(PAD.left, PAD.top, plotRight - PAD.left, plotBottom - PAD.top);
    context.clip();

    // Good-zone band: frame times below the threshold (ms) — equivalently
    // FPS above 1000/threshold.
    const thresholdMs = bandThresholdMs(avgFps);
    context.fillStyle = colors.band;
    if (unit === "ms") {
      const top = Math.max(yScale(thresholdMs), PAD.top);
      context.fillRect(PAD.left, top, plotRight - PAD.left, plotBottom - top);
    } else {
      const bottom = Math.min(yScale(1000 / thresholdMs), plotBottom);
      context.fillRect(PAD.left, PAD.top, plotRight - PAD.left, bottom - PAD.top);
    }

    // Visible window (pad one sample each side so the line runs off-plot).
    const domain = xScale.domain();
    const range = sliceVisible(series.times, domain[0]!, domain[1]!);
    const start = Math.max(0, range.start - 1);
    const end = Math.min(series.count, range.end + 1);
    const buckets = Math.max(1, Math.ceil(plotRight - PAD.left));
    const points = downsampleMinMax(series.times, series.frameTimes, start, end, buckets);

    context.strokeStyle = colors.trace;
    context.lineWidth = 1.6;
    context.lineJoin = "round";
    context.beginPath();
    for (let i = 0; i < points.x.length; i++) {
      const px = xScale(points.x[i]!);
      const py = yScale(toDisplay(points.y[i]!, unit));
      if (i === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.stroke();

    // Keep representative stutters to one per horizontal pixel. The trace
    // retains the actual spikes without letting dense markers monopolize paint.
    const markers = bucketStutterIndices(
      stutterIndices,
      series.times,
      range.start,
      range.end,
      domain[0]!,
      domain[1]!,
      buckets,
    );
    context.fillStyle = colors.stutter;
    context.strokeStyle = colors.halo;
    context.lineWidth = 2;
    for (const index of markers) {
      if (index < 0) continue;
      const t = series.times[index]!;
      const px = xScale(t);
      const py = yScale(toDisplay(series.frameTimes[index]!, unit));
      context.beginPath();
      context.arc(px, py, DOT_RADIUS, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }

    context.restore();
    setReady(true);
  });

  return (
    <div
      ref={containerRef}
      data-chart-state={ready ? "ready" : "pending"}
      style={{ position: "relative", width: "100%", height }}
    >
      <canvas
        ref={canvasRef}
        aria-label="Frame-time progression chart"
        role="img"
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
      />
      {/* Axis tick labels — DOM so tests (and screen readers) can see them. */}
      {yTicks.map((tick) => (
        <span
          key={`y-${tick}`}
          data-axis="y"
          data-mono
          style={{
            position: "absolute",
            left: 0,
            top: yScale(tick),
            width: PAD.left - 6,
            transform: "translateY(-50%)",
            textAlign: "right",
            font: "var(--type-overline)",
            color: "var(--chart-axis)",
          }}
        >
          {formatValueTick(tick)}
        </span>
      ))}
      {xTicks.map((tick) => (
        <span
          key={`x-${tick}`}
          data-axis="x"
          data-mono
          style={{
            position: "absolute",
            left: xScale(tick),
            top: plotBottom + 4,
            transform: "translateX(-50%)",
            font: "var(--type-overline)",
            color: "var(--chart-axis)",
          }}
        >
          {formatTimeTick(tick)}
        </span>
      ))}
      {/* Zoom/pan surface — owns pointer events; d3-zoom is attached here. */}
      <div
        ref={overlayRef}
        data-chart-overlay
        aria-hidden="true"
        style={{
          position: "absolute",
          left: PAD.left,
          top: PAD.top,
          width: Math.max(0, plotRight - PAD.left),
          height: Math.max(0, plotBottom - PAD.top),
          touchAction: "none",
          cursor: "grab",
        }}
      />
    </div>
  );
}
