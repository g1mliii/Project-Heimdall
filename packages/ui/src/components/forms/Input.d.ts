import React from 'react';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Field label rendered above the control. */
  label?: React.ReactNode;
  /** Helper text below the field. */
  hint?: React.ReactNode;
  /** Error message — overrides hint and applies the error style. */
  error?: React.ReactNode;
  /** Leading icon node. */
  icon?: React.ReactNode;
  /** Render the value in the mono face (for IDs, tokens, numbers). */
  mono?: boolean;
  /** Extra class on the wrapping field. */
  wrapClassName?: string;
}

/** Single-line text field with label, hint/error, and optional leading icon. */
export function Input(props: InputProps): JSX.Element;
