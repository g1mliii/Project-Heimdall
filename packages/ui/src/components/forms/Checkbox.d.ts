import React from 'react';

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Controlled checked state. */
  checked?: boolean;
  /** Change handler. */
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  /** Inline trailing label. */
  label?: React.ReactNode;
}

/** Checkbox for multi-select filters and consent toggles. */
export function Checkbox(props: CheckboxProps): JSX.Element;
