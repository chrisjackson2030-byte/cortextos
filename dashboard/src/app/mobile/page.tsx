'use client';

// Mobile-first CHECK-IN dashboard — built for the phone from scratch (not a
// reflowed desktop page). For B when he's out: the money (predictions + options),
// decisions waiting on him, whether the system is running or something's broken,
// and what we're working on. Reuses the existing data APIs — no extra backend.

import { useEffect, useState } from 'react';

interface TradeStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
}
interface StrategyAllocation {
  display_name: string;
  current_value: number;
  realized_pnl: number;
  wins: number;
  losses: number;
}
interface TradingData {
  live: TradeStats;
  kalshiAccount: { total_value: number; net_pnl: number } | null;
  allocation: { strategies: StrategyAllocation[] } | null;
  todayLiveNet: number;
  recentTrades: { lane: string; direction: string; pnl: number; closedAt: string }[];
  paperLanes: { lane: string; net: number; wins: number; losses: number }[];
}
interface OptionsData {
  status: string;
  kill_switch?: { armed: boolean };
  account?: { status: string; equity: number; options_level?: number } | null;
}
interface FleetAgent {
  name: string;
  status: string;
}
interface StatusData {
  fleet: FleetAgent[];
}
interface Approval {
  id: string;
  title?: string;
  question?: string;
}
interface ActiveTask {
  title: string;
  agent?: string;
}

const fmt$ = (n: number | null | undefined) =>
  n == null ? '--' : `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
const fmtBal = (n: number | null | undefined) => (n == null ? '--' : `$${n.toFixed(2)}`);
const green = '#00FF88';
const red = '#FF4D4D';
const dim = 'rgba(224,240,255,0.5)';

// Hamburger nav — jump to any full dashboard page from the mobile check-in.
const NAV: { label: string; href: string }[] = [
  { label: 'Overview', href: '/' },
  { label: 'Prediction Markets', href: '/predictions' },
  { label: 'Options', href: '/options' },
  { label: 'Voice (Jarvis)', href: '/voice' },
  { label: 'Activity', href: '/activity' },
  { label: 'Agents', href: '/agents' },
  { label: 'Tasks', href: '/tasks' },
  { label: 'Approvals', href: '/approvals' },
  { label: 'Strategy', href: '/strategy' },
  { label: 'New Ideas', href: '/new-ideas' },
  { label: 'Connections', href: '/connections' },
  { label: 'Throwback', href: '/throwback' },
];

function Card({ title, accent, children }: { title: string; accent?: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${accent || 'rgba(255,255,255,0.08)'}`,
        borderRadius: 16,
        padding: 16,
        marginBottom: 12,
      }}
    >
      <div style={{ fontSize: 11, letterSpacing: '0.18em', textTransform: 'uppercase', color: dim, marginBottom: 10 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export default function MobilePage() {
  const [trading, setTrading] = useState<TradingData | null>(null);
  const [options, setOptions] = useState<OptionsData | null>(null);
  const [status, setStatus] = useState<StatusData | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tasks, setTasks] = useState<ActiveTask[]>([]);
  const [updated, setUpdated] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const load = () => {
      fetch('/api/voice/trading').then((r) => r.json()).then(setTrading).catch(() => {});
      fetch('/api/options').then((r) => r.json()).then(setOptions).catch(() => {});
      fetch('/api/voice/status').then((r) => r.json()).then(setStatus).catch(() => {});
      fetch('/api/voice/tasks').then((r) => r.json()).then((d) => setTasks(d?.tasks || [])).catch(() => {});
      fetch('/api/approvals?status=pending&org=main')
        .then((r) => r.json())
        .then((d) => setApprovals(Array.isArray(d) ? d : d?.approvals || []))
        .catch(() => {});
      setUpdated(new Date().toLocaleTimeString());
    };
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  const optLive = options?.status === 'LIVE' && !options?.kill_switch?.armed;
  const optHalted = options?.kill_switch?.armed || options?.status === 'HALTED';
  const staleAgents = (status?.fleet || []).filter((a) => a.status === 'STALE' && !['atlas', 'hermes', 'analyst', '_phase2_drafts'].includes(a.name.toLowerCase()));
  const online = (status?.fleet || []).filter((a) => a.status === 'ONLINE').length;
  const systemOk = !optHalted && staleAgents.length === 0;

  return (
    <div style={{ maxWidth: 520, margin: '0 auto', padding: '14px 14px 56px', color: '#E0F0FF', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <span style={{ fontSize: 18, fontWeight: 700 }}>Jarvis · Check-in</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 11, color: dim }}>{updated || '…'}</span>
          <button
            onClick={() => setMenuOpen(true)}
            aria-label="menu"
            style={{ background: 'none', border: 'none', color: '#E0F0FF', fontSize: 24, lineHeight: 1, padding: 6, cursor: 'pointer' }}
          >
            ☰
          </button>
        </div>
      </div>

      {/* Slide-out nav — reach any full page from the check-in */}
      {menuOpen && (
        <div
          onClick={() => setMenuOpen(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 50 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute', top: 0, right: 0, width: '74%', maxWidth: 300, height: '100%',
              background: '#0D1320', borderLeft: '1px solid rgba(255,255,255,0.1)',
              padding: '18px 14px', overflowY: 'auto', WebkitOverflowScrolling: 'touch',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <span style={{ fontSize: 12, letterSpacing: '0.15em', textTransform: 'uppercase', color: dim }}>Pages</span>
              <button onClick={() => setMenuOpen(false)} style={{ background: 'none', border: 'none', color: '#E0F0FF', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            {NAV.map((n) => (
              <a
                key={n.href}
                href={n.href}
                style={{ display: 'block', padding: '13px 8px', color: '#E0F0FF', fontSize: 15, borderBottom: '1px solid rgba(255,255,255,0.06)', textDecoration: 'none' }}
              >
                {n.label}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* MONEY — predictions */}
      <Card title="Prediction Markets — LIVE">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 28, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: (trading?.live.netPnl ?? 0) >= 0 ? green : red }}>
              {fmt$(trading?.live.netPnl)}
            </div>
            <div style={{ fontSize: 12, color: dim, marginTop: 2 }}>
              {trading?.live ? `${trading.live.wins}W / ${trading.live.losses}L · ${trading.live.winRate}% win` : '…'}
            </div>
            <div style={{ fontSize: 13, marginTop: 4, color: dim }}>
              today <span style={{ color: (trading?.todayLiveNet ?? 0) >= 0 ? green : red, fontWeight: 700 }}>{fmt$(trading?.todayLiveNet)}</span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtBal(trading?.kalshiAccount?.total_value)}</div>
            <div style={{ fontSize: 11, color: dim }}>in account · all-time</div>
          </div>
        </div>
        {trading?.allocation?.strategies?.length ? (
          <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 8 }}>
            {trading.allocation.strategies.map((s) => (
              <div key={s.display_name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                <span>{s.display_name}</span>
                <span style={{ color: dim }}>
                  {fmtBal(s.current_value)} · <span style={{ color: s.realized_pnl >= 0 ? green : red }}>{fmt$(s.realized_pnl)}</span> · {s.wins}W/{s.losses}L
                </span>
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {/* MONEY — options */}
      <Card title="Options Bot" accent={optHalted ? 'rgba(255,77,77,0.4)' : undefined}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 800 }}>{fmtBal(options?.account?.equity)}</div>
            <div style={{ fontSize: 12, color: dim, marginTop: 2 }}>
              equity{options?.account?.options_level ? ` · level ${options.account.options_level}` : ''}
            </div>
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              padding: '4px 10px',
              borderRadius: 8,
              color: optLive ? green : optHalted ? red : '#FFB800',
              background: optLive ? 'rgba(0,255,136,0.12)' : optHalted ? 'rgba(255,77,77,0.12)' : 'rgba(255,184,0,0.12)',
            }}
          >
            {optHalted ? 'HALTED' : options?.status || '…'}
          </div>
        </div>
      </Card>

      {/* Recent live fills */}
      {trading?.recentTrades?.length ? (
        <Card title="Recent Live Trades">
          {trading.recentTrades.map((t, i) => {
            const ago = Math.max(0, Math.round((Date.now() - new Date(t.closedAt).getTime()) / 60000));
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 5 }}>
                <span>
                  {t.lane} <span style={{ color: dim }}>{(t.direction || '').toUpperCase()}</span>
                </span>
                <span>
                  <span style={{ color: t.pnl >= 0 ? green : red, fontWeight: 700 }}>{fmt$(t.pnl)}</span>
                  <span style={{ color: dim, marginLeft: 8 }}>{ago < 60 ? `${ago}m` : `${Math.round(ago / 60)}h`} ago</span>
                </span>
              </div>
            );
          })}
        </Card>
      ) : null}

      {/* Paper lanes — other strategies being tested */}
      {trading?.paperLanes?.length ? (
        <Card title="Paper Lanes (testing)">
          {trading.paperLanes.map((l) => (
            <div key={l.lane} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
              <span>{l.lane}</span>
              <span>
                <span style={{ color: l.net >= 0 ? green : red, fontWeight: 700 }}>{fmt$(l.net)}</span>
                <span style={{ color: dim, marginLeft: 8 }}>{l.wins}W/{l.losses}L</span>
              </span>
            </div>
          ))}
        </Card>
      ) : null}

      {/* NEEDS YOU */}
      <Card title="Needs You" accent={approvals.length ? 'rgba(255,184,0,0.4)' : undefined}>
        {approvals.length ? (
          approvals.slice(0, 5).map((a) => (
            <div key={a.id} style={{ fontSize: 13, marginBottom: 6, color: '#FFD980' }}>
              • {a.title || a.question || 'Pending decision'}
            </div>
          ))
        ) : (
          <div style={{ fontSize: 13, color: green }}>Nothing waiting on you ✓</div>
        )}
      </Card>

      {/* SYSTEM */}
      <Card title="System" accent={systemOk ? undefined : 'rgba(255,77,77,0.4)'}>
        <div style={{ fontSize: 15, fontWeight: 700, color: systemOk ? green : red, marginBottom: 6 }}>
          {systemOk ? 'All running clean ✓' : 'Needs attention ⚠'}
        </div>
        <div style={{ fontSize: 12, color: dim }}>
          {online} agents online{staleAgents.length ? ` · ${staleAgents.length} stale: ${staleAgents.map((a) => a.name).join(', ')}` : ''}
          {optHalted ? ' · options HALTED' : ''}
        </div>
      </Card>

      {/* WORKING ON */}
      <Card title="Working On">
        {tasks.length ? (
          tasks.slice(0, 5).map((t, i) => (
            <div key={i} style={{ fontSize: 13, marginBottom: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              • {t.title}
              {t.agent ? <span style={{ color: dim }}> — {t.agent}</span> : null}
            </div>
          ))
        ) : (
          <div style={{ fontSize: 13, color: dim }}>Nothing active right now</div>
        )}
      </Card>
    </div>
  );
}
