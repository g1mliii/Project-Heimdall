import type * as React from "react";

/**
 * Props for the big-number metric tile.
 *
 * @startingPoint section="Data" subtitle="Big-number metric tile" viewport="700x200"
 */
export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Uppercase overline label (e.g. "AVG FPS"). */
  label: React.ReactNode;
  /** The numeric value (rendered in tabular mono). */
  value: React.ReactNode;
  /** Optional unit suffix (e.g. "fps", "ms"). */
  unit?: React.ReactNode;
  /** Delta text (e.g. "+14%"). */
  delta?: React.ReactNode;
  /** Direction of the delta arrow + color. @default "up" */
  deltaDir?: "up" | "down";
  /** Optional accent bar color on top (use a tier token). */
  accent?: string;
}

/** Big-number metric tile for run summaries and dashboards. */
export function Stat({ label, value, unit, delta, deltaDir, accent, className = "", ...rest }: StatProps) {
  return (
    <div className={["hd-stat", className].filter(Boolean).join(" ")} {...rest}>
      {accent && <div className="hd-stat__accent" style={{ background: accent }} />}
      <span className="hd-stat__label">{label}</span>
      <span className="hd-stat__value">
        {value}
        {unit && <span className="hd-stat__unit">{unit}</span>}
      </span>
      {delta != null && (
        <span className={`hd-stat__delta hd-stat__delta--${deltaDir === "down" ? "down" : "up"}`}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {deltaDir === "down" ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
          </svg>
          {delta}
        </span>
      )}
    </div>
  );
}
