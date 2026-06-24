import React from 'react';

/** Text input with optional label, hint/error, and leading icon. */
export function Input({
  label, hint, error, icon, mono = false, id,
  className = '', wrapClassName = '', ...rest
}) {
  const inputId = id || (label ? `hd-${Math.random().toString(36).slice(2, 8)}` : undefined);
  const input = (
    <input
      id={inputId}
      className={['hd-input', mono ? 'hd-input--mono' : '', error ? 'hd-input--error' : '', className].filter(Boolean).join(' ')}
      aria-invalid={error ? true : undefined}
      {...rest}
    />
  );
  return (
    <div className={['hd-field', wrapClassName].filter(Boolean).join(' ')}>
      {label && <label className="hd-field__label" htmlFor={inputId}>{label}</label>}
      {icon ? (
        <span className="hd-input__wrap">
          <span className="hd-input__icon">{icon}</span>
          {input}
        </span>
      ) : input}
      {(error || hint) && (
        <span className={`hd-field__hint${error ? ' hd-field__hint--error' : ''}`}>{error || hint}</span>
      )}
    </div>
  );
}
