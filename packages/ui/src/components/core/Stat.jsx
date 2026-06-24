import React from 'react';

/** Big-number metric tile. The numeric value always renders in the mono face. */
export function Stat({ label, value, unit, delta, deltaDir, accent, className = '', ...rest }) {
  return (
    <div className={['hd-stat', className].filter(Boolean).join(' ')} {...rest}>
      {accent && <div className="hd-stat__accent" style={{ background: accent }} />}
      <span className="hd-stat__label">{label}</span>
      <span className="hd-stat__value">
        {value}{unit && <span className="hd-stat__unit">{unit}</span>}
      </span>
      {delta != null && (
        <span className={`hd-stat__delta hd-stat__delta--${deltaDir === 'down' ? 'down' : 'up'}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            {deltaDir === 'down' ? <path d="m6 9 6 6 6-6"/> : <path d="m6 15 6-6 6 6"/>}
          </svg>
          {delta}
        </span>
      )}
    </div>
  );
}
