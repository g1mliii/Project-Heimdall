import React from 'react';

/** Labeled progress / utilization meter (VRAM, GPU load, percentile fill). */
export function Meter({ label, value = 0, max = 100, display, color = 'var(--brand-teal)', className = '', ...rest }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={['hd-meter', className].filter(Boolean).join(' ')} {...rest}>
      {(label || display) && (
        <div className="hd-meter__head">
          {label && <span className="hd-meter__label">{label}</span>}
          {display && <span className="hd-meter__value">{display}</span>}
        </div>
      )}
      <div className="hd-meter__track" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
        <div className="hd-meter__fill" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
