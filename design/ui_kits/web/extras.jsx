// Heimdall Web Hub — Upload/ingest + Before/After compare screens.
function UploadPage({ onParsed }) {
  const [stage, setStage] = React.useState('idle'); // idle | parsing | done | batch
  const [files, setFiles] = React.useState([]);
  React.useEffect(() => {
    if (stage === 'parsing') {
      const t = setTimeout(() => setStage('done'), 1400);
      return () => clearTimeout(t);
    }
  }, [stage]);

  // §11.8 — each file parses + uploads independently; partial failures are fine.
  const BATCH = [
    { name: 'Cyberpunk_Ultra_RT.csv', frames: 14902, ms: 300 },
    { name: 'Cyberpunk_DLSS_Q.csv', frames: 16110, ms: 700 },
    { name: 'RDR2_benchmark.csv', frames: 9981, ms: 1100 },
    { name: 'Hogwarts_1440p.json', frames: 0, ms: 1500, err: 'Unrecognized column layout' },
    { name: 'Starfield_NewAtlantis.csv', frames: 21044, ms: 1900 },
  ];
  const startBatch = () => {
    setStage('batch');
    setFiles(BATCH.map((f) => ({ ...f, status: 'queued' })));
    BATCH.forEach((f, i) => {
      setTimeout(() => setFiles((prev) => prev.map((p, j) => j === i ? { ...p, status: 'working' } : p)), f.ms - 250);
      setTimeout(() => setFiles((prev) => prev.map((p, j) => j === i ? { ...p, status: f.err ? 'error' : 'done' } : p)), f.ms);
    });
  };

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 'var(--space-12) var(--space-6) var(--space-16)' }}>
      <span className="heimdall-overline">Ingest</span>
      <h1 style={{ font: 'var(--type-title)', color: 'var(--fg-1)', marginTop: '4px' }}>Upload a benchmark log</h1>
      <p style={{ font: 'var(--type-body)', color: 'var(--fg-2)', marginTop: '6px' }}>Drag a CapFrameX, PresentMon, or MangoHud export. We parse it in your browser — no account needed.</p>

      <div
        onClick={() => stage === 'idle' && setStage('parsing')}
        style={{
          marginTop: 'var(--space-6)', border: '1.5px dashed var(--line-3)', borderRadius: 'var(--radius-lg)',
          background: 'var(--bg-raised)', padding: 'var(--space-12)', textAlign: 'center', cursor: 'pointer',
        }}>
        {stage === 'idle' && (<>
          <div style={{ width: 56, height: 56, margin: '0 auto var(--space-4)', borderRadius: 'var(--radius-md)', background: 'var(--brand-teal-dim)', color: 'var(--brand-teal)', display: 'grid', placeItems: 'center' }}><Icon n="upload-cloud" size={28} /></div>
          <p style={{ font: 'var(--type-subheading)', color: 'var(--fg-1)' }}>Drop your log here</p>
          <p style={{ font: 'var(--type-body-sm)', color: 'var(--fg-3)', marginTop: '4px' }}>or click to browse · .csv .json · up to 150 files</p>
        </>)}
        {stage === 'parsing' && (<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)' }}>
          <span className="hd-spinner" style={{ width: 28, height: 28 }} />
          <p style={{ font: 'var(--type-subheading)', color: 'var(--fg-1)' }}>Parsing CyberpunkBenchmark.csv…</p>
          <p data-mono style={{ font: 'var(--type-data)', color: 'var(--fg-3)' }}>14,902 frames · computing summary</p>
        </div>)}
        {stage === 'done' && (<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-3)' }}>
          <div style={{ width: 48, height: 48, borderRadius: 999, background: 'var(--good-dim)', color: 'var(--good)', display: 'grid', placeItems: 'center' }}><Icon n="check" size={26} /></div>
          <p style={{ font: 'var(--type-subheading)', color: 'var(--fg-1)' }}>Parsed — 144.7 avg FPS</p>
          <button className="hd-btn hd-btn--primary" onClick={(e) => { e.stopPropagation(); onParsed && onParsed(); }}>View run report <Icon n="arrow-right" size={16} /></button>
        </div>)}
        {stage === 'batch' && (<div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--space-2)' }}>
          <Icon n="folder-up" size={28} style={{ color: 'var(--brand-teal)' }} />
          <p style={{ font: 'var(--type-subheading)', color: 'var(--fg-1)' }}>Uploading 5 legacy logs</p>
          <p data-mono style={{ font: 'var(--type-data)', color: 'var(--fg-3)' }}>parse → sign → direct-to-R2, per file</p>
        </div>)}
      </div>

      {/* §11.8 per-file progress list */}
      {stage === 'batch' && (
        <div className="hd-card" style={{ marginTop: 'var(--space-5)' }}>
          <div className="hd-card__head">
            <span className="hd-card__title">Batch progress</span>
            <span className="hd-badge hd-badge--neutral">{files.filter((f) => f.status === 'done').length} / {files.length} done</span>
          </div>
          <div className="hd-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', paddingTop: 'var(--space-2)' }}>
            {files.map((f) => (
              <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: '8px 0', borderBottom: '1px solid var(--line-1)' }}>
                <span style={{ flex: 'none', width: 20, display: 'grid', placeItems: 'center' }}>
                  {f.status === 'queued' && <Icon n="clock" size={15} style={{ color: 'var(--fg-4)' }} />}
                  {f.status === 'working' && <span className="hd-spinner" style={{ width: 15, height: 15 }} />}
                  {f.status === 'done' && <Icon n="check" size={16} style={{ color: 'var(--good)' }} />}
                  {f.status === 'error' && <Icon n="x" size={16} style={{ color: 'var(--bad)' }} />}
                </span>
                <span data-mono style={{ flex: 1, font: 'var(--type-data)', color: f.status === 'error' ? 'var(--fg-2)' : 'var(--fg-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                <span style={{ font: 'var(--type-caption)', color: f.status === 'error' ? 'var(--bad)' : 'var(--fg-3)' }}>
                  {f.status === 'error' ? f.err : f.status === 'done' ? `${f.frames.toLocaleString()} frames` : f.status === 'working' ? 'parsing…' : 'queued'}
                </span>
              </div>
            ))}
            <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 'var(--space-2)' }}>One bad file never blocks the rest — each succeeds or fails on its own.</p>
          </div>
        </div>
      )}

      {stage === 'idle' && (
        <button className="hd-btn hd-btn--ghost" style={{ marginTop: 'var(--space-3)' }} onClick={startBatch}>
          <Icon n="folder-up" size={16} /> Upload a legacy folder (batch)
        </button>
      )}

      <div style={{ marginTop: 'var(--space-6)' }}>
        <span className="heimdall-overline" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>Visibility</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <label className="hd-check"><input type="checkbox" defaultChecked /><span className="hd-check__box"><Icon n="check" size={13} /></span><span>Unlisted — link only, excluded from public averages</span></label>
          <label className="hd-check"><input type="checkbox" /><span className="hd-check__box"><Icon n="check" size={13} /></span><span>Public — eligible for game distributions once validated</span></label>
        </div>
      </div>
    </div>
  );
}

const COMPARE_SCENARIOS = {
  expo: {
    title: 'EXPO off → EXPO on',
    chip: 'Memory tuning',
    seedA: 21, baseA: 8.6, seedB: 7, baseB: 6.9,
    a: { name: 'Run A — EXPO off', when: 'Mar 14 · 4800 MHz', config: ['1440p', 'Ultra + RT', '4800 MHz'] },
    b: { name: 'Run B — EXPO on', when: 'Mar 14 · 6000 MHz', config: ['1440p', 'Ultra + RT', '6000 MHz'] },
    verdict: { sev: 'good', title: 'Your 1% lows improved 16.7%', msg: 'Enabling EXPO meaningfully reduced micro-stutters while average FPS rose 10.7%.' },
    stats: [
      { label: 'Avg FPS', a: 131, b: 145, unit: '', better: 'up', color: 'var(--tier-avg)' },
      { label: '1% Low', a: 84, b: 98, unit: '', better: 'up', color: 'var(--tier-p1)' },
      { label: '0.1% Low', a: 58, b: 71, unit: '', better: 'up', color: 'var(--tier-p01)' },
      { label: 'p99 frame-time', a: 17.2, b: 14.1, unit: 'ms', better: 'down', color: 'var(--brand-violet)' },
    ],
    resolved: ['RAM below rated speed', 'Frequent micro-stutters'],
    remaining: ['VRAM saturation near texture streaming'],
  },
  dlss: {
    title: 'DLSS off → Quality',
    chip: 'Upscaling',
    seedA: 33, baseA: 9.8, seedB: 5, baseB: 6.2,
    a: { name: 'Run A — DLSS off', when: 'Mar 18 · Native', config: ['1440p', 'Native', 'RT Overdrive'] },
    b: { name: 'Run B — DLSS Quality', when: 'Mar 18 · Quality', config: ['1440p', 'DLSS Q', 'RT Overdrive'] },
    verdict: { sev: 'good', title: 'Average FPS rose 56% with DLSS Quality', msg: 'Frame-time variance tightened and VRAM pressure eased — at a small fidelity cost from upscaling.' },
    stats: [
      { label: 'Avg FPS', a: 103, b: 161, unit: '', better: 'up', color: 'var(--tier-avg)' },
      { label: '1% Low', a: 67, b: 112, unit: '', better: 'up', color: 'var(--tier-p1)' },
      { label: '0.1% Low', a: 44, b: 79, unit: '', better: 'up', color: 'var(--tier-p01)' },
      { label: 'VRAM peak', a: 11.8, b: 9.4, unit: ' GB', better: 'down', color: 'var(--brand-violet)' },
    ],
    resolved: ['VRAM saturation stutters', 'GPU-bound below target FPS'],
    remaining: ['Mild upscaling ghosting (not measured)'],
  },
  driver: {
    title: 'Driver 561.09 → 566.14',
    chip: 'Driver update',
    seedA: 14, baseA: 7.4, seedB: 9, baseB: 6.8,
    a: { name: 'Run A — 561.09', when: 'Feb 02', config: ['1440p', 'Ultra + RT', '561.09'] },
    b: { name: 'Run B — 566.14', when: 'Mar 21', config: ['1440p', 'Ultra + RT', '566.14'] },
    verdict: { sev: 'info', title: 'Modest, within run-to-run variance', msg: 'Average FPS rose 3.1% — real but small. 0.1% lows are within the noise floor for a 60s capture.' },
    stats: [
      { label: 'Avg FPS', a: 140, b: 145, unit: '', better: 'up', color: 'var(--tier-avg)' },
      { label: '1% Low', a: 94, b: 98, unit: '', better: 'up', color: 'var(--tier-p1)' },
      { label: '0.1% Low', a: 70, b: 71, unit: '', better: 'up', color: 'var(--tier-p01)' },
      { label: 'p99 frame-time', a: 14.6, b: 14.1, unit: 'ms', better: 'down', color: 'var(--brand-violet)' },
    ],
    resolved: ['Shader-comp hitches on first load'],
    remaining: ['RAM below rated speed', 'VRAM saturation stutters'],
  },
};

function ConfigCard({ run, tone, label }) {
  return (
    <div className="hd-card" style={{ flex: 1, minWidth: 220 }}>
      <div className="hd-card__body" style={{ padding: 'var(--space-4)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: tone, flex: 'none' }} />
          <span style={{ font: 'var(--type-label)', color: 'var(--fg-1)' }}>{run.name}</span>
          <span style={{ marginLeft: 'auto', font: 'var(--type-caption)', color: 'var(--fg-3)' }}>{run.when}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {run.config.map((c) => <span key={c} className="hd-badge hd-badge--neutral">{c}</span>)}
        </div>
      </div>
    </div>
  );
}

function ComparePage({ scenario = 'expo', chartFill = true }) {
  const s = COMPARE_SCENARIOS[scenario] || COMPARE_SCENARIOS.expo;
  const barMax = Math.max(...s.stats.filter((c) => c.unit === '').map((c) => c.b)) * 1.15;
  return (
    <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto', padding: 'var(--space-8) var(--space-6) var(--space-16)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className="heimdall-overline">Before / after validator</span>
            <span className="hd-badge hd-badge--brand">{s.chip}</span>
          </div>
          <h1 style={{ font: 'var(--type-title)', color: 'var(--fg-1)', marginTop: '4px' }}>{s.title}</h1>
          <p style={{ font: 'var(--type-body)', color: 'var(--fg-2)', marginTop: '4px' }}>Cyberpunk 2077 · same scene, same hardware — only the variable below changed.</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="hd-btn hd-btn--secondary"><Icon n="repeat" size={16} /> Swap A / B</button>
          <button className="hd-btn hd-btn--primary"><Icon n="share-2" size={16} /> Share comparison</button>
        </div>
      </div>

      {/* A/B config cards */}
      <div style={{ display: 'flex', gap: 'var(--space-4)', marginTop: 'var(--space-5)', alignItems: 'center', flexWrap: 'wrap' }}>
        <ConfigCard run={s.a} tone="var(--fg-4)" />
        <Icon n="arrow-right" size={20} style={{ color: 'var(--fg-3)', flex: 'none' }} />
        <ConfigCard run={s.b} tone="var(--brand-teal)" />
      </div>

      {/* Verdict */}
      <div className={`hd-diag hd-diag--${s.verdict.sev}`} style={{ marginTop: 'var(--space-5)' }}>
        <span className="hd-diag__icon"><Icon n={s.verdict.sev === 'good' ? 'circle-check' : 'info'} size={20} /></span>
        <div className="hd-diag__body"><span className="hd-diag__title">{s.verdict.title}</span><span className="hd-diag__msg">{s.verdict.msg}</span></div>
      </div>

      {/* Comparison stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 'var(--space-4)', marginTop: 'var(--space-5)' }}>
        {s.stats.map((c) => {
          const delta = c.better === 'down' ? ((c.a - c.b) / c.a) * 100 : ((c.b - c.a) / c.a) * 100;
          const good = delta >= 0;
          return (
            <div key={c.label} className="hd-card"><div className="hd-card__body">
              <span className="hd-stat__label">{c.label}</span>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginTop: '6px' }}>
                <span data-mono style={{ font: 'var(--type-body-sm)', color: 'var(--fg-3)', textDecoration: 'line-through' }}>{c.a}{c.unit}</span>
                <Icon n="arrow-right" size={14} style={{ color: 'var(--fg-4)' }} />
                <span data-mono style={{ font: 'var(--type-metric)', color: 'var(--fg-1)' }}>{c.b}{c.unit}</span>
              </div>
              <span className={`hd-stat__delta hd-stat__delta--${good ? 'up' : 'down'}`} style={{ marginTop: '6px' }}>
                <Icon n={good ? 'trending-up' : 'trending-down'} size={13} /> {good ? '+' : ''}{delta.toFixed(1)}%
              </span>
            </div></div>
          );
        })}
      </div>

      {/* Chart + bars */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 'var(--space-5)', marginTop: 'var(--space-5)', alignItems: 'start' }}>
        <div className="hd-card">
          <div className="hd-card__head">
            <span className="hd-card__title">Frame-time overlay</span>
            <div style={{ display: 'flex', gap: '14px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', font: 'var(--type-caption)', color: 'var(--fg-3)' }}>
                <span style={{ width: 14, height: 0, borderTop: '2px dashed var(--fg-4)' }} /> Before
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', font: 'var(--type-caption)', color: 'var(--fg-3)' }}>
                <span style={{ width: 14, height: 0, borderTop: '2px solid var(--brand-teal)' }} /> After
              </span>
            </div>
          </div>
          <div className="hd-card__body" style={{ padding: 'var(--space-4)' }}>
            <div className="hd-card hd-card--inset" style={{ padding: 'var(--space-3)' }}>
              <DualFrameTimeChart seedA={s.seedA} baseA={s.baseA} seedB={s.seedB} baseB={s.baseB} height={240} fill={chartFill} />
            </div>
          </div>
        </div>

        <div className="hd-card">
          <div className="hd-card__head"><span className="hd-card__title">Smoothness, before → after</span></div>
          <div className="hd-card__body">
            <CompareBars max={barMax} rows={s.stats.filter((c) => c.unit === '').map((c) => ({ label: c.label, a: c.a, b: c.b, unit: c.unit, color: c.color }))} />
          </div>
        </div>
      </div>

      {/* Diagnostics delta */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)', marginTop: 'var(--space-5)' }}>
        <div className="hd-card">
          <div className="hd-card__head"><span className="hd-card__title">Resolved</span><span className="hd-badge hd-badge--good">{s.resolved.length}</span></div>
          <div className="hd-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {s.resolved.map((r) => (
              <div key={r} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Icon n="circle-check" size={18} style={{ color: 'var(--good)', flex: 'none' }} />
                <span style={{ font: 'var(--type-body)', color: 'var(--fg-1)', textDecoration: 'line-through', textDecorationColor: 'var(--fg-4)' }}>{r}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="hd-card">
          <div className="hd-card__head"><span className="hd-card__title">Still present</span><span className="hd-badge hd-badge--warn">{s.remaining.length}</span></div>
          <div className="hd-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
            {s.remaining.map((r) => (
              <div key={r} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <Icon n="triangle-alert" size={18} style={{ color: 'var(--warn)', flex: 'none' }} />
                <span style={{ font: 'var(--type-body)', color: 'var(--fg-2)' }}>{r}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { UploadPage, ComparePage });
