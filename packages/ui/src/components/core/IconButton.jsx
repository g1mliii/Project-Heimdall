import React from 'react';

/** Square icon-only button. Always pass an accessible `aria-label`. */
export function IconButton({
  size = 'md',
  solid = false,
  disabled = false,
  className = '',
  children,
  ...rest
}) {
  const cls = [
    'hd-iconbtn',
    size !== 'md' ? `hd-iconbtn--${size}` : '',
    solid ? 'hd-iconbtn--solid' : '',
    className,
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
