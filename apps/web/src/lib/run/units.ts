/**
 * Chart unit semantics (§13.1): data stays in milliseconds everywhere; FPS is
 * a display transform (`1000 / ms`) applied at scale time, so the ms/FPS
 * toggle is purely presentational — one code path, no re-derived series.
 */

export type ChartUnit = "ms" | "fps";

export const CHART_UNITS: readonly ChartUnit[] = ["ms", "fps"];

/** Map a frame time into the display unit. */
export function toDisplay(frameTimeMs: number, unit: ChartUnit): number {
  return unit === "fps" ? 1000 / frameTimeMs : frameTimeMs;
}

/**
 * The "good zone" frame-time ceiling shown as a band on the chart: 120 FPS
 * pacing (8.3 ms) for high-refresh captures, 60 FPS pacing (16.7 ms)
 * otherwise. Matches the design kit's 8.3 ms band for its ~145 FPS mock.
 */
export function bandThresholdMs(avgFps: number): number {
  return avgFps >= 100 ? 8.3 : 16.7;
}

/** Y-axis tick label: whole numbers where possible, one decimal below 10. */
export function formatValueTick(value: number): string {
  return Math.abs(value) < 10 && !Number.isInteger(value) ? value.toFixed(1) : String(Math.round(value));
}

/** X-axis tick label: capture time in seconds. */
export function formatTimeTick(timeMs: number): string {
  const seconds = timeMs / 1000;
  const rounded = Math.round(seconds * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
}
