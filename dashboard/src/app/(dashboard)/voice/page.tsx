'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import s from './voice.module.css';

interface VoiceExchange {
  id: string;
  userText: string;
  tldr: string;
  full: string;
  ts: string;
}

interface VoiceOption {
  id: string;
  name: string;
  accent: string;
  gender: string;
  description: string;
  active: boolean;
  installed: boolean;
}

interface FleetAgent {
  name: string;
  status: string;
  minutesAgo: number;
  task: string;
}

interface PendingItem {
  title: string;
  detail: string;
  source: string; // 'approval' | 'decision' | 'open-question'
  ageDays: number | null;
}

interface StatusData {
  completedToday: { count: number; titles: string[] };
  pendingItems: PendingItem[];
  fleet: FleetAgent[];
  focus: string;
  focusSetAt: string | null;
  focusAgeHours: number | null;
  northStar: string;
}

interface TradeStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  lastTrade: { pnl: number; lane: string; direction: string; closedAt: string } | null;
}

interface StrategyAllocation {
  strategy_id: string;
  display_name: string;
  deposited: number;
  fee_drag: number;
  realized_pnl: number;
  current_value: number;
  wins: number;
  losses: number;
  pct_of_account: number | null;
}

interface TradingData {
  live: TradeStats;
  paper: TradeStats;
  kalshiAccount: { cash: number; total_value: number; deposit: number; net_pnl: number } | null;
  allocation: { strategies: StrategyAllocation[]; reconciliation: { drift: number | null } } | null;
}

interface OptionsData {
  status: string;
  kill_switch: { armed: boolean };
  account: { status: string; equity: number; options_buying_power: number; options_level: number | null } | null;
  summary: { open_positions: number; filled: number; failed: number; total_signals: number };
}

interface ActiveTask {
  id: string;
  assignee: string;
  title: string;
  description: string;
  priority: string;
  updatedAt: string | null;
}

interface EdgeFamily {
  family: string;
  arena: string;
  verdict: string;
  reason: string;
}

interface EdgeEngineData {
  available: boolean;
  generated_at?: string;
  attempts_logged?: number;
  families_tested?: EdgeFamily[];
  proven_edges?: number;
  live_lead?: string;
  scoreboard?: string;
  data_cost?: string;
}

type VoiceState = 'idle' | 'listening' | 'processing' | 'speaking';

/* eslint-disable @typescript-eslint/no-explicit-any */
type SpeechRecognitionCompat = any;

export default function VoicePage() {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceActive, setVoiceActive] = useState(false);
  const [exchanges, setExchanges] = useState<VoiceExchange[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [latestTldr, setLatestTldr] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [currentVoice, setCurrentVoice] = useState('en_US-ryan-high');
  const [speed, setSpeed] = useState(1.2);
  const [showVoiceMenu, setShowVoiceMenu] = useState(false);
  const [statusData, setStatusData] = useState<StatusData | null>(null);
  const [expandedPanelItem, setExpandedPanelItem] = useState<string | null>(null);
  const [hudTime, setHudTime] = useState('');
  const [tradingData, setTradingData] = useState<TradingData | null>(null);
  const [optionsData, setOptionsData] = useState<OptionsData | null>(null);
  const [activeTasks, setActiveTasks] = useState<ActiveTask[]>([]);
  const [edgeData, setEdgeData] = useState<EdgeEngineData | null>(null);
  const [brainData, setBrainData] = useState<{
    ideas: { title: string; source: string; daysSince: number | null }[];
    throwback: { title: string; source: string; daysSince: number | null } | null;
  } | null>(null);

  const recognitionRef = useRef<SpeechRecognitionCompat | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const voiceStateRef = useRef<VoiceState>('idle');
  const voiceActiveRef = useRef(false);
  const seqRef = useRef(0);

  useEffect(() => {
    voiceStateRef.current = voiceState;
  }, [voiceState]);

  useEffect(() => {
    voiceActiveRef.current = voiceActive;
  }, [voiceActive]);

  useEffect(() => {
    if (!(window as any).SpeechRecognition && !(window as any).webkitSpeechRecognition) {
      setSpeechSupported(false);
    }
  }, []);

  useEffect(() => {
    fetch('/api/voice/config')
      .then((r) => r.json())
      .then((data: { current: string; speed: number; voices: VoiceOption[] }) => {
        setVoices(data.voices);
        setCurrentVoice(data.current);
        if (data.speed) setSpeed(data.speed);
      })
      .catch(() => {});

    const loadStatus = () => {
      fetch('/api/voice/status')
        .then((r) => r.json())
        .then((data: StatusData) => setStatusData(data))
        .catch(() => {});
    };
    loadStatus();
    const statusInterval = setInterval(loadStatus, 30000);

    const loadTrading = () => {
      fetch('/api/voice/trading')
        .then((r) => r.json())
        .then((data: TradingData) => setTradingData(data))
        .catch(() => {});
    };
    loadTrading();
    const tradingInterval = setInterval(loadTrading, 15000);

    const loadBrain = () => {
      fetch('/api/voice/brain')
        .then((r) => r.json())
        .then((data) => setBrainData(data))
        .catch(() => {});
    };
    loadBrain();
    const brainInterval = setInterval(loadBrain, 120000);

    const loadOptions = () => {
      fetch('/api/options')
        .then((r) => r.json())
        .then((data: OptionsData) => setOptionsData(data))
        .catch(() => {});
    };
    loadOptions();
    const optionsInterval = setInterval(loadOptions, 30000);

    const loadEdge = () => {
      fetch('/api/edge-engine')
        .then((r) => r.json())
        .then((data: EdgeEngineData) => setEdgeData(data))
        .catch(() => {});
    };
    loadEdge();
    const edgeInterval = setInterval(loadEdge, 60000);

    const loadTasks = () => {
      fetch('/api/voice/tasks')
        .then((r) => r.json())
        .then((data: { tasks: ActiveTask[] }) => setActiveTasks(data.tasks))
        .catch(() => {});
    };
    loadTasks();
    const tasksInterval = setInterval(loadTasks, 30000);

    const updateClock = () => {
      const now = new Date();
      const h = now.getHours().toString().padStart(2, '0');
      const m = now.getMinutes().toString().padStart(2, '0');
      const sec = now.getSeconds().toString().padStart(2, '0');
      setHudTime(`${h}:${m}:${sec}`);
    };
    updateClock();
    const clockInterval = setInterval(updateClock, 1000);

    return () => {
      clearInterval(statusInterval);
      clearInterval(clockInterval);
      clearInterval(tradingInterval);
      clearInterval(brainInterval);
      clearInterval(optionsInterval);
      clearInterval(edgeInterval);
      clearInterval(tasksInterval);
    };
  }, []);

  const updateConfig = useCallback(async (updates: { voice?: string; speed?: number }) => {
    try {
      const res = await fetch('/api/voice/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (res.ok) {
        const data = (await res.json()) as { current: string; speed: number };
        setCurrentVoice(data.current);
        setSpeed(data.speed);
        setVoices((prev) => prev.map((v) => ({ ...v, active: v.id === data.current })));
      }
    } catch { /* ignore */ }
  }, []);

  const changeVoice = useCallback(async (voiceId: string) => {
    await updateConfig({ voice: voiceId });
    setShowVoiceMenu(false);
  }, [updateConfig]);

  const togglePanelItem = useCallback((key: string) => {
    setExpandedPanelItem((prev) => (prev === key ? null : key));
  }, []);

  const speedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changeSpeed = useCallback((newSpeed: number) => {
    setSpeed(newSpeed);
    if (speedTimerRef.current) clearTimeout(speedTimerRef.current);
    speedTimerRef.current = setTimeout(() => updateConfig({ speed: newSpeed }), 300);
  }, [updateConfig]);

  useEffect(() => {
    if (conversationRef.current) {
      conversationRef.current.scrollTop = conversationRef.current.scrollHeight;
    }
  }, [exchanges, expandedId]);

  const startListeningRef = useRef<() => void>(() => {});

  const sendToJarvis = useCallback(async (text: string) => {
    setVoiceState('processing');
    setCurrentTranscript('');

    try {
      const res = await fetch('/api/voice/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, history: historyRef.current }),
      });

      if (!res.ok) throw new Error('API error');
      const data = (await res.json()) as { tldr: string; full: string; ts: string; deep?: boolean };

      historyRef.current.push({ role: 'user', content: text });
      historyRef.current.push({ role: 'assistant', content: data.full || data.tldr });
      if (historyRef.current.length > 40) {
        historyRef.current = historyRef.current.slice(-40);
      }

      seqRef.current += 1;
      const exchange: VoiceExchange = {
        id: `v-${seqRef.current}`,
        userText: text,
        tldr: data.tldr,
        full: data.deep ? `${data.full}\n\n[Opus deep analysis running in background...]` : data.full,
        ts: data.ts,
      };

      setExchanges((prev) => [...prev.slice(-19), exchange]);
      setLatestTldr(data.deep ? `${data.tldr} (deep analysis coming...)` : data.tldr);
      setVoiceState('speaking');
      setTimeout(() => {
        if (voiceActiveRef.current) {
          startListeningRef.current();
        } else {
          setVoiceState('idle');
        }
      }, 8000);
    } catch {
      if (voiceActiveRef.current) {
        setLatestTldr('Something went wrong. Listening again...');
        setTimeout(() => startListeningRef.current(), 1000);
      } else {
        setVoiceState('idle');
        setLatestTldr('Something went wrong. Try again.');
      }
    }
  }, []);

  const startListening = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.lang = 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalSent = false;

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setCurrentTranscript(transcript);

      const lastResult = event.results[event.results.length - 1];
      if (lastResult.isFinal && transcript.trim() && !finalSent) {
        finalSent = true;
        sendToJarvis(transcript.trim());
      }
    };

    recognition.onerror = () => {
      if (voiceActiveRef.current) {
        setTimeout(() => startListeningRef.current(), 500);
      } else {
        setVoiceState('idle');
        setCurrentTranscript('');
      }
    };

    recognition.onend = () => {
      if (voiceStateRef.current === 'listening' && voiceActiveRef.current) {
        setTimeout(() => startListeningRef.current(), 300);
      } else if (voiceStateRef.current === 'listening') {
        setVoiceState('idle');
        setCurrentTranscript('');
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
    setVoiceState('listening');
    setCurrentTranscript('');
  }, [sendToJarvis]);

  useEffect(() => {
    startListeningRef.current = startListening;
  }, [startListening]);

  const toggleVoice = useCallback(() => {
    if (voiceActive) {
      recognitionRef.current?.stop();
      setVoiceActive(false);
      setVoiceState('idle');
      setCurrentTranscript('');
      return;
    }

    setVoiceActive(true);
    startListening();
  }, [voiceActive, startListening]);

  const statusLabel: Record<VoiceState, string> = {
    idle: 'CLICK ORB TO SPEAK',
    listening: 'LISTENING',
    processing: 'THINKING',
    speaking: 'SPEAKING',
  };

  const statusColor: Record<VoiceState, string> = {
    idle: '#4A6A8A',
    listening: '#00FF88',
    processing: '#FFB800',
    speaking: '#00D4FF',
  };

  const orbCoreClass = [
    s.orbCore,
    voiceState === 'listening' && s.orbCoreListening,
    voiceState === 'processing' && s.orbCoreProcessing,
    voiceState === 'speaking' && s.orbCoreSpeaking,
  ]
    .filter(Boolean)
    .join(' ');

  const orbGlowClass = [
    s.orbGlow,
    voiceState === 'listening' && s.orbGlowListening,
    voiceState === 'processing' && s.orbGlowProcessing,
    voiceState === 'speaking' && s.orbGlowSpeaking,
  ]
    .filter(Boolean)
    .join(' ');

  const statusDotClass = [
    s.statusDot,
    voiceState === 'listening' && s.statusDotListening,
    voiceState === 'processing' && s.statusDotProcessing,
  ]
    .filter(Boolean)
    .join(' ');

  const pnlColor = (n: number) => (n >= 0 ? '#00FF88' : '#FF4444');
  const fmtPnl = (n: number) => `${n >= 0 ? '+' : ''}$${Math.abs(n).toFixed(2)}`;

  // Hours since an ISO timestamp; null if unparseable.
  const hoursSince = (iso?: string | null): number | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 3.6e6));
  };
  const fmtAge = (h: number | null): string => {
    if (h === null) return '?';
    if (h < 1) return '<1h';
    if (h < 48) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };
  // Staleness chip — green when fresh, amber when stale, so silent staleness
  // is visible instead of invisible (the old panels just froze with green dots).
  const ageChip = (h: number | null, staleAfterH = 24) => (
    <span
      style={{
        fontSize: '10px',
        padding: '1px 6px',
        borderRadius: '3px',
        letterSpacing: '0.1em',
        color: h !== null && h > staleAfterH ? '#FFB800' : 'rgba(224,240,255,0.55)',
        border: `1px solid ${h !== null && h > staleAfterH ? 'rgba(255,184,0,0.4)' : 'rgba(224,240,255,0.18)'}`,
      }}
    >
      {fmtAge(h)} AGO
    </span>
  );
  // Panel header that drills down to its detail page.
  const panelHeader = (label: string, href: string, chip?: React.ReactNode) => (
    <div className={s.hudPanelHeader} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <Link href={href} style={{ color: 'inherit', textDecoration: 'none' }} title={`Open ${href}`}>
        {label} <span style={{ opacity: 0.55 }}>›</span>
      </Link>
      {chip}
    </div>
  );

  const verdictColor = (v: string) =>
    v.startsWith('PROMISING') || v === 'CONFIRMED' ? '#00FF88' : v === 'VALIDATING' ? '#FFB800' : '#FF4444';

  const sourceChipStyle = (src: string): React.CSSProperties => ({
    fontSize: '9px',
    padding: '1px 5px',
    borderRadius: '3px',
    letterSpacing: '0.12em',
    textTransform: 'uppercase' as const,
    color: src === 'approval' ? '#FFB800' : src === 'decision' ? '#00D4FF' : '#B0D0E8',
    border: `1px solid ${src === 'approval' ? 'rgba(255,184,0,0.4)' : src === 'decision' ? 'rgba(0,212,255,0.35)' : 'rgba(176,208,232,0.3)'}`,
    flexShrink: 0,
  });

  // Click-to-expand text: collapsed = clean line-clamp (never a mid-line cut),
  // long text gets a visible "more/less" affordance. threshold ≈ chars that fit
  // the collapsed clamp — under it we render plain (no fake affordance).
  const expandableText = (
    key: string,
    text: string,
    opts: { clamp?: 'clamp1' | 'clamp2' | 'clamp4'; threshold?: number; className?: string; style?: React.CSSProperties } = {},
  ) => {
    const { clamp = 'clamp2', threshold = 70, className = '', style } = opts;
    const isExpanded = expandedPanelItem === key;
    const long = text.length > threshold;
    if (!long) {
      return <div className={className} style={style}>{text}</div>;
    }
    return (
      <div onClick={(e) => { e.stopPropagation(); togglePanelItem(key); }} style={{ cursor: 'pointer' }} title={isExpanded ? 'Click to collapse' : 'Click to expand'}>
        <div className={`${isExpanded ? '' : s[clamp]} ${className}`} style={style}>{text}</div>
        <div className={s.expandHint}>{isExpanded ? '▾ less' : '▸ more'}</div>
      </div>
    );
  };

  /* ── Panels (consts so desktop columns + the <lg stacked layout share JSX) ── */

  // MONEY — Alpaca options bot first (live), Kalshi second with an explicit FROZEN chip.
  const moneyPanel = (
          <div className={s.hudPanelBracketed}>
            {panelHeader('MONEY', '/options')}
            <div style={{ fontFamily: 'var(--font-jetbrains)' }}>
              {/* Options bot — LIVE (Alpaca account + bot status) */}
              <div style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <span style={{ color: '#00D4FF', fontSize: '12px', letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 600 }}>
                    Options · Alpaca
                  </span>
                  {optionsData ? (
                    <span style={{
                      color: optionsData.kill_switch?.armed ? '#FF4444' : optionsData.status === 'LIVE' ? '#00FF88' : '#FFB800',
                      fontWeight: 600, fontSize: '12px',
                    }}>
                      {optionsData.kill_switch?.armed ? 'HALTED' : optionsData.status}
                    </span>
                  ) : null}
                </div>
                {optionsData?.account ? (
                  <>
                    <div style={{ fontSize: '30px', fontWeight: 700, color: '#E0F0FF', lineHeight: 1.05 }}>
                      ${optionsData.account.equity.toLocaleString()}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'rgba(224,240,255,0.7)', fontSize: '12px', marginTop: '5px' }}>
                      <span>${optionsData.account.options_buying_power.toLocaleString()} BP
                        {optionsData.account.options_level != null ? ` · L${optionsData.account.options_level}` : ''}</span>
                      <span>{optionsData.summary?.open_positions ?? 0} open · {optionsData.summary?.filled ?? 0} filled</span>
                    </div>
                  </>
                ) : (
                  <div style={{ color: 'rgba(224,240,255,0.45)', fontSize: '13px' }}>
                    {optionsData ? 'No account snapshot' : 'Loading...'}
                  </div>
                )}
              </div>

              {/* Kalshi — frozen by B's call 06-03; chip says so instead of a green dot */}
              <div style={{ borderTop: '1px solid rgba(255,184,0,0.15)', paddingTop: '10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '5px' }}>
                  <span style={{ color: 'rgba(224,240,255,0.65)', fontSize: '11px', letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 600 }}>
                    Sidewinder · Kalshi
                  </span>
                  <span style={{
                    fontSize: '10px', padding: '1px 6px', borderRadius: '3px', letterSpacing: '0.1em',
                    color: '#FFB800', border: '1px solid rgba(255,184,0,0.4)', fontWeight: 600,
                  }}>
                    FROZEN 06-03
                  </span>
                </div>
                {tradingData ? (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: '12px', color: 'rgba(224,240,255,0.6)' }}>
                    <span>
                      <span style={{ color: pnlColor(tradingData.live.netPnl), fontWeight: 700 }}>{fmtPnl(tradingData.live.netPnl)}</span>
                      {' '}· {tradingData.live.total} trades · {tradingData.live.wins}W/{tradingData.live.losses}L
                    </span>
                    {tradingData.kalshiAccount && (
                      <span style={{ color: '#E0F0FF', fontWeight: 600 }}>
                        ${tradingData.kalshiAccount.total_value.toFixed(2)}
                      </span>
                    )}
                  </div>
                ) : (
                  <p className={s.hudPanelText}>Loading...</p>
                )}
              </div>
            </div>
          </div>
  );

  // EDGE ENGINE — the live hunt (edge-engine-state.json, regenerated each drive cycle).
  const edgePanel = (
          <div className={s.hudPanelBracketed}>
            {panelHeader('EDGE ENGINE', '/edge-engine', ageChip(hoursSince(edgeData?.generated_at)))}
            {edgeData?.available ? (
              <div style={{ fontFamily: 'var(--font-jetbrains)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ fontSize: '26px', fontWeight: 700, color: '#E0F0FF', lineHeight: 1.05 }}>
                    {edgeData.attempts_logged ?? 0}
                  </span>
                  <span style={{ fontSize: '11px', color: 'rgba(224,240,255,0.55)' }}>attempts logged</span>
                </div>
                <div style={{ display: 'flex', gap: '12px', fontSize: '12px', marginTop: '5px' }}>
                  <span style={{ color: '#00FF88' }}>
                    {(edgeData.families_tested ?? []).filter((f) => f.verdict.startsWith('PROMISING')).length} promising
                  </span>
                  <span style={{ color: '#FF4444' }}>
                    {(edgeData.families_tested ?? []).filter((f) => f.verdict === 'REJECT').length} rejected
                  </span>
                  <span style={{ color: 'rgba(224,240,255,0.6)' }}>{edgeData.proven_edges ?? 0} proven</span>
                </div>
                {edgeData.live_lead && (
                  <div style={{ marginTop: '7px' }}>
                    {expandableText('edge-lead', edgeData.live_lead, {
                      clamp: 'clamp2',
                      threshold: 80,
                      style: { fontSize: '11px', color: 'rgba(224,240,255,0.75)', lineHeight: 1.45 },
                    })}
                  </div>
                )}
                {(edgeData.families_tested ?? []).length > 0 && (
                  <div style={{ marginTop: '8px', paddingTop: '7px', borderTop: '1px solid rgba(0,212,255,0.1)' }}>
                    {(edgeData.families_tested ?? []).map((f, i) => {
                      const key = `family-${i}`;
                      const isExpanded = expandedPanelItem === key;
                      return (
                        <div key={key} onClick={() => togglePanelItem(key)} style={{ cursor: 'pointer', padding: '5px 0' }} title="Click for verdict reason">
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11px' }}>
                            <span style={isExpanded
                              ? { color: '#E0F0FF' }
                              : { color: '#E0F0FF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {f.family.replace(/_/g, ' ')} <span style={{ color: 'rgba(224,240,255,0.4)' }}>· {f.arena}</span>
                            </span>
                            <span style={{ color: verdictColor(f.verdict), flexShrink: 0, fontWeight: 600 }}>
                              {f.verdict.startsWith('PROMISING') ? 'LEAD' : f.verdict}
                            </span>
                          </div>
                          {isExpanded && (
                            <div style={{ fontSize: '11px', color: 'rgba(224,240,255,0.6)', marginTop: '2px', lineHeight: 1.4 }}>
                              {f.reason}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : (
              <p className={s.hudPanelText}>{edgeData ? 'State file unavailable' : 'Loading...'}</p>
            )}
          </div>
  );

  // ACTIVE TASKS — structured JSON feed; rows expand to full detail
  const tasksPanel = (
          <div className={s.hudPanelBracketed}>
            {panelHeader('ACTIVE TASKS', '/tasks')}
            {activeTasks.length > 0 ? (
              activeTasks.slice(0, 6).map((task, i) => {
                const key = `task-${task.id || i}`;
                const isExpanded = expandedPanelItem === key;
                return (
                  <div
                    key={task.id || i}
                    onClick={() => togglePanelItem(key)}
                    title="Click for task detail"
                    style={{
                      fontFamily: 'var(--font-jetbrains)',
                      fontSize: '13px',
                      padding: '9px 0',
                      cursor: 'pointer',
                      borderBottom: i < Math.min(activeTasks.length, 6) - 1 ? '1px solid rgba(0,212,255,0.08)' : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#00D4FF', fontSize: '12px', textTransform: 'capitalize', letterSpacing: '0.05em' }}>
                        {task.assignee}
                      </span>
                      {task.updatedAt && (
                        <span style={{ color: 'rgba(224,240,255,0.4)', fontSize: '10px' }}>
                          {fmtAge(hoursSince(task.updatedAt))}
                        </span>
                      )}
                    </div>
                    <div
                      className={isExpanded ? undefined : s.clamp2}
                      style={{ color: 'rgba(224,240,255,0.85)', marginTop: '3px', lineHeight: '1.45' }}
                    >
                      {task.title}
                    </div>
                    {isExpanded && (
                      <div style={{ marginTop: '5px', fontSize: '11px', color: 'rgba(224,240,255,0.6)', lineHeight: 1.5 }}>
                        {task.description && <div style={{ marginBottom: '4px' }}>{task.description}</div>}
                        <div style={{ color: 'rgba(224,240,255,0.4)' }}>
                          {task.id} · {task.priority || 'normal'}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <p className={s.hudPanelText}>No active tasks</p>
            )}
          </div>
  );

  // FLEET STATUS — task lines expand in place
  const fleetPanel = (
          <div className={s.hudPanelBracketed}>
            {panelHeader('FLEET STATUS', '/agents')}
            {statusData?.fleet && statusData.fleet.length > 0 ? (
              statusData.fleet.map((a) => (
                <div key={a.name}>
                  <div className={s.hudFleetRow}>
                    <span className={a.status === 'ONLINE' ? s.hudDotOnline : s.hudDotStale} />
                    <span className={s.hudFleetName}>{a.name}</span>
                    <span className={s.hudFleetAgo}>{a.minutesAgo}m</span>
                  </div>
                  {a.task && (
                    <div className={s.hudFleetTask}>
                      {expandableText(`fleet-${a.name}`, a.task, { clamp: 'clamp2', threshold: 80 })}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <p className={s.hudPanelText}>Loading...</p>
            )}
          </div>
  );

  // SECOND BRAIN — throwback tile + freshest ideas, all rows expandable
  const brainPanel = (
          <div className={s.hudPanelBracketed}>
            {panelHeader('SECOND BRAIN', '/inbox')}
            {brainData ? (
              <>
                {brainData.throwback && (
                  <div style={{ marginBottom: '8px' }}>
                    <div style={{ fontSize: '9px', letterSpacing: '0.15em', color: 'rgba(224,240,255,0.35)', textTransform: 'uppercase', marginBottom: '2px' }}>
                      Throwback{brainData.throwback.daysSince != null ? ` · ${brainData.throwback.daysSince}d cold` : ''}
                    </div>
                    {expandableText('brain-throwback', brainData.throwback.title, {
                      clamp: 'clamp1',
                      threshold: 38,
                      style: { fontSize: '11px', color: '#E0F0FF', lineHeight: 1.5 },
                    })}
                  </div>
                )}
                <div style={{ fontSize: '9px', letterSpacing: '0.15em', color: 'rgba(224,240,255,0.35)', textTransform: 'uppercase', marginBottom: '4px' }}>New Ideas</div>
                {brainData.ideas.length > 0 ? (
                  brainData.ideas.slice(0, 4).map((idea, i) => (
                    <div key={i} style={{ marginBottom: '4px' }}>
                      {expandableText(`idea-${i}`, `· ${idea.title}`, {
                        clamp: 'clamp1',
                        threshold: 40,
                        style: { fontSize: '11px', color: 'rgba(224,240,255,0.8)', lineHeight: 1.5 },
                      })}
                    </div>
                  ))
                ) : (
                  <div style={{ fontSize: '11px', color: 'rgba(224,240,255,0.4)' }}>none yet</div>
                )}
              </>
            ) : (
              <p className={s.hudPanelText}>Loading...</p>
            )}
          </div>
  );

  const centerSection = (
        <div className="flex-1 flex flex-col items-center justify-center px-4 gap-4 py-10 lg:py-0 min-h-[70vh] lg:min-h-0">
          {/* Status */}
          <div className="flex items-center gap-3">
            <div className={statusDotClass} />
            <span
              className="text-xs tracking-[0.3em] uppercase"
              style={{ color: statusColor[voiceState], fontFamily: 'var(--font-sora)' }}
            >
              {statusLabel[voiceState]}
            </span>
          </div>

          {/* Clickable Orb */}
          <button
            onClick={toggleVoice}
            className={s.orbButton}
            disabled={voiceState === 'processing'}
            aria-label={voiceState === 'listening' ? 'Stop listening' : 'Start voice input'}
          >
            <div className={orbGlowClass} />
            <div className={s.orbRing3} />
            <div className={s.orbArcReverse} />
            <div className={s.orbRing2} />
            <div className={s.orbArc} />
            <div className={s.orbRing1} />
            <div className={orbCoreClass} />
            <div className={s.orbSpecular} />
            {voiceState === 'listening' && <div className={s.orbMicIcon}>&#9673;</div>}
            {voiceState === 'speaking' && (
              <div className={s.waveformContainer}>
                {Array.from({ length: 7 }).map((_, i) => (
                  <div
                    key={i}
                    className={s.waveformBar}
                    style={{ animationDelay: `${i * 0.08}s` }}
                  />
                ))}
              </div>
            )}
          </button>

          {/* Label + voice selector */}
          <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-3 relative">
            <h1
              className="text-2xl font-semibold tracking-[0.4em]"
              style={{
                color: '#00D4FF',
                fontFamily: 'var(--font-sora)',
                textShadow: '0 0 24px rgba(0,212,255,0.45)',
                paddingLeft: '0.4em', /* optically recenters letter-spaced caps */
              }}
            >
              JARVIS
            </h1>
            <button
              onClick={() => setShowVoiceMenu(!showVoiceMenu)}
              className="text-[10px] uppercase tracking-wider px-2 py-1 rounded"
              style={{
                color: '#4A6A8A',
                background: 'rgba(0,212,255,0.05)',
                border: '1px solid rgba(0,212,255,0.15)',
                fontFamily: 'var(--font-jetbrains)',
                cursor: 'pointer',
              }}
              title="Change voice"
            >
              {voices.find((v) => v.id === currentVoice)?.name || 'Ryan'}
            </button>
            {showVoiceMenu && (
              <div
                className="absolute top-full right-0 mt-2 rounded-lg py-1 z-50"
                style={{
                  background: 'rgba(13,21,32,0.95)',
                  border: '1px solid rgba(0,212,255,0.2)',
                  backdropFilter: 'blur(12px)',
                  minWidth: '220px',
                }}
              >
                {voices.filter((v) => v.installed).map((v) => (
                  <button
                    key={v.id}
                    onClick={() => changeVoice(v.id)}
                    className="w-full text-left px-3 py-2 flex flex-col gap-0.5"
                    style={{
                      background: v.id === currentVoice ? 'rgba(0,212,255,0.1)' : 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-jetbrains)',
                    }}
                  >
                    <span
                      className="text-xs"
                      style={{ color: v.id === currentVoice ? '#00D4FF' : '#E0F0FF' }}
                    >
                      {v.name} — {v.accent} {v.gender}
                      {v.id === currentVoice && ' ●'}
                    </span>
                    <span className="text-[10px]" style={{ color: '#4A6A8A' }}>
                      {v.description}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className={s.jarvisSub}>Autonomous Orchestrator</div>
          </div>

          {/* Speed slider */}
          <div className="flex items-center gap-3 w-56">
            <span
              className="text-[10px] uppercase tracking-wider whitespace-nowrap"
              style={{ color: '#4A6A8A', fontFamily: 'var(--font-jetbrains)' }}
            >
              Speed
            </span>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.1}
              value={speed}
              onChange={(e) => changeSpeed(parseFloat(e.target.value))}
              className={s.speedSlider}
            />
            <span
              className="text-[10px] w-10 text-right"
              style={{ color: '#4A6A8A', fontFamily: 'var(--font-jetbrains)' }}
            >
              {speed.toFixed(1)}x
            </span>
          </div>

          {/* Live transcription */}
          {voiceState === 'listening' && currentTranscript && (
            <div
              className="max-w-xl text-center px-4 py-2 rounded-lg"
              style={{
                color: '#00FF88',
                fontFamily: 'var(--font-jetbrains)',
                background: 'rgba(0,255,136,0.05)',
                border: '1px solid rgba(0,255,136,0.15)',
              }}
            >
              <p className="text-sm italic">&quot;{currentTranscript}&quot;</p>
            </div>
          )}

          {/* TL;DR response area */}
          <div
            className={`${s.responseArea} max-w-xl text-center leading-relaxed`}
            style={{ color: '#E0F0FF', minHeight: '2.5rem' }}
          >
            {latestTldr ? (
              <p className="text-sm">{latestTldr}</p>
            ) : (
              <p className="text-sm" style={{ color: '#4A6A8A' }}>
                {speechSupported
                  ? 'Click the orb to start talking'
                  : 'Speech recognition not supported — use Chrome'}
              </p>
            )}
          </div>

          {/* Conversation panel (collapses to nothing when empty) */}
          {exchanges.length > 0 && (
            <div
              ref={conversationRef}
              className={`${s.transcript} w-full max-w-2xl max-h-48 overflow-y-auto rounded-lg px-4 py-3 space-y-3`}
              style={{
                background: 'rgba(13,21,32,0.8)',
                border: '1px solid rgba(0,212,255,0.1)',
              }}
            >
              {exchanges.map((ex) => (
                <div key={ex.id} className="space-y-2">
                  {/* B's message */}
                  <div className="flex justify-end">
                    <div
                      className="max-w-[80%] rounded-lg px-3 py-1.5 text-xs"
                      style={{
                        background: 'rgba(74,106,138,0.2)',
                        border: '1px solid rgba(74,106,138,0.2)',
                        color: '#E0F0FF',
                      }}
                    >
                      <span
                        className="text-[9px] uppercase tracking-wider block mb-0.5"
                        style={{ color: '#4A6A8A' }}
                      >
                        B
                      </span>
                      {ex.userText}
                    </div>
                  </div>
                  {/* Jarvis response */}
                  <div className="flex justify-start">
                    <div
                      className="max-w-[85%] rounded-lg px-3 py-2 text-xs"
                      style={{
                        background: 'rgba(0,212,255,0.08)',
                        border: '1px solid rgba(0,212,255,0.15)',
                        color: '#E0F0FF',
                      }}
                    >
                      <span
                        className="text-[9px] uppercase tracking-wider block mb-0.5"
                        style={{ color: '#4A6A8A' }}
                      >
                        JARVIS
                      </span>
                      <p className="mb-1">{ex.tldr}</p>
                      {ex.full && (
                        <>
                          <button
                            onClick={() => setExpandedId(expandedId === ex.id ? null : ex.id)}
                            className="text-[10px] uppercase tracking-wider mt-1"
                            style={{
                              color: '#00D4FF',
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              padding: 0,
                            }}
                          >
                            {expandedId === ex.id ? '▾ Hide details' : '▸ Show details'}
                          </button>
                          {expandedId === ex.id && (
                            <div
                              className="mt-2 pt-2 text-xs leading-relaxed whitespace-pre-wrap"
                              style={{
                                borderTop: '1px solid rgba(0,212,255,0.1)',
                                color: '#B0D0E8',
                              }}
                            >
                              {ex.full}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
  );

  // NORTH STAR
  const northStarPanel = (
          <div className={s.hudPanelBracketed}>
            <div className={s.hudPanelHeader}>NORTH STAR</div>
            <p className={s.hudPanelText}>
              {statusData?.northStar || 'Loading...'}
            </p>
          </div>
  );

  // TODAY'S FOCUS — daily_focus with staleness chip; the focus text itself and
  // every completed-today row expand in place (B clicked it expecting exactly that).
  const focusPanel = (
          <div className={s.hudPanelBracketed}>
            {panelHeader("TODAY'S FOCUS", '/strategy', statusData ? ageChip(statusData.focusAgeHours, 36) : undefined)}
            {statusData ? (
              expandableText('focus-text', statusData.focus, {
                clamp: 'clamp4',
                threshold: 150,
                className: s.hudPanelText,
              })
            ) : (
              <p className={s.hudPanelText}>Loading...</p>
            )}
            {statusData && statusData.focusAgeHours !== null && statusData.focusAgeHours > 36 && (
              <p style={{ fontSize: '10px', color: '#FFB800', marginTop: '6px', letterSpacing: '0.05em' }}>
                ⚠ focus not refreshed in {fmtAge(statusData.focusAgeHours)} — live work below
              </p>
            )}
            {statusData && (
              <div style={{ marginTop: '10px', paddingTop: '8px', borderTop: '1px solid rgba(0,212,255,0.1)' }}>
                <div style={{ fontSize: '9px', letterSpacing: '0.15em', color: 'rgba(224,240,255,0.35)', textTransform: 'uppercase', marginBottom: '4px' }}>
                  Completed today · {statusData.completedToday.count}
                </div>
                {statusData.completedToday.titles.length > 0 ? (
                  statusData.completedToday.titles.map((t, i) => (
                    <div key={i} style={{ marginBottom: '4px' }}>
                      {expandableText(`done-${i}`, `✓ ${t}`, {
                        clamp: 'clamp1',
                        threshold: 40,
                        style: { fontSize: '11px', color: 'rgba(224,240,255,0.8)', lineHeight: 1.5 },
                      })}
                    </div>
                  ))
                ) : (
                  <div style={{ fontSize: '11px', color: 'rgba(224,240,255,0.4)' }}>nothing completed yet</div>
                )}
              </div>
            )}
          </div>
  );

  // AWAITING YOUR INPUT — LIVE sources: pending approvals + open decisions + open questions.
  const awaitingPanel = (
          <div className={s.hudPanelBracketed}>
            {panelHeader('AWAITING YOUR INPUT', '/inbox')}
            {statusData?.pendingItems && statusData.pendingItems.length > 0 ? (
              statusData.pendingItems.slice(0, 6).map((q, i) => {
                const key = `pending-${i}`;
                const isExpanded = expandedPanelItem === key;
                return (
                  <div
                    key={i}
                    className={isExpanded ? s.hudPanelItemExpanded : s.hudPanelItem}
                    onClick={() => togglePanelItem(key)}
                    title="Click to expand"
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '6px' }}>
                      <span className={isExpanded ? undefined : s.clamp2}>{q.title}</span>
                      <span style={sourceChipStyle(q.source)}>
                        {q.source === 'open-question' ? 'Q' : q.source === 'approval' ? 'APPROVAL' : 'DECISION'}
                        {q.ageDays != null && q.ageDays > 0 ? ` ${q.ageDays}d` : ''}
                      </span>
                    </div>
                    {isExpanded && q.detail && q.detail !== q.title && (
                      <div style={{ marginTop: '4px', fontSize: '11px', color: 'rgba(224,240,255,0.6)', lineHeight: 1.5 }}>
                        {q.detail}
                      </div>
                    )}
                  </div>
                );
              })
            ) : statusData ? (
              <p className={s.hudPanelText}>No pending items</p>
            ) : (
              <p className={s.hudPanelText}>Loading...</p>
            )}
          </div>
  );

  return (
    <div className={s.scene}>
    <div className={s.hero}>
      <div className={s.grid} />
      <div className={s.vignette} />
      <div className={s.scanline} />

      <div className={`${s.hudCorner} ${s.hudCornerTL}`} />
      <div className={`${s.hudCorner} ${s.hudCornerTR}`} />
      <div className={`${s.hudCorner} ${s.hudCornerBL}`} />
      <div className={`${s.hudCorner} ${s.hudCornerBR}`} />

      <div className="relative z-10 flex flex-col lg:flex-row lg:h-full">
        {/* Left column (lg+) — Money + Edge + Tasks + Fleet + Brain.
            Internally scrollable; panels never shrink, so nothing clips. */}
        <div className={`hidden lg:flex flex-col w-80 xl:w-96 shrink-0 ${s.hudColumn}`}>
          <div className={s.hudTimestamp}>{hudTime}</div>
          {moneyPanel}
          <div className={s.hudAccentLine} />
          {edgePanel}
          <div className={s.hudAccentLine} />
          {tasksPanel}
          <div className={s.hudAccentLine} />
          {fleetPanel}
          {brainPanel}
        </div>

        {/* Center — the orb */}
        {centerSection}

        {/* Right column (lg+) — North Star + Focus + Awaiting Input */}
        <div className={`hidden lg:flex flex-col w-80 xl:w-96 shrink-0 ${s.hudColumn}`}>
          <div className="flex justify-center">
            <div className={s.hudModelBadge}>
              <span className={s.hudModelDot} />
              Haiku + Opus
            </div>
          </div>
          {northStarPanel}
          <div className={s.hudAccentLine} />
          {focusPanel}
          <div className={s.hudAccentLine} />
          {awaitingPanel}
        </div>

        {/* < lg — every panel stacked under the orb (they used to be invisible
            on the phone). The page scrolls; nothing is hidden or clipped. */}
        <div className={`flex flex-col lg:hidden ${s.hudStack}`}>
          {moneyPanel}
          {focusPanel}
          {awaitingPanel}
          {tasksPanel}
          {edgePanel}
          {fleetPanel}
          {brainPanel}
          {northStarPanel}
        </div>

        {/* Bottom HUD bar (lg+ only — the mobile bottom-nav owns that edge) */}
        <div className={s.hudBottomBar}>
          <span>JARVIS COCKPIT v2.2</span>
          <span className={s.hudBottomSep}>|</span>
          <span>MODELS: HAIKU (FAST) + OPUS (DEEP)</span>
          <span className={s.hudBottomSep}>|</span>
          <span>VOICE: {voices.find((v) => v.id === currentVoice)?.name?.toUpperCase() || 'RYAN'}</span>
          <span className={s.hudBottomSep}>|</span>
          <span>SPEED: {speed.toFixed(1)}x</span>
          <span className={s.hudBottomSep}>|</span>
          <span>FLEET: {statusData?.fleet.filter((a) => a.status === 'ONLINE').length || 0}/{statusData?.fleet.length || 0} ONLINE</span>
        </div>
      </div>
    </div>
    </div>
  );
}
