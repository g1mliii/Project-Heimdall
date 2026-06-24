import React from 'react';

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
  deltaDir?: 'up' | 'down';
  /** Optional accent bar color on top (use a tier token). */
  accent?: string;
}

/**
 * Big-number metric tile for run summaries and dashboards.
 */
export function Stat(props: StatProps): JSX.Element;
