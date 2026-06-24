// Heimdall Web Hub — aggregate Game page (distributions + filters).
function GamePage() {
  const [verified, setVerified] = React.useState(true);
  const [gpu, setGpu] = React.useState('4070');
  const [workload, setWorkload] = React.useState('benchmark');
  // Sample counts per GPU bucket drive the §17.4 cold-start threshold (~30).
  const SAMPLES = { '4070': 412, '4090': 156, '7800xt': 63, 'b580': 7 };
  const GPU_LABEL = { '4070': 'RTX 4070', '4090': 'RTX 4090', '7800xt': 'RX 7800 XT', 'b580': 'Arc B580' };
  const allRows = [
    { gpu: 'RTX 4090', cpu: '7800X3D', avg: 198, p1: 142, p01: 110, by: 'hardwarecanucks', v: true, scene: 'benchmark' },
    { gpu: 'RTX 4070', cpu: '7800X3D', avg: 145, p1: 98, p01: 71, by: 'you', v: false, me: true, scene: 'benchmark' },
    { gpu: 'RX 7800 XT', cpu: '5800X', avg: 131, p1: 88, p01: 64, by: 'frame_chaser', v: true, scene: 'gameplay' },
    { gpu: 'RTX 4070', cpu: '13600K', avg: 139, p1: 91, p01: 66, by: 'anon', v: false, scene: 'gameplay' },
    { gpu: 'Arc B580', cpu: '7600', avg: 96, p1: 61, p01: 44, by: 'intel_labs', v: true, scene: 'benchmark' },
  ];
  const rows = allRows.filter((r) => workload === 'all' || r.scene === workload);
  const sampleN = SAMPLES[gpu];
  const enough = sampleN >= 30;
  return (
    <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto', padding: 'var(--space-8) var(--space-6) var(--space-16)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: '4px' }}>
        <span className="heimdall-overline">Aggregate · 1,284 public runs</span>
      </div>
      <h1 style={{ font: 'var(--type-title)', color: 'var(--fg-1)' }}>Cyberpunk 2077</h1>
      <p style={{ font: 'var(--type-body)', color: 'var(--fg-2)', marginTop: '4px' }}>Where your run sits in the crowd, by hardware configuration.</p>

      {/* Filter bar */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-6)', padding: 'var(--space-3)', background: 'var(--bg-raised)', border: '1px solid var(--line-1)', borderRadius: 'var(--radius-md)' }}>
        <span className="hd-select" style={{ width: 168 }}>
          <select value={gpu} onChange={(e) => setGpu(e.target.value)}>
            <option value="4070">GPU: RTX 4070</option>
            <option value="4090">GPU: RTX 4090</option>
            <option value="7800xt">GPU: RX 7800 XT</option>
            <option value="b580">GPU: Arc B580</option>
          </select>
          <span className="hd-select__chev"><Icon n="chevron-down" size={16} /></span>
        </span>
        <span className="hd-tag">1440p<span className="hd-tag__close"><Icon n="x" size={14} /></span></span>
        <span className="hd-tag">DX12<span className="hd-tag__close"><Icon n="x" size={14} /></span></span>
        {/* §17.5 workload comparability filter */}
        <div className="hd-segmented" role="group" aria-label="Workload">
          <button className={`hd-segmented__opt${workload === 'benchmark' ? ' hd-segmented__opt--active' : ''}`} onClick={() => setWorkload('benchmark')}><Icon n="flask-conical" size={14} /> Benchmark scene</button>
          <button className={`hd-segmented__opt${workload === 'gameplay' ? ' hd-segmented__opt--active' : ''}`} onClick={() => setWorkload('gameplay')}><Icon n="gamepad-2" size={14} /> Gameplay</button>
          <button className={`hd-segmented__opt${workload === 'all' ? ' hd-segmented__opt--active' : ''}`} onClick={() => setWorkload('all')}>All</button>
        </div>
        <div style={{ flex: 1 }} />
        <label className="hd-switch">
          <input type="checkbox" role="switch" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
          <span className="hd-switch__track"><span className="hd-switch__thumb" /></span>
          <span className="hd-switch__label">Verified only</span>
        </label>
      </div>

      {/* §17.5 comparability caveat */}
      <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 'var(--space-3)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        <Icon n="info" size={13} /> Aggregates compare like workloads only — freeform gameplay is noisier than the canned benchmark scene.
      </p>

      {/* Distribution OR cold-start state */}
      {enough ? (
        <div className="hd-card" style={{ marginTop: 'var(--space-4)' }}>
          <div className="hd-card__head">
            <span className="hd-card__title">Avg FPS distribution · {GPU_LABEL[gpu]}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span className="hd-badge hd-badge--neutral">{sampleN} runs</span>
              <span className="hd-badge hd-badge--brand">You: 73rd percentile</span>
            </div>
          </div>
          <div className="hd-card__body">
            <div className="hd-card hd-card--inset" style={{ padding: 'var(--space-4) var(--space-3) var(--space-2)' }}>
              <BellCurve markerPct={0.73} height={150} />
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0 4px', font: 'var(--type-overline)', color: 'var(--fg-4)', letterSpacing: 'var(--tracking-wide)' }}>
                <span>96</span><span>120</span><span>145 ◂ you</span><span>168</span><span>192</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="hd-card" style={{ marginTop: 'var(--space-4)' }}>
          <div className="hd-card__head">
            <span className="hd-card__title">{GPU_LABEL[gpu]}</span>
            <span className="hd-badge hd-badge--warn">{sampleN} runs</span>
          </div>
          <div className="hd-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div className="hd-diag hd-diag--info">
              <span className="hd-diag__icon"><Icon n="info" size={20} /></span>
              <div className="hd-diag__body">
                <span className="hd-diag__title">Insufficient data for a distribution</span>
                <span className="hd-diag__msg">Only {sampleN} runs exist for this configuration — below the 30-run minimum. Showing individual runs instead of a curve; a distribution over a handful of runs would be noise, not signal.</span>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {[{ avg: 96, by: 'intel_labs', v: true }, { avg: 94, by: 'b580_owner', v: false }, { avg: 89, by: 'anon', v: false }].map((r, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--space-3) var(--space-4)', background: 'var(--bg-inset)', border: '1px solid var(--line-1)', borderRadius: 3 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', font: 'var(--type-body-sm)', color: 'var(--fg-2)' }}>{r.by}{r.v && <Icon n="shield-check" size={14} style={{ color: 'var(--brand-teal)' }} />}</span>
                  <span data-mono style={{ font: 'var(--type-data)', color: 'var(--tier-avg)', fontWeight: 600 }}>{r.avg} <span style={{ color: 'var(--fg-3)', fontWeight: 400 }}>avg fps</span></span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Submissions table */}
      <div className="hd-card" style={{ marginTop: 'var(--space-5)' }}>
        <div className="hd-card__head"><span className="hd-card__title">Submissions</span><span className="hd-badge hd-badge--neutral">{rows.length} shown</span></div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['GPU', 'CPU', 'Scene', 'Avg', '1% Low', '0.1% Low', 'By'].map((h, i) => (
                <th key={h} style={{ textAlign: i > 2 && i < 6 ? 'right' : 'left', font: 'var(--type-overline)', letterSpacing: 'var(--tracking-wide)', textTransform: 'uppercase', color: 'var(--fg-3)', padding: '10px var(--space-5)', borderBottom: '1px solid var(--line-2)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ background: r.me ? 'var(--brand-teal-dim)' : 'transparent' }}>
                <td style={{ padding: '12px var(--space-5)', borderBottom: '1px solid var(--line-1)', font: 'var(--type-body)', color: 'var(--fg-1)' }}>{r.gpu}</td>
                <td style={{ padding: '12px var(--space-5)', borderBottom: '1px solid var(--line-1)', font: 'var(--type-body-sm)', color: 'var(--fg-2)' }}>{r.cpu}</td>
                <td style={{ padding: '12px var(--space-5)', borderBottom: '1px solid var(--line-1)' }}>
                  <span className={`hd-badge hd-badge--${r.scene === 'benchmark' ? 'info' : 'neutral'}`}>{r.scene === 'benchmark' ? 'Bench' : 'Play'}</span>
                </td>
                <td data-mono style={{ padding: '12px var(--space-5)', borderBottom: '1px solid var(--line-1)', textAlign: 'right', font: 'var(--type-data)', color: 'var(--tier-avg)', fontWeight: 600 }}>{r.avg}</td>
                <td data-mono style={{ padding: '12px var(--space-5)', borderBottom: '1px solid var(--line-1)', textAlign: 'right', font: 'var(--type-data)', color: 'var(--fg-1)' }}>{r.p1}</td>
                <td data-mono style={{ padding: '12px var(--space-5)', borderBottom: '1px solid var(--line-1)', textAlign: 'right', font: 'var(--type-data)', color: 'var(--fg-2)' }}>{r.p01}</td>
                <td style={{ padding: '12px var(--space-5)', borderBottom: '1px solid var(--line-1)' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', font: 'var(--type-body-sm)', color: 'var(--fg-2)' }}>
                    {r.by}{r.v && <Icon n="shield-check" size={14} style={{ color: 'var(--brand-teal)' }} />}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

Object.assign(window, { GamePage });
