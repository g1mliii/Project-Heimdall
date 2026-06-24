// Heimdall Desktop — Tauri 2 capture client. States: ready → capturing → complete.
const DIcon = ({ n, size, style, ...p }) => <i data-lucide={n} style={{ width: size || 18, height: size || 18, ...style }} {...p} />;

function HwRow({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 0', borderBottom: '1px solid var(--line-1)' }}>
      <span style={{ font: 'var(--type-body-sm)', color: 'var(--fg-3)' }}>{k}</span>
      <span data-mono style={{ font: 'var(--type-data)', color: 'var(--fg-1)' }}>{v}</span>
    </div>
  );
}

function CaptureClient() {
  const [state, setState] = React.useState('onboarding'); // onboarding | ready | capturing | complete
  const [sec, setSec] = React.useState(0);

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
              Heimdall captures with Intel PresentMon 2.3.1+, which runs without admin once your
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
