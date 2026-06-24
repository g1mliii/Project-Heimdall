import React from 'react';

/** Hover/focus tooltip. Wraps its trigger children. */
export function Tooltip({ content, className = '', children, ...rest }) {
  return (
    <span className={['hd-tooltip', className].filter(Boolean).join(' ')} tabIndex={0} {...rest}>
      {children}
      <span className="hd-tooltip__pop" role="tooltip">{content}</span>
    </span>
  );
}
