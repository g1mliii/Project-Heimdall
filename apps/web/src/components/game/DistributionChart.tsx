"use client";

/**
 * Cohort distribution curve (§17.1) — the visual target is
 * design/ui_kits/web/charts.jsx `BellCurve` and GamePage.jsx: a filled
 * teal→blue→violet area under a hairline curve, with the viewer's run marked on
 * the value axis. Unlike the kit's synthetic gaussian this draws the REAL
 * empirical bins the read model computed, so the shape is the cohort's actual
 * spread, never a decorative bell.
 *
 * SVG (not canvas): a cohort is a few dozen bins, so a scaling `viewBox`
 * polyline is the right tool and stays crisp at any width. Colors come from the
 * brand tokens — no hex literals. `data-chart-state="ready"` flips after mount
 * so the e2e suite can wait for a painted curve.
 */

import * as React from "react";
import type { CohortDistribution } from "@heimdall/shared";

const VIEW_W = 1000;
const PAD_BOTTOM = 20;
const PAD_TOP = 10;

type Distribution = NonNullable<CohortDistribution["distribution"]>;

/** Clamp a value's position to [0, 1] along the min→max axis. */
function axisFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export function DistributionChart({
  distribution,
  viewerValue,
  viewerPercentile,
  formatValue,
  height = 150,
}: {
  distribution: Distribution;
  viewerValue: number | null;
  viewerPercentile: number | null;
  formatValue: (value: number) => string;
  height?: number;
}) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => setReady(true), []);

  const { bins, min, max } = distribution;
  const baseline = height - PAD_BOTTOM;

  // One point per bin centre, anchored on the baseline at both ends so the area
  // closes cleanly even when the extreme bins are non-empty. The polygon and the
  // polyline share this one point string — the closed shape needs no extra
  // vertices, since the anchors already sit on the baseline.
  const points = React.useMemo(() => {
    const maxCount = Math.max(1, ...bins.map((bin) => bin.count));
    const plotHeight = height - PAD_BOTTOM - PAD_TOP;
    const centres = bins.map((bin) => {
      const centre = (bin.lower + bin.upper) / 2;
      const x = axisFraction(centre, min, max) * VIEW_W;
      const y = PAD_TOP + (1 - bin.count / maxCount) * plotHeight;
      return `${x},${y}`;
    });
    return [`0,${baseline}`, ...centres, `${VIEW_W},${baseline}`].join(" ");
  }, [bins, min, max, height, baseline]);

  // Per-instance so two cohorts on one page cannot share a gradient definition.
  const gradientId = React.useId();

  const markerX =
    viewerValue === null ? null : axisFraction(viewerValue, min, max) * VIEW_W;

  return (
    <div data-chart-state={ready ? "ready" : "pending"} style={{ width: "100%" }}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Distribution of ${distribution.sampleCount} comparable runs`}
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" style={{ stopColor: "var(--brand-teal)", stopOpacity: 0.18 }} />
            <stop offset="55%" style={{ stopColor: "var(--brand-blue)", stopOpacity: 0.16 }} />
            <stop offset="100%" style={{ stopColor: "var(--brand-violet)", stopOpacity: 0.18 }} />
          </linearGradient>
        </defs>
        <polygon points={points} fill={`url(#${gradientId})`} />
        <polyline
          points={points}
          fill="none"
          style={{ stroke: "var(--brand-blue)" }}
          strokeWidth={1.6}
        />
        {markerX !== null && (
          <>
            <line
              x1={markerX}
              x2={markerX}
              y1={PAD_TOP}
              y2={baseline}
              style={{ stroke: "var(--brand-teal)" }}
              strokeWidth={2}
            />
            <circle
              cx={markerX}
              cy={PAD_TOP}
              r={4.5}
              style={{ fill: "var(--brand-teal)", stroke: "var(--bg-card)" }}
              strokeWidth={2}
            />
          </>
        )}
      </svg>
      {/* Value axis — DOM so tests and screen readers can read the range. */}
      <div
        data-distribution-axis
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "var(--space-2)",
          padding: "0 var(--space-1)",
          font: "var(--type-overline)",
          letterSpacing: "var(--tracking-wide)",
          color: "var(--fg-4)",
        }}
      >
        <span data-mono>{formatValue(min)}</span>
        {viewerValue !== null && viewerPercentile !== null ? (
          <span data-mono style={{ color: "var(--brand-teal)" }}>
            you · {formatValue(viewerValue)}
          </span>
        ) : (
          <span data-mono>{formatValue((min + max) / 2)}</span>
        )}
        <span data-mono>{formatValue(max)}</span>
      </div>
    </div>
  );
}
