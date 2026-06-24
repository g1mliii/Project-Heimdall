import React from 'react';

export interface MeterProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Uppercase overline label. */
  label?: React.ReactNode;
  /** Current value. */
  value?: number;
  /** Maximum value. @default 100 */
  max?: number;
  /** Formatted value text shown on the right (e.g. "92%", "11.4 GB"). */
  display?: React.ReactNode;
  /** Fill color (CSS value) — use a semantic/tier token. @default teal */
  color?: string;
}

/** Horizontal utilization/progress meter for GPU load, VRAM, upload progress. */
export function Meter(props: MeterProps): JSX.Element;
