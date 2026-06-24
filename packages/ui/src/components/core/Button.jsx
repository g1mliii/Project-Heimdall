import React from 'react';

/**
 * Heimdall primary action button. Thin wrapper over the .hd-btn classes.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  block = false,
  loading = false,
  disabled = false,
  iconLeft = null,
  iconRight = null,
  type = 'button',
  className = '',
  children,
  ...rest
}) {
  const cls = [
    'hd-btn',
    `hd-btn--${variant}`,
    size !== 'md' ? `hd-btn--${size}` : '',
    block ? 'hd-btn--block' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button type={type} className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <span className="hd-spinner" aria-hidden="true" /> : iconLeft}
      {children != null && <span>{children}</span>}
      {!loading && iconRight}
    </button>
  );
}
