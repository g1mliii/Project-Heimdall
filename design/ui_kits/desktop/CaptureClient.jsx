// Heimdall Desktop — Tauri 2 capture client. States: onboarding → ready → capturing → complete.
const DIcon = ({ n, size, style, ...p }) => <i data-lucide={n} style={{ width: size || 18, height: size || 18, ...style }} {...p} />;

function HwRow({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line-1)' }}>
      <span style={{ font: 'var(--type-body-sm)', color: 'var(--fg-3)' }}>{k}</span>
      <span data-mono style={{ font: 'var(--type-data)', color: 'var(--fg-1)' }}>{v}</span>
    </div>
  );
}

// Run details (§16c) — the nine profileRequired comparability fields. Without
// them the run uploads fine but never pools into aggregates, so the Complete
// screen has to collect what detection cannot. Prefilled where the client
// knows the answer; graphicsApi is a picker because PresentMon reports the
// present runtime as DXGI for both DX11 and DX12 and the parser refuses to guess.
function RunDetails({ open, onToggle, values, missing, onChange }) {
  const field = (key, label, control) => (
    <label key={key} style={{ display: 'grid', gap: 4 }}>
      <span style={{ font: 'var(--type-caption)', color: missing.includes(key) ? 'var(--warn)' : 'var(--fg-3)' }}>
        {label}{missing.includes(key) ? ' · needed to compare' : ''}
      </span>
      {control}
    </label>
  );
  const set = (key) => (event) => onChange(key, event.target.value);
  const input = (key, placeholder) => (
    <input className="hd-input" value={values[key] ?? ''} placeholder={placeholder} onChange={set(key)} />
  );
  const select = (key, options) => (
    <select className="hd-select" value={values[key] ?? ''} onChange={set(key)}>
      <option value="">Select…</option>
      {options.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  );

  return (
    <div className="hd-card hd-card--inset" style={{ padding: 12, marginBottom: 12 }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--fg-1)', font: 'var(--type-body-sm)' }}
      >
        <DIcon n={open ? 'chevron-down' : 'chevron-right'} size={16} />
        Run details
        {missing.length > 0 && <span className="hd-badge hd-badge--warn" style={{ marginLeft: 'auto', height: 18 }}>{missing.length} missing</span>}
      </button>
      {open && (
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', margin: 0 }}>
            Runs only pool into game and hardware aggregates when every field below matches.
            Leave one blank and the run still uploads — it just stands alone.
          </p>
          {field('resolution', 'Resolution', input('resolution', '2560x1440'))}
          {field('scene', 'Scene', input('scene', 'Built-in benchmark'))}
          {field('sceneType', 'Scene type', select('sceneType', [['benchmark-scene', 'Benchmark scene'], ['gameplay', 'Gameplay'], ['freeform', 'Freeform']]))}
          {field('settingsPreset', 'Settings preset', input('settingsPreset', 'Ultra'))}
          {field('graphicsApi', 'Graphics API', select('graphicsApi', [['d3d12', 'DirectX 12'], ['d3d11', 'DirectX 11'], ['vulkan', 'Vulkan'], ['opengl', 'OpenGL']]))}
          {field('upscaler', 'Upscaler', select('upscaler', [['none', 'None'], ['dlss', 'DLSS'], ['fsr', 'FSR'], ['xess', 'XeSS'], ['unknown', 'Unknown']]))}
          {field('rayTracing', 'Ray tracing', select('rayTracing', [['off', 'Off'], ['on', 'On'], ['unknown', 'Unknown']]))}
          {field('vsync', 'V-Sync', select('vsync', [['true', 'On'], ['false', 'Off']]))}
          {field('vrr', 'VRR / G-Sync / FreeSync', select('vrr', [['true', 'On'], ['false', 'Off']]))}
        </div>
      )}
    </div>
  );
}

function CaptureClient() {
  const [state, setState] = React.useState('onboarding'); // onboarding | ready | capturing | complete
  const [sec, setSec] = React.useState(0);
  const [detailsOpen, setDetailsOpen] = React.useState(false);
  const [details, setDetails] = React.useState({ resolution: '2560x1440', sceneType: 'benchmark-scene' });
  const missing = ['scene', 'settingsPreset', 'graphicsApi', 'upscaler', 'rayTracing', 'vsync', 'vrr']
    .filter((key) => !details[key]);

  React.useEffect(() => { if (window.lucide) window.lucide.createIcons(); });
  React.useEffect(() => {
    if (state !== 'capturing') return;
    setSec(0);
    const id = setInterval(() => setSec((s) => {
      if (s >= 60) { clearInterval(id); setState('complete'); return 60; }
      return s + 1;
    }), 45); // sped up for the demo
    return () => clearInterval(id);
  }, [state]);

  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');

  return (
    <div className="win">
      <div className="titlebar">
        <span className="name"><img src="../../assets/logo-mark.svg" width="16" height="16" alt="" /> Heimdall Capture</span>
        <span className="winctl">
          <button aria-label="Minimize"><DIcon n="minus" size={14} /></button>
          <button aria-label="Maximize"><DIcon n="square" size={12} /></button>
          <button className="close" aria-label="Close"><DIcon n="x" size={14} /></button>
        </span>
      </div>
      <div className="body">

        {/* ── First-run onboarding (§22.4) ── */}
        {state === 'onboarding' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <span style={{ width: 44, height: 44, borderRadius: 'var(--radius-md)', display: 'grid', placeItems: 'center', background: 'var(--brand-teal-dim)', color: 'var(--brand-teal)' }}><DIcon n="shield-check" size={22} /></span>
              <div>
                <div style={{ font: 'var(--type-subheading)', color: 'var(--fg-1)' }}>One-time setup</div>
                <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 2 }}>No administrator rights required</div>
              </div>
            </div>
            <p style={{ font: 'var(--type-body-sm)', color: 'var(--fg-2)', marginBottom: 14 }}>
              Heimdall captures with Intel PresentMon 2.4.1, which runs without admin once your
              account is in the <strong style={{ color: 'var(--fg-1)' }}>Performance Log Users</strong> group.
            </p>
            <div className="hd-card hd-card--inset" style={{ padding: 14, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[['1', 'Add this account to Performance Log Users', 'done'], ['2', 'Sign out and back in to apply', 'done'], ['3', 'Bundled PresentMon CLI detected', 'done']].map(([n, label, st]) => (
                <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ width: 18, height: 18, flex: 'none', display: 'grid', placeItems: 'center', color: 'var(--good)' }}><DIcon n="check" size={16} /></span>
                  <span style={{ font: 'var(--type-body-sm)', color: 'var(--fg-1)' }}>{label}</span>
                </div>
              ))}
            </div>
            <button className="hd-btn hd-btn--secondary hd-btn--block" style={{ marginBottom: 8 }}><DIcon n="external-link" size={15} /> Open setup guide</button>
            <button className="hd-btn hd-btn--primary hd-btn--block hd-btn--lg" onClick={() => setState('ready')}>Continue <DIcon n="arrow-right" size={16} /></button>
          </div>
        )}

        {state !== 'onboarding' && (<>

        {/* ── Status hero ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <span style={{
            width: 44, height: 44, borderRadius: 'var(--radius-md)', display: 'grid', placeItems: 'center',
            background: state === 'capturing' ? 'var(--bad-dim)' : state === 'complete' ? 'var(--good-dim)' : 'var(--brand-teal-dim)',
            color: state === 'capturing' ? 'var(--bad)' : state === 'complete' ? 'var(--good)' : 'var(--brand-teal)',
          }}>
            <DIcon n={state === 'capturing' ? 'radio' : state === 'complete' ? 'check' : 'activity'} size={22} />
          </span>
          <div>
            <div style={{ font: 'var(--type-subheading)', color: 'var(--fg-1)' }}>
              {state === 'ready' && 'Ready to capture'}
              {state === 'capturing' && 'Capturing…'}
              {state === 'complete' && 'Capture complete'}
            </div>
            <div style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <span className={`hd-badge hd-badge--${state === 'capturing' ? 'bad' : state === 'complete' ? 'good' : 'neutral'}`} style={{ height: 18 }}>
                {state !== 'complete' && <span className="hd-badge__dot" />}PresentMon · Windows
              </span>
            </div>
          </div>
        </div>

        {/* ── Capturing live view ── */}
        {state === 'capturing' && (
          <div className="hd-card hd-card--inset" style={{ padding: 14, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span className="heimdall-overline">Elapsed</span>
              <span data-mono style={{ font: 'var(--type-metric)', color: 'var(--fg-1)' }}>{mm}:{ss}</span>
            </div>
            <FrameTimeChart seed={12} height={86} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10 }}>
              <span data-mono style={{ font: 'var(--type-data)', color: 'var(--tier-avg)' }}>142 fps</span>
              <span data-mono style={{ font: 'var(--type-data)', color: 'var(--fg-3)' }}>{Math.round(sec / 60 * 14900).toLocaleString()} frames</span>
            </div>
          </div>
        )}

        {/* ── Complete result ── */}
        {state === 'complete' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 16 }}>
            <div className="hd-stat" style={{ padding: 12 }}><div className="hd-stat__accent" style={{ background: 'var(--tier-avg)' }} /><span className="hd-stat__label">Avg</span><span className="hd-stat__value" style={{ fontSize: 'var(--text-xl)' }}>144</span></div>
            <div className="hd-stat" style={{ padding: 12 }}><div className="hd-stat__accent" style={{ background: 'var(--tier-p1)' }} /><span className="hd-stat__label">1% Low</span><span className="hd-stat__value" style={{ fontSize: 'var(--text-xl)' }}>98</span></div>
            <div className="hd-stat" style={{ padding: 12 }}><div className="hd-stat__accent" style={{ background: 'var(--tier-p01)' }} /><span className="hd-stat__label">0.1%</span><span className="hd-stat__value" style={{ fontSize: 'var(--text-xl)' }}>71</span></div>
          </div>
        )}

        {/* ── Hardware snapshot (ready/complete) ── */}
        {state !== 'capturing' && (
          <div style={{ marginBottom: 16 }}>
            <span className="heimdall-overline" style={{ display: 'block', marginBottom: 6 }}>Detected hardware</span>
            <HwRow k="Game" v="Cyberpunk 2077" />
            <HwRow k="GPU" v="RTX 4070" />
            <HwRow k="CPU" v="Ryzen 7 7800X3D" />
            <HwRow k="Driver" v="566.14" />
            <HwRow k="Capture" v="Shift + F11" />
          </div>
        )}

        {/* ── EAC/BattlEye anti-cheat warning (§24.4) ── */}
        {state === 'ready' && (
          <div className="hd-diag hd-diag--warn" style={{ padding: '10px 12px', marginBottom: 16 }}>
            <span className="hd-diag__icon"><DIcon n="shield-alert" size={18} /></span>
            <div className="hd-diag__body">
              <span className="hd-diag__title">Anti-cheat detected</span>
              <span className="hd-diag__msg" style={{ color: 'var(--fg-2)' }}>The foreground title runs Easy Anti-Cheat. Capture is scoped to single-player / benchmark scenes to avoid conflicts.</span>
            </div>
          </div>
        )}

        {/* ── Actions ── */}
        {state === 'ready' && (
          <button className="hd-btn hd-btn--primary hd-btn--block hd-btn--lg" onClick={() => setState('capturing')}>
            <DIcon n="circle" size={16} /> Start capture
          </button>
        )}
        {state === 'capturing' && (
          <button className="hd-btn hd-btn--danger hd-btn--block hd-btn--lg" onClick={() => setState('complete')}>
            <DIcon n="square" size={14} /> Stop &amp; analyze
          </button>
        )}
        {state === 'complete' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <RunDetails
              open={detailsOpen}
              onToggle={() => setDetailsOpen((value) => !value)}
              values={details}
              missing={missing}
              onChange={(key, value) => setDetails((current) => ({ ...current, [key]: value }))}
            />
            <div className="hd-diag hd-diag--info" style={{ padding: '10px 12px' }}>
              <span className="hd-diag__icon"><DIcon n="shield-check" size={18} /></span>
              <div className="hd-diag__body"><span className="hd-diag__msg" style={{ color: 'var(--fg-2)' }}>Payload signed &amp; ready to upload.</span></div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="hd-btn hd-btn--secondary" style={{ flex: 1 }} onClick={() => setState('ready')}>Discard</button>
              <button className="hd-btn hd-btn--primary" style={{ flex: 2 }}><DIcon n="upload" size={16} /> Upload &amp; share</button>
            </div>
          </div>
        )}

        <p style={{ font: 'var(--type-caption)', color: 'var(--fg-4)', textAlign: 'center', marginTop: 14 }}>
          {state === 'ready' && 'Press Shift + F11 in-game to start hands-free.'}
          {state === 'capturing' && 'Recommended capture length: 60 seconds.'}
          {state === 'complete' && 'Uploads open the run report in your browser.'}
        </p>
        </>)}
      </div>
    </div>
  );
}

Object.assign(window, { CaptureClient });
