// Heimdall Web Hub — shared app chrome (top bar + footer).
const Icon = ({ n, size, style, ...p }) => (
  <i data-lucide={n} style={{ width: size || 18, height: size || 18, ...style }} {...p} />
);

function TopBar({ route, onNavigate, onUpload }) {
  const nav = [
    { id: 'run', label: 'Run report' },
    { id: 'game', label: 'Games' },
    { id: 'compare', label: 'Compare' },
  ];
  return (
    <header style={{
      height: 'var(--topbar-h)', display: 'flex', alignItems: 'center', gap: 'var(--space-6)',
      padding: '0 var(--space-6)', borderBottom: '1px solid var(--line-1)',
      background: 'color-mix(in srgb, var(--bg-base) 82%, transparent)',
      backdropFilter: 'var(--blur-md)', position: 'sticky', top: 0, zIndex: 20,
    }}>
      <a onClick={() => onNavigate('run')} style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
        <img src="../../assets/logo-mark.svg" width="28" height="28" alt="" />
        <span style={{ font: 'var(--type-subheading)', fontWeight: 'var(--weight-bold)', letterSpacing: 'var(--tracking-tight)', color: 'var(--fg-1)' }}>Heimdall</span>
      </a>
      <nav style={{ display: 'flex', gap: '2px', marginLeft: 'var(--space-2)' }}>
        {nav.map((n) => (
          <button key={n.id} className={`hd-tab${route === n.id ? ' hd-tab--active' : ''}`} onClick={() => onNavigate(n.id)} style={{ padding: '0 12px', height: '34px', whiteSpace: 'nowrap' }}>
            {n.label}
          </button>
        ))}
      </nav>
      <div style={{ flex: 1 }} />
      <div className="hd-input__wrap" style={{ width: 220 }}>
        <span className="hd-input__icon"><Icon n="search" size={16} /></span>
        <input className="hd-input" placeholder="Search games, GPUs…" style={{ height: '36px' }} />
      </div>
      <button className="hd-btn hd-btn--primary" onClick={onUpload}>
        <Icon n="upload" size={16} /> Upload log
      </button>
      <button className="hd-iconbtn hd-iconbtn--solid" aria-label="Account" onClick={() => onNavigate('account')}><Icon n="user" size={18} /></button>
    </header>
  );
}

Object.assign(window, { TopBar, Icon });
