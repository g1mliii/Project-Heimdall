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

export function FrameTimeChart({ samples, height = 86 }: FrameTimeChartProps) {
  const points = samples.length;
  // Clamp the domain so one 400 ms hitch does not flatten the whole trace into
  // a line at the bottom of the strip.
  const peak = Math.max(1, Math.min(Math.max(...samples, 1), 60));
  const path =
    points < 2
      ? ""
      : samples
          .map((value, index) => {
            const x = (index / (points - 1)) * VIEW_WIDTH;
            const y = height - Math.min(value, peak) / peak * height;
            return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
          })
          .join(" ");

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
