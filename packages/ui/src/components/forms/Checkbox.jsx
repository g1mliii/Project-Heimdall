import React from 'react';

/** Checkbox with inline label. */
export function Checkbox({ checked, onChange, label, id, disabled = false, className = '', ...rest }) {
  const cbId = id || `hd-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <label className={['hd-check', className].filter(Boolean).join(' ')} htmlFor={cbId}>
      <input id={cbId} type="checkbox" checked={checked} onChange={onChange} disabled={disabled} {...rest} />
      <span className="hd-check__box" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
      </span>
      {label && <span>{label}</span>}
    </label>
  );
}
