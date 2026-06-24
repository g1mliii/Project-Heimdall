import React from 'react';

/** Toggle switch. Controlled via `checked` + `onChange`. */
export function Switch({ checked, onChange, label, id, disabled = false, className = '', ...rest }) {
  const swId = id || `hd-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <label className={['hd-switch', className].filter(Boolean).join(' ')} htmlFor={swId}>
      <input id={swId} type="checkbox" role="switch" checked={checked} onChange={onChange} disabled={disabled} {...rest} />
      <span className="hd-switch__track"><span className="hd-switch__thumb" /></span>
      {label && <span className="hd-switch__label">{label}</span>}
    </label>
  );
}
