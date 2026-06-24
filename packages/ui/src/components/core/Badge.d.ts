import React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic tone. @default "neutral" */
  tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'brand' | 'solid';
  /** Show a leading status dot. */
  dot?: boolean;
}

/** Compact uppercase status label (run status, smoothness verdict, etc.). */
export function Badge(props: BadgeProps): JSX.Element;
