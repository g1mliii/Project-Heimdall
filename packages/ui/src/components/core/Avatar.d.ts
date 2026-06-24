import React from 'react';

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Image URL; falls back to initials when absent. */
  src?: string;
  /** Full name — used for initials and img alt. */
  name?: string;
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
}

/** Circular user avatar (image or initials) for reviewer attribution. */
export function Avatar(props: AvatarProps): JSX.Element;
