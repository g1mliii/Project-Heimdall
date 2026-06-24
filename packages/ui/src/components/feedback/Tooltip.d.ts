import React from 'react';

export interface TooltipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Tooltip body shown above the trigger on hover/focus. */
  content: React.ReactNode;
}

/** Lightweight hover/focus tooltip for metric definitions and icon affordances. */
export function Tooltip(props: TooltipProps): JSX.Element;
