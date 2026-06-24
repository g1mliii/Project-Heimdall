import React from 'react';

/** Native select with the Heimdall chevron + surface styling. */
export function Select({ label, hint, options = [], id, className = '', children, ...rest }) {
  const selId = id || (label ? `hd-${Math.random().toString(36).slice(2, 8)}` : undefined);
  return (
    <div className={['hd-field', className].filter(Boolean).join(' ')}>
      {label && <label className="hd-field__label" htmlFor={selId}>{label}</label>}
      <span className="hd-select">
        <select id={selId} {...rest}>
          {children || options.map((o) => {
            const value = typeof o === 'string' ? o : o.value;
            const text = typeof o === 'string' ? o : o.label;
            return <option key={value} value={value}>{text}</option>;
          })}
        </select>
        <span className="hd-select__chev" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
      </span>
      {hint && <span className="hd-field__hint">{hint}</span>}
    </div>
  );
}
