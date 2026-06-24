// Heimdall Web Hub — the shareable Run Report page (flagship view).
function StatTile({ label, value, unit, accent, delta, deltaDir }) {
  return (
    <div className="hd-stat">
      {accent && <div className="hd-stat__accent" style={{ background: accent }} />}
      <span className="hd-stat__label">{label}</span>
      <span className="hd-stat__value">{value}{unit && <span className="hd-stat__unit">{unit}</span>}</span>
      {delta && (
        <span className={`hd-stat__delta hd-stat__delta--${deltaDir || 'up'}`}>
          <Icon n={deltaDir === 'down' ? 'trending-down' : 'trending-up'} size={13} /> {delta}
        </span>
      )}
    </div>
  );
}

function SnapshotRow({ k, v, warn }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line-1)' }}>
      <span style={{ font: 'var(--type-body-sm)', color: 'var(--fg-3)' }}>{k}</span>
      <span data-mono style={{ font: 'var(--type-data)', color: warn ? 'var(--warn)' : 'var(--fg-1)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        {warn && <Icon n="triangle-alert" size={13} style={{ color: 'var(--warn)' }} />}{v}
      </span>
    </div>
  );
}

function RunPage({ showStutters = true, onNavigate }) {
  const [units, setUnits] = React.useState('ms');
  return (
    <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto', padding: 'var(--space-8) var(--space-6) var(--space-16)' }}>
      {/* Title block */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
            <span className="hd-badge hd-badge--good"><span className="hd-badge__dot" />Validated</span>
            <span className="hd-badge hd-badge--brand">DLSS 3</span>
            <span className="hd-badge hd-badge--neutral">Public</span>
          </div>
          <h1 style={{ font: 'var(--type-title)', color: 'var(--fg-1)' }}>Cyberpunk 2077</h1>
          <p style={{ font: 'var(--type-body)', color: 'var(--fg-2)', marginTop: '4px' }}>Ultra · Ray Tracing: Overdrive · 1440p · DX12 · 62s capture</p>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="hd-btn hd-btn--secondary" onClick={() => onNavigate && onNavigate('compare')}><Icon n="git-compare" size={16} /> Compare</button>
          <button className="hd-btn hd-btn--secondary" onClick={() => onNavigate && onNavigate('export')}><Icon n="clapperboard" size={16} /> Export video</button>
          <button className="hd-btn hd-btn--primary"><Icon n="share-2" size={16} /> Share</button>
        </div>
      </div>

      {/* Smoothness tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', marginTop: 'var(--space-6)' }}>
        <StatTile label="Avg FPS" value="144.7" accent="var(--tier-avg)" />
        <StatTile label="1% Low" value="98.2" accent="var(--tier-p1)" />
        <StatTile label="0.1% Low" value="71.0" accent="var(--tier-p01)" />
        <StatTile label="Generated frames" value="38" unit="%" accent="var(--brand-violet)" />
      </div>

      {/* Main grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 'var(--space-5)', marginTop: 'var(--space-5)', alignItems: 'start' }}>
        {/* Frame-time chart */}
        <div className="hd-card">
          <div className="hd-card__head">
            <span className="hd-card__title">Frame-time progression</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', font: 'var(--type-caption)', color: 'var(--fg-3)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--chart-stutter)' }} /> stutter
              </span>
              <div className="hd-segmented">
                <button className={`hd-segmented__opt${units === 'ms' ? ' hd-segmented__opt--active' : ''}`} onClick={() => setUnits('ms')}>ms</button>
                <button className={`hd-segmented__opt${units === 'fps' ? ' hd-segmented__opt--active' : ''}`} onClick={() => setUnits('fps')}>FPS</button>
              </div>
            </div>
          </div>
          <div className="hd-card__body" style={{ padding: 'var(--space-4)' }}>
            <div className="hd-card hd-card--inset" style={{ padding: 'var(--space-3)' }}>
              <FrameTimeChart seed={7} height={260} showStutters={showStutters} />
            </div>
            <div style={{ marginTop: 'var(--space-5)' }}>
              <span className="heimdall-overline" style={{ display: 'block', marginBottom: '14px' }}>Smoothness tiers</span>
              <SmoothnessBars confidence="low" />
            </div>
          </div>
        </div>

        {/* Right column: diagnostics + hardware */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
          <div className="hd-card">
            <div className="hd-card__head"><span className="hd-card__title">Diagnostics</span><span className="hd-badge hd-badge--warn">4 issues</span></div>
            <div className="hd-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
              <div className="hd-diag hd-diag--bad">
                <span className="hd-diag__icon"><Icon n="circle-x" size={20} /></span>
                <div className="hd-diag__body"><span className="hd-diag__title">VRAM saturation stutters</span><span className="hd-diag__msg">Spikes correlate with 100% VRAM use. Lower texture quality.</span></div>
              </div>
              <div className="hd-diag hd-diag--warn">
                <span className="hd-diag__icon"><Icon n="triangle-alert" size={20} /></span>
                <div className="hd-diag__body"><span className="hd-diag__title">RAM below rated speed</span><span className="hd-diag__msg">Running at 4800 MHz vs rated 6000 — enable EXPO in BIOS.</span></div>
              </div>
              <div className="hd-diag hd-diag--warn">
                <span className="hd-diag__icon"><Icon n="cpu" size={20} /></span>
                <div className="hd-diag__body"><span className="hd-diag__title">CPU bottleneck in town</span><span className="hd-diag__msg">CPU at 96% while GPU dropped to 61% during the market scene — frames are CPU-bound there.</span></div>
              </div>
              <div className="hd-diag hd-diag--info">
                <span className="hd-diag__icon"><Icon n="download" size={20} /></span>
                <div className="hd-diag__body"><span className="hd-diag__title">Newer GPU driver available</span><span className="hd-diag__msg">566.14 installed; 572.16 is the latest game-ready driver. Update may improve RT performance.</span></div>
              </div>
            </div>
          </div>

          <div className="hd-card">
            <div className="hd-card__head"><span className="hd-card__title">Hardware snapshot</span></div>
            <div className="hd-card__body" style={{ paddingTop: 'var(--space-2)' }}>
              <SnapshotRow k="GPU" v="RTX 4070" />
              <SnapshotRow k="CPU" v="Ryzen 7 7800X3D" />
              <SnapshotRow k="Driver" v="566.14" />
              <SnapshotRow k="RAM" v="4800 / 6000 MHz" warn />
              <SnapshotRow k="OS" v="Windows 11 26100" />
              <div style={{ marginTop: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                <div className="hd-meter">
                  <div className="hd-meter__head"><span className="hd-meter__label">GPU load</span><span className="hd-meter__value">97%</span></div>
                  <div className="hd-meter__track"><div className="hd-meter__fill" style={{ width: '97%' }} /></div>
                </div>
                <div className="hd-meter">
                  <div className="hd-meter__head"><span className="hd-meter__label">VRAM</span><span className="hd-meter__value">11.4 / 12 GB</span></div>
                  <div className="hd-meter__track"><div className="hd-meter__fill" style={{ width: '95%', background: 'var(--bad)' }} /></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { RunPage });
