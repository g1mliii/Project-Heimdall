import React from 'react';

/** Underlined tab bar. Controlled via `value` + `onChange`. */
export function Tabs({ tabs = [], value, onChange, className = '', ...rest }) {
  return (
    <div className={['hd-tabs', className].filter(Boolean).join(' ')} role="tablist" {...rest}>
      {tabs.map((t) => {
        const v = typeof t === 'string' ? t : t.value;
        const label = typeof t === 'string' ? t : t.label;
        const icon = typeof t === 'string' ? null : t.icon;
        const active = value === v;
        return (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={active}
            className={`hd-tab${active ? ' hd-tab--active' : ''}`}
            onClick={() => onChange && onChange(v)}
          >
            {icon}{label}
          </button>
        );
      })}
    </div>
  );
}
