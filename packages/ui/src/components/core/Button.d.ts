import React from 'react';

/**
 * Props for the primary call-to-action button.
 *
 * @startingPoint section="Core" subtitle="Buttons in every variant & size" viewport="700x200"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. @default "primary" */
  variant?: 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger';
  /** Control height. @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Stretch to fill the container width. */
  block?: boolean;
  /** Show a spinner and disable interaction. */
  loading?: boolean;
  /** Leading icon node (e.g. a Lucide <i> or inline SVG). */
  iconLeft?: React.ReactNode;
  /** Trailing icon node. */
  iconRight?: React.ReactNode;
}

/**
 * The primary call-to-action button for Heimdall surfaces.
 */
export function Button(props: ButtonProps): JSX.Element;
