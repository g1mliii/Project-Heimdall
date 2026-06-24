import React from 'react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Control size. @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Render with a filled surface + border instead of transparent. */
  solid?: boolean;
  /** Accessible label — required for icon-only controls. */
  'aria-label': string;
}

/** Compact icon-only button for toolbars and dense rows. */
export function IconButton(props: IconButtonProps): JSX.Element;
