/**
 * Live frame-time sparkline for the capturing screen (§22.4).
 *
 * Hand-rolled SVG rather than the hub's D3 chart: this draws one scrolling
 * series in an 86px strip with no axes, tooltips or zoom, and pulling the D3
 * scale/selection/zoom stack into the desktop bundle to do it would be three
 * dependencies for a polyline.
 *
 * It is a readout, not analysis — see lib/live-frames.ts.
 */

interface FrameTimeChartProps {
  /** Frame times in milliseconds, oldest first. */
  samples: readonly number[];
  height?: number;
}

const VIEW_WIDTH = 360;

/** One decimal, without `toFixed`'s string formatting on every coordinate. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function FrameTimeChart({ samples, height = 86 }: FrameTimeChartProps) {
  const points = samples.length;
  // Clamp the domain so one 400 ms hitch does not flatten the whole trace into
  // a line at the bottom of the strip.
  //
  // A plain loop rather than `Math.max(...samples)`: the window holds 600
  // points, and spreading it is both an allocation and an argument list a few
  // engines cap.
  let tallest = 1;
  for (const value of samples) {
    if (value > tallest) tallest = value;
  }
  const peak = Math.min(tallest, 60);
  // Built by appending to one string instead of map + join, which allocates an
  // intermediate array and a string per point on every redraw.
  let path = "";
  if (points >= 2) {
    for (let index = 0; index < points; index += 1) {
      const x = (index / (points - 1)) * VIEW_WIDTH;
      const y = height - (Math.min(samples[index]!, peak) / peak) * height;
      path += `${index === 0 ? "M" : "L"}${round1(x)} ${round1(y)}`;
    }
  }

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height, display: "block" }}
      role="img"
      aria-label={
        points === 0
          ? "Waiting for frames"
          : `Live frame times, ${points} recent frames, peak ${peak.toFixed(1)} ms`
      }
    >
      {path === "" ? null : (
        <path
          d={path}
          fill="none"
          stroke="var(--tier-avg)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
