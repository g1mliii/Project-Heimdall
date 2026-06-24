import React from 'react';

/** Small status label. Use semantic tones to carry meaning, not decoration. */
export function Badge({ tone = 'neutral', dot = false, className = '', children, ...rest }) {
  const cls = ['hd-badge', `hd-badge--${tone}`, className].filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      {dot && <span className="hd-badge__dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
