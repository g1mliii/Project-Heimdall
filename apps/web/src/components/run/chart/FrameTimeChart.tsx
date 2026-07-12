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
import { scaleLinear } from "d3-scale";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import type { FrameSeries } from "@/lib/run/frame-series";
import { downsampleMinMax, sliceVisible } from "@/lib/run/downsample";
import { bucketStutterIndices } from "@/lib/run/stutters";
import { bandThresholdMs, formatTimeTick, formatValueTick, toDisplay, type ChartUnit } from "@/lib/run/units";
import { useChartSize } from "./useChartSize";

const PAD = { left: 40, right: 8, top: 8, bottom: 22 } as const;
const DEFAULT_HEIGHT = 260;
const DOT_RADIUS = 3;
/** Zooming stops once ~this many frames fill the plot (raw, exact view). */
const MIN_VISIBLE_FRAMES = 50;
const HEADROOM = 1.05;

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
  const zoomBehaviorRef = React.useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const [transform, setTransform] = React.useState<ZoomTransform>(zoomIdentity);
  const [colors, setColors] = React.useState<ChartColors | null>(null);
  const [ready, setReady] = React.useState(false);

  // Min/max frame time come from the single buildFrameSeries pass — no second scan.
  const yMax =
    unit === "ms"
      ? series.maxFrameTimeMs * HEADROOM
      : (1000 / Math.max(series.minFrameTimeMs, 0.01)) * HEADROOM;

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
    let active = true;
    let zoomFrame: number | null = null;
    let pendingTransform: ZoomTransform | null = null;

    const scheduleTransform = (nextTransform: ZoomTransform): void => {
      // Wheel/pointer events can outpace paint. The chart's min/max binning is
      // proportional to the visible frame count, so keep it to one expensive
      // redraw per display frame rather than one per input event.
      if (!active) return;
      if (typeof requestAnimationFrame !== "function") {
        setTransform(nextTransform);
        return;
      }
      pendingTransform = nextTransform;
      if (zoomFrame !== null) return;
      zoomFrame = requestAnimationFrame(() => {
        zoomFrame = null;
        const transform = pendingTransform;
        pendingTransform = null;
        if (active && transform) setTransform(transform);
      });
    };

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
      .on("zoom", (event: { transform: ZoomTransform }) => scheduleTransform(event.transform));
    const selection = select(overlay);
    zoomBehaviorRef.current = behavior;
    selection.call(behavior);
    return () => {
      active = false;
      if (zoomFrame !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(zoomFrame);
      }
      zoomFrame = null;
      pendingTransform = null;
      if (zoomBehaviorRef.current === behavior) zoomBehaviorRef.current = null;
      selection.on(".zoom", null);
    };
  }, [hasPlot, series.count, plotRight, plotBottom, height]);

  function handleChartKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const overlay = overlayRef.current;
    const behavior = zoomBehaviorRef.current;
    if (!overlay || !behavior) return;

    const selection = select(overlay);
    const panDistance = Math.max(1, (plotRight - PAD.left) * 0.1);
    switch (event.key) {
      case "ArrowLeft":
        behavior.translateBy(selection, panDistance, 0);
        break;
      case "ArrowRight":
        behavior.translateBy(selection, -panDistance, 0);
        break;
      case "+":
      case "=":
        behavior.scaleBy(selection, 1.25);
        break;
      case "-":
      case "_":
        behavior.scaleBy(selection, 0.8);
        break;
      case "Home":
        behavior.transform(selection, zoomIdentity);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

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
    const backingWidth = Math.round(width * dpr);
    const backingHeight = Math.round(height * dpr);
    if (canvas.width !== backingWidth) canvas.width = backingWidth;
    if (canvas.height !== backingHeight) canvas.height = backingHeight;
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
        role="region"
        aria-label="Frame-time chart controls. Use the mouse wheel or plus and minus keys to zoom, left and right arrow keys to pan, or Home to reset."
        tabIndex={0}
        onKeyDown={handleChartKeyDown}
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
