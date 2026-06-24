import React from 'react';

export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** When provided, renders a dismiss affordance and calls this on remove. */
  onRemove?: (e: React.SyntheticEvent) => void;
}

/** Dismissible chip for active filters and applied settings. */
export function Tag(props: TagProps): JSX.Element;
