import React from 'react';

export interface SelectOption { value: string; label: string; }

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Field label. */
  label?: React.ReactNode;
  /** Helper text below the control. */
  hint?: React.ReactNode;
  /** Options as strings or {value,label}. Ignored if children are passed. */
  options?: (string | SelectOption)[];
}

/** Styled native select for hardware/game/resolution filters. */
export function Select(props: SelectProps): JSX.Element;
