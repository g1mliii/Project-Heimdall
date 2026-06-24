import React from 'react';

/** Segmented control — 2–4 mutually exclusive options. Controlled via `value`. */
export function Segmented({ options = [], value, onChange, className = '', ...rest }) {
  return (
    <div className={['hd-segmented', className].filter(Boolean).join(' ')} role="group" {...rest}>
      {options.map((o) => {
        const v = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        const icon = typeof o === 'string' ? null : o.icon;
        return (
          <button
            key={v}
            type="button"
            className="hd-segmented__opt"
            aria-pressed={value === v}
            onClick={() => onChange && onChange(v)}
          >
            {icon}{label}
          </button>
        );
      })}
    </div>
  );
}
