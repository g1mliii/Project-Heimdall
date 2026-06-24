import React from 'react';

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Diameter in px. @default 18 */
  size?: number;
  /** Optional trailing label text. */
  label?: React.ReactNode;
}

/** Indeterminate loading spinner for parse/upload/processing states. */
export function Spinner(props: SpinnerProps): JSX.Element;
