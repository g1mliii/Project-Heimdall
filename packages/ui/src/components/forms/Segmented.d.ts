import React from 'react';

export interface SegmentedOption { value: string; label: React.ReactNode; icon?: React.ReactNode; }

export interface SegmentedProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Options as strings or {value,label,icon}. */
  options: (string | SegmentedOption)[];
  /** Currently selected value. */
  value: string;
  /** Called with the new value. */
  onChange?: (value: string) => void;
}

/** Compact segmented toggle for view modes (chart type, time window). */
export function Segmented(props: SegmentedProps): JSX.Element;
