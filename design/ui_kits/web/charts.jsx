// Heimdall UI kit — chart primitives (cosmetic recreations of the D3 views).
// Pure inline-SVG, styled with the design tokens. No real D3 — these mirror
// the visual language of the production charts for the kit.

const { useMemo } = React;

// Deterministic pseudo-random so the kit looks identical every render.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

// Generate a realistic frame-time trace (ms) with occasional stutters.
function genFrames(seed = 7, n = 220, base = 6.9) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    let v = base + (r() - 0.5) * 1.4;
    if (r() > 0.965) v += 6 + r() * 12;          // stutter spike
    if (i > 70 && i < 95) v += 1.6;               // a rough patch
    out.push(Math.max(3.2, v));
  }
  return out;
}

// ── Frame-time progression plot ────────────────────────────────────────
function FrameTimeChart({ seed = 7, height = 240, stutterThreshold = 12, fill = true, showStutters = true }) {
  const data = useMemo(() => genFrames(seed), [seed]);
  const W = 1000, H = height, padB = 22, padL = 4;
  const max = Math.max(...data, 20);
  const stepX = (W - padL) / (data.length - 1);
  const y = (v) => H - padB - (v / max) * (H - padB - 8);
  const pts = data.map((v, i) => `${padL + i * stepX},${y(v)}`).join(' ');
  const area = `${padL},${H - padB} ${pts} ${padL + (data.length - 1) * stepX},${H - padB}`;
  const stutters = data.map((v, i) => ({ v, i })).filter((d) => d.v >= stutterThreshold);
  const grid = [0.25, 0.5, 0.75, 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="ftFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2ee6c6" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#2ee6c6" stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid.map((g, i) => (
        <line key={i} x1={padL} x2={W} y1={(H - padB) * g} y2={(H - padB) * g} stroke="var(--chart-grid)" strokeWidth="1" />
      ))}
      {/* target band (good zone, < 8.3ms ≈ 120fps) */}
      <rect x={padL} y={y(8.3)} width={W - padL} height={(H - padB) - y(8.3)} fill="var(--chart-band)" />
      {fill && <polygon points={area} fill="url(#ftFill)" />}
      <polyline points={pts} fill="none" stroke="var(--chart-frametime)" strokeWidth="1.6" strokeLinejoin="round" />
      {showStutters && stutters.map((d, i) => (
        <circle key={i} cx={padL + d.i * stepX} cy={y(d.v)} r="3.2" fill="var(--chart-stutter)" stroke="var(--bg-card)" strokeWidth="1.5" />
      ))}
    </svg>
  );
}

// ── Smoothness tier bars (Avg / 1% / 0.1%) ─────────────────────────────
function SmoothnessBars({ avg = 144, p1 = 98, p01 = 71, max = 160, confidence = 'low' }) {
  const rows = [
    { label: 'Avg FPS', v: avg, color: 'var(--tier-avg)' },
    { label: '1% Low', v: p1, color: 'var(--tier-p1)' },
    { label: '0.1% Low', v: p01, color: 'var(--tier-p01)', conf: confidence },
  ];
  const confTone = { low: 'var(--warn)', medium: 'var(--info)', high: 'var(--good)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: 'grid', gridTemplateColumns: '78px 1fr 56px', alignItems: 'center', gap: '12px' }}>
          <span className="hd-meter__label" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
            {r.label}
            {r.conf && (
              <span title={`Confidence: ${r.conf} — short captures sample only a handful of worst frames`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', font: 'var(--type-overline)', color: confTone[r.conf], textTransform: 'uppercase', letterSpacing: '0.06em', border: `1px solid ${confTone[r.conf]}`, borderRadius: 2, padding: '0 4px', height: 14, opacity: 0.9 }}>
                <span style={{ width: 4, height: 4, borderRadius: 999, background: 'currentColor' }} />{r.conf}
              </span>
            )}
          </span>
          <div style={{ height: '14px', background: 'var(--bg-inset)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
            <div style={{ width: `${(r.v / max) * 100}%`, height: '100%', background: r.color, borderRadius: 'var(--radius-pill)' }} />
          </div>
          <span data-mono style={{ font: 'var(--type-data)', color: 'var(--fg-1)', textAlign: 'right' }}>{r.v}</span>
        </div>
      ))}
    </div>
  );
}

// ── Bell-curve distribution (where this run sits in the crowd) ─────────
function BellCurve({ markerPct = 0.72, height = 150 }) {
  const W = 1000, H = height, padB = 20;
  const curve = [];
  for (let i = 0; i <= 100; i++) {
    const x = i / 100;
    const g = Math.exp(-Math.pow((x - 0.5) * 3.2, 2));     // gaussian
    curve.push([x * W, H - padB - g * (H - padB - 10)]);
  }
  const line = curve.map((p) => p.join(',')).join(' ');
  const area = `0,${H - padB} ${line} ${W},${H - padB}`;
  const mx = markerPct * W;
  const myG = Math.exp(-Math.pow((markerPct - 0.5) * 3.2, 2));
  const my = H - padB - myG * (H - padB - 10);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="bellFill" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#2ee6c6" stopOpacity="0.18" />
          <stop offset="55%" stopColor="#4d9fff" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#8b7bff" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#bellFill)" />
      <polyline points={line} fill="none" stroke="var(--brand-blue)" strokeWidth="1.6" />
      <line x1={mx} x2={mx} y1={my - 6} y2={H - padB} stroke="var(--brand-teal)" strokeWidth="2" />
      <circle cx={mx} cy={my - 6} r="4.5" fill="var(--brand-teal)" stroke="var(--bg-card)" strokeWidth="2" />
    </svg>
  );
}

Object.assign(window, { FrameTimeChart, SmoothnessBars, BellCurve, genFrames });

// ── Dual frame-time overlay (Before vs After) ──────────────────────────
function DualFrameTimeChart({ seedA = 21, seedB = 7, baseA = 8.6, baseB = 6.9, height = 220, fill = true }) {
  const a = useMemo(() => genFrames(seedA, 220, baseA), [seedA, baseA]);
  const b = useMemo(() => genFrames(seedB, 220, baseB), [seedB, baseB]);
  const W = 1000, H = height, padB = 22, padL = 4;
  const max = Math.max(...a, ...b, 20);
  const stepX = (W - padL) / (a.length - 1);
  const y = (v) => H - padB - (v / max) * (H - padB - 8);
  const line = (data) => data.map((v, i) => `${padL + i * stepX},${y(v)}`).join(' ');
  const areaB = `${padL},${H - padB} ${line(b)} ${padL + (b.length - 1) * stepX},${H - padB}`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="dualFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2ee6c6" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#2ee6c6" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75, 1].map((g, i) => (
        <line key={i} x1={padL} x2={W} y1={(H - padB) * g} y2={(H - padB) * g} stroke="var(--chart-grid)" strokeWidth="1" />
      ))}
      {fill && <polygon points={areaB} fill="url(#dualFill)" />}
      {/* Before — muted */}
      <polyline points={line(a)} fill="none" stroke="var(--fg-4)" strokeWidth="1.5" strokeLinejoin="round" strokeDasharray="4 3" />
      {/* After — accent */}
      <polyline points={line(b)} fill="none" stroke="var(--brand-teal)" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

// ── Grouped before/after smoothness bars ───────────────────────────────
function CompareBars({ rows, max = 220 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {rows.map((r) => (
        <div key={r.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
            <span className="hd-meter__label">{r.label}</span>
            <span data-mono style={{ font: 'var(--type-data)', color: 'var(--fg-3)' }}>
              {r.a}{r.unit} <span style={{ color: 'var(--fg-4)' }}>→</span> <span style={{ color: 'var(--fg-1)' }}>{r.b}{r.unit}</span>
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ height: '8px', background: 'var(--bg-inset)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, (r.a / max) * 100)}%`, height: '100%', background: 'var(--fg-4)', borderRadius: 'var(--radius-pill)' }} />
            </div>
            <div style={{ height: '8px', background: 'var(--bg-inset)', borderRadius: 'var(--radius-pill)', overflow: 'hidden' }}>
              <div style={{ width: `${Math.min(100, (r.b / max) * 100)}%`, height: '100%', background: r.color || 'var(--brand-teal)', borderRadius: 'var(--radius-pill)' }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

Object.assign(window, { FrameTimeChart, SmoothnessBars, BellCurve, genFrames, DualFrameTimeChart, CompareBars });
