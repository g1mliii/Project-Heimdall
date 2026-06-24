// Heimdall Web Hub — Account/management (Phase 8) + Video export (Phase 11).

// ── Account / sign-in + run management + moderation (Phase 8 §20) ──────
function AccountPage() {
  const [runs, setRuns] = React.useState([
    { id: 1, title: 'Cyberpunk 2077 — Ultra RT', vis: 'public', date: 'Mar 14', verified: true },
    { id: 2, title: 'Starfield — New Atlantis', vis: 'unlisted', date: 'Mar 09', verified: false },
    { id: 3, title: 'RDR2 — benchmark scene', vis: 'private', date: 'Feb 28', verified: false },
  ]);
  const setVis = (id, vis) => setRuns((r) => r.map((x) => x.id === id ? { ...x, vis } : x));
  const del = (id) => setRuns((r) => r.filter((x) => x.id !== id));

  return (
    <div style={{ maxWidth: 880, margin: '0 auto', padding: 'var(--space-8) var(--space-6) var(--space-16)' }}>
      <span className="heimdall-overline">Account</span>

      {/* Identity card */}
      <div className="hd-card" style={{ marginTop: 'var(--space-3)' }}>
        <div className="hd-card__body" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <span className="hd-avatar hd-avatar--lg">AL</span>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ font: 'var(--type-subheading)', color: 'var(--fg-1)' }}>Ada Lovelace</span>
              <span className="hd-badge hd-badge--brand"><span className="hd-badge__dot" />Verified reviewer</span>
            </div>
            <p style={{ font: 'var(--type-body-sm)', color: 'var(--fg-3)', marginTop: '2px' }}>ada@example.com · signed in with Clerk</p>
          </div>
          <button className="hd-btn hd-btn--secondary"><Icon n="log-out" size={16} /> Sign out</button>
        </div>
      </div>

      {/* My runs — per-run visibility + delete (§20.2 / §20.4) */}
      <div className="hd-card" style={{ marginTop: 'var(--space-5)' }}>
        <div className="hd-card__head"><span className="hd-card__title">My runs</span><span className="hd-badge hd-badge--neutral">{runs.length}</span></div>
        <div className="hd-card__body" style={{ paddingTop: 'var(--space-2)' }}>
          {runs.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3) 0', borderBottom: '1px solid var(--line-1)', flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <span style={{ font: 'var(--type-body)', color: 'var(--fg-1)', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  {r.title}{r.verified && <Icon n="shield-check" size={14} style={{ color: 'var(--brand-teal)' }} />}
                </span>
                <span data-mono style={{ display: 'block', font: 'var(--type-caption)', color: 'var(--fg-3)' }}>{r.date}</span>
              </div>
              <span className="hd-select" style={{ width: 132 }}>
                <select value={r.vis} onChange={(e) => setVis(r.id, e.target.value)}>
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
                <span className="hd-select__chev"><Icon n="chevron-down" size={16} /></span>
              </span>
              <button className="hd-iconbtn" aria-label="Delete run" onClick={() => del(r.id)}><Icon n="trash-2" size={18} /></button>
            </div>
          ))}
          <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 'var(--space-3)' }}>
            Private runs 404 for everyone but you. Deleting a run also removes its stored frame data from R2.
          </p>
        </div>
      </div>

      {/* Moderation + erasure */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-5)', marginTop: 'var(--space-5)' }}>
        <div className="hd-card"><div className="hd-card__body">
          <span className="heimdall-overline" style={{ display: 'block', marginBottom: 'var(--space-2)' }}>Moderation</span>
          <p style={{ font: 'var(--type-body-sm)', color: 'var(--fg-2)' }}>Spotted an abusive game name or bad-faith upload on the public hub?</p>
          <button className="hd-btn hd-btn--secondary hd-btn--sm" style={{ marginTop: 'var(--space-3)' }}><Icon n="flag" size={15} /> Report content</button>
        </div></div>
        <div className="hd-card"><div className="hd-card__body">
          <span className="heimdall-overline" style={{ display: 'block', marginBottom: 'var(--space-2)' }}>Data & privacy</span>
          <p style={{ font: 'var(--type-body-sm)', color: 'var(--fg-2)' }}>Right to erasure — deleting your account cascades to every run and its R2 objects.</p>
          <button className="hd-btn hd-btn--danger hd-btn--sm" style={{ marginTop: 'var(--space-3)' }}><Icon n="trash-2" size={15} /> Delete account</button>
        </div></div>
      </div>
    </div>
  );
}

// ── Creator video export tool (Phase 11 §27) ──────────────────────────
function ExportPage() {
  const [mode, setMode] = React.useState('transparent'); // transparent | green | png
  const [rendering, setRendering] = React.useState(false);
  const [pct, setPct] = React.useState(0);
  React.useEffect(() => {
    if (!rendering) return;
    setPct(0);
    const id = setInterval(() => setPct((p) => {
      if (p >= 100) { clearInterval(id); setRendering(false); return 100; }
      return p + 4;
    }), 60);
    return () => clearInterval(id);
  }, [rendering]);

  const checker = 'repeating-conic-gradient(#1b212c 0% 25%, #11151d 0% 50%) 50% / 22px 22px';
  const previewBg = mode === 'green' ? '#00b140' : mode === 'png' ? checker : checker;

  return (
    <div style={{ maxWidth: 'var(--container-max)', margin: '0 auto', padding: 'var(--space-8) var(--space-6) var(--space-16)' }}>
      <span className="heimdall-overline">Creator tools</span>
      <h1 style={{ font: 'var(--type-title)', color: 'var(--fg-1)', marginTop: '4px' }}>Export overlay video</h1>
      <p style={{ font: 'var(--type-body)', color: 'var(--fg-2)', marginTop: '4px' }}>Render the scrolling frame-time chart as a transparent or green-screen clip, synced to your gameplay. Encodes in your browser — nothing leaves your machine.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 'var(--space-5)', marginTop: 'var(--space-6)', alignItems: 'start' }}>
        {/* Preview */}
        <div className="hd-card">
          <div className="hd-card__head">
            <span className="hd-card__title">Preview</span>
            <span className="hd-badge hd-badge--neutral">1920 × 1080 · 60 fps</span>
          </div>
          <div className="hd-card__body" style={{ padding: 'var(--space-4)' }}>
            <div style={{ borderRadius: 'var(--radius-md)', overflow: 'hidden', background: previewBg, padding: 'var(--space-6) var(--space-4)', border: '1px solid var(--line-1)' }}>
              <FrameTimeChart seed={4} height={150} fill={true} showStutters={true} />
            </div>
            <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)', marginTop: 'var(--space-3)' }}>
              {mode === 'transparent' && 'Transparent — WebM/VP9 with alpha (checkerboard = empty pixels).'}
              {mode === 'green' && 'Green-screen — solid chroma key; the universal editor fallback (MP4).'}
              {mode === 'png' && 'PNG sequence — zipped frames with alpha, for editors without WebM-alpha.'}
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="hd-card">
          <div className="hd-card__head"><span className="hd-card__title">Output</span></div>
          <div className="hd-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div>
              <span className="heimdall-overline" style={{ display: 'block', marginBottom: 'var(--space-2)' }}>Background</span>
              <div className="hd-segmented" style={{ width: '100%' }} role="group">
                <button className={`hd-segmented__opt${mode === 'transparent' ? ' hd-segmented__opt--active' : ''}`} style={{ flex: 1 }} onClick={() => setMode('transparent')}>Alpha</button>
                <button className={`hd-segmented__opt${mode === 'green' ? ' hd-segmented__opt--active' : ''}`} style={{ flex: 1 }} onClick={() => setMode('green')}>Green</button>
                <button className={`hd-segmented__opt${mode === 'png' ? ' hd-segmented__opt--active' : ''}`} style={{ flex: 1 }} onClick={() => setMode('png')}>PNG seq</button>
              </div>
            </div>
            <label className="hd-switch"><input type="checkbox" role="switch" defaultChecked /><span className="hd-switch__track"><span className="hd-switch__thumb" /></span><span className="hd-switch__label">Sync to gameplay clip</span></label>
            <label className="hd-switch"><input type="checkbox" role="switch" defaultChecked /><span className="hd-switch__track"><span className="hd-switch__thumb" /></span><span className="hd-switch__label">Highlight stutters</span></label>

            {rendering || pct === 100 ? (
              <div className="hd-meter">
                <div className="hd-meter__head"><span className="hd-meter__label">{pct === 100 ? 'Encoded' : 'Encoding (WebCodecs)'}</span><span className="hd-meter__value">{pct}%</span></div>
                <div className="hd-meter__track"><div className="hd-meter__fill" style={{ width: `${pct}%`, background: pct === 100 ? 'var(--good)' : 'var(--brand-teal)' }} /></div>
              </div>
            ) : null}

            {pct === 100 ? (
              <button className="hd-btn hd-btn--primary hd-btn--block"><Icon n="download" size={16} /> Download .{mode === 'png' ? 'zip' : mode === 'green' ? 'mp4' : 'webm'}</button>
            ) : (
              <button className="hd-btn hd-btn--primary hd-btn--block" disabled={rendering} onClick={() => setRendering(true)}>
                {rendering ? 'Rendering…' : <><Icon n="clapperboard" size={16} /> Render in browser</>}
              </button>
            )}
            <p style={{ font: 'var(--type-caption)', color: 'var(--fg-3)' }}>WebCodecs <code style={{ font: 'var(--type-data)' }}>VideoEncoder</code> where available; falls back to a PNG sequence otherwise.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { AccountPage, ExportPage });
