import React from 'react';

/** User avatar — image when `src` is set, otherwise initials. */
export function Avatar({ src, name = '', size = 'md', className = '', ...rest }) {
  const initials = name.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  const cls = ['hd-avatar', size !== 'md' ? `hd-avatar--${size}` : '', className].filter(Boolean).join(' ');
  return (
    <span className={cls} {...rest}>
      {src ? <img src={src} alt={name} /> : (initials || '?')}
    </span>
  );
}
