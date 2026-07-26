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

// Sensor coverage row for the capture-capability panel (§8.6.1).
// state: 'aligned' (per-frame, attribution-safe) · 'periodic' (sampled, not
// frame-safe) · 'absent' (not captured — shown honestly, never fabricated).
function SensorRow({ k, state }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--line-1)' }}>
      <span style={{ font: 'var(--type-body-sm)', color: 'var(--fg-3)' }}>{k}</span>
      {state === 'aligned' && <span className="hd-badge hd-badge--good">Frame-aligned</span>}
      {state === 'periodic' && <span className="hd-badge hd-badge--warn">Periodic — not frame-safe</span>}
      {state === 'absent' && <span aria-label="Not captured" style={{ font: 'var(--type-body-sm)', color: 'var(--fg-4)' }}>—</span>}
    </div>
  );
}

// Structured evidence row inside a diagnostic's collapsed Evidence block (§8.6.4).
function EvidenceRow({ k, v }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
      <span style={{ font: 'var(--type-caption)', color: 'var(--fg-3)' }}>{k}</span>
      <span data-mono style={{ font: 'var(--type-caption)', color: 'var(--fg-2)' }}>{v}</span>
    </div>
  );
}

function RunPage({ showStutters = true, busyAvailable = true, onNavigate }) {
  const [units, setUnits] = React.useState('ms');
  const [busy, setBusy] = React.useState(true);
  const busyOn = busyAvailable && busy && units === 'ms';
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
        {/* §8.6.3 — the run's own tail-latency numbers, not just distribution options */}
        <StatTile label="P95 frame time" value="9.4" unit="ms" />
        <StatTile label="P99 frame time" value="14.2" unit="ms" />
        <StatTile label="Stutter events" value="12" />
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
              {/* §8.6.8 busy-time overlay legend — only while the overlay is drawn */}
              {busyOn && (
                <>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', font: 'var(--type-caption)', color: 'var(--fg-3)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--chart-cpu-busy)' }} /> CPU busy
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', font: 'var(--type-caption)', color: 'var(--fg-3)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--chart-gpu-busy)' }} /> GPU busy
                  </span>
                </>
              )}
              <div className="hd-segmented">
                <button className={`hd-segmented__opt${units === 'ms' ? ' hd-segmented__opt--active' : ''}`} onClick={() => setUnits('ms')}>ms</button>
                <button className={`hd-segmented__opt${units === 'fps' ? ' hd-segmented__opt--active' : ''}`} onClick={() => setUnits('fps')}>FPS</button>
              </div>
              <label className="hd-switch" style={{ opacity: busyAvailable && units === 'ms' ? 1 : 0.5 }}
                title={!busyAvailable ? 'This capture carries no frame-aligned busy-time telemetry' : units === 'fps' ? 'Busy time is a duration — switch to ms' : undefined}>
                <input type="checkbox" role="switch" checked={busyOn} disabled={!busyAvailable || units === 'fps'} onChange={(e) => setBusy(e.target.checked)} />
                <span className="hd-switch__track"><span className="hd-switch__thumb" /></span>
                <span className="hd-switch__label">Busy time</span>
              </label>
            </div>
          </div>
          <div className="hd-card__body" style={{ padding: 'var(--space-4)' }}>
            <div className="hd-card hd-card--inset" style={{ padding: 'var(--space-3)' }}>
              <FrameTimeChart seed={7} height={260} showStutters={showStutters} showBusy={busyOn} />
            </div>
            {/* §8.6.8 — overlay captions: HAGS qualification while drawn; the
                honest reason when the capture can't support the overlay at all */}
            {busyOn && (
              <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 'var(--space-2)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <Icon n="info" size={13} /> GPU busy timing is HAGS-affected — attribution is approximate. Gaps mark frames the sensor did not report.
              </p>
            )}
            {!busyAvailable && (
              <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 'var(--space-2)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                <Icon n="info" size={13} /> This capture carries no frame-aligned CPU/GPU busy-time telemetry, so the busy-time overlay and bottleneck attribution are unavailable.
              </p>
            )}
            <div style={{ marginTop: 'var(--space-5)' }}>
              <span className="heimdall-overline" style={{ display: 'block', marginBottom: '14px' }}>Smoothness tiers</span>
              <SmoothnessBars confidence="low" />
              {/* §8.6.6 — the grading basis as a visible number, not a tooltip */}
              <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: '12px' }}>
                Graded from <span data-mono>8,971</span> frames — 0.1% lows need <span data-mono>5,000</span>+ for high confidence.
              </p>
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
                <div className="hd-diag__body">
                  <span className="hd-diag__title">CPU bottleneck in town</span>
                  <span className="hd-diag__msg">CPU at 96% while GPU dropped to 61% during the market scene — frames are CPU-bound there.</span>
                  {/* §8.6.4 — structured evidence, collapsed by default, human labels only */}
                  <details style={{ marginTop: '8px' }}>
                    <summary style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', cursor: 'pointer' }}>Evidence</summary>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '8px' }}>
                      <EvidenceRow k="Paired-frame coverage" v="87%" />
                      <EvidenceRow k="Paired samples" v="10,842" />
                      <EvidenceRow k="CPU-bound frames" v="62%" />
                      <EvidenceRow k="GPU-bound frames" v="21%" />
                      <EvidenceRow k="Cap- or display-limited frames" v="9%" />
                    </div>
                    <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                      <span className="hd-tag">CPU busy time</span>
                      <span className="hd-tag">GPU busy time</span>
                    </div>
                    <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: '8px' }}>
                      GPU busy timing is HAGS-affected — attribution is approximate.
                    </p>
                  </details>
                </div>
              </div>
              <div className="hd-diag hd-diag--info">
                <span className="hd-diag__icon"><Icon n="download" size={20} /></span>
                <div className="hd-diag__body">
                  <span className="hd-diag__title">Newer GPU driver available</span>
                  <span className="hd-diag__msg">566.14 installed; 572.16 is the latest game-ready driver. Update may improve RT performance.</span>
                  {/* §8.6.4 — provenance: where the referenced version came from */}
                  <span style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: '6px', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    <a href="#" style={{ color: 'var(--fg-3)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>Source <Icon n="external-link" size={11} /></a>
                    <span data-mono>· 572.16 · fetched Jul 12, 2026</span>
                  </span>
                </div>
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

          {/* §8.6.1 — capture capability: what this capture's source could see,
              and whether bottleneck attribution is on solid ground */}
          <div className="hd-card">
            <div className="hd-card__head"><span className="hd-card__title">Capture capability</span><span className="hd-badge hd-badge--neutral">PresentMon log</span></div>
            <div className="hd-card__body" style={{ paddingTop: 'var(--space-2)' }}>
              <SensorRow k="GPU load" state="aligned" />
              <SensorRow k="GPU clock" state="aligned" />
              <SensorRow k="GPU power" state="periodic" />
              <SensorRow k="VRAM used" state="aligned" />
              <SensorRow k="CPU load" state="absent" />
              <SensorRow k="CPU busy time" state="aligned" />
              <SensorRow k="GPU busy time" state="aligned" />
              <SnapshotRow k="Presentation" v="Hardware flip" />
              <SnapshotRow k="Sync" v="VRR" />
              <SnapshotRow k="Frame generation" v="Observed" />
              <SnapshotRow k="VRAM capacity" v="12 GB" />
              <div className="hd-diag hd-diag--good" style={{ marginTop: 'var(--space-4)' }}>
                <span className="hd-diag__icon"><Icon n="gauge" size={20} /></span>
                <div className="hd-diag__body">
                  <span className="hd-diag__title">Bottleneck data ready</span>
                  <span className="hd-diag__msg">CPU and GPU busy-time telemetry is frame-aligned — bottleneck attribution and the busy-time overlay are available. GPU busy timing is HAGS-affected, so attribution is approximate.</span>
                </div>
              </div>
              <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 'var(--space-3)' }}>
                CPU load was not captured by this source — rules that need it skip, they never fail.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { RunPage });
