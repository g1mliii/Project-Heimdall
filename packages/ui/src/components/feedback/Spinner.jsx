import React from 'react';

/** Indeterminate loading spinner. */
export function Spinner({ size = 18, label, className = '', ...rest }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }} {...rest}>
      <span
        className={['hd-spinner', className].filter(Boolean).join(' ')}
        style={{ width: size, height: size }}
        role="status"
        aria-label={label || 'Loading'}
      />
      {label && <span style={{ font: 'var(--type-body-sm)', color: 'var(--fg-3)' }}>{label}</span>}
    </span>
  );
}
