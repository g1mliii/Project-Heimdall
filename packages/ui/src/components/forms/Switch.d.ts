import React from 'react';

export interface SwitchProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Controlled checked state. */
  checked?: boolean;
  /** Change handler. */
  onChange?: React.ChangeEventHandler<HTMLInputElement>;
  /** Inline trailing label. */
  label?: React.ReactNode;
}

/** Binary toggle — e.g. "Verified only" vs "All submissions". */
export function Switch(props: SwitchProps): JSX.Element;
