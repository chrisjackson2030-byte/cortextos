'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

interface StatusData {
  todayWork: string[];
  pendingQuestions: string[];
  fleet: FleetAgent[];
  focus: string;
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
  priority: string;
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
  const [brainData, setBrainData] = useState<{
    ideas: { title: string; source: string; daysSince: number | null }[];
    throwback: { title: string; source: string; daysSince: number | null } | null;
    connections: { a: string; b: string; shared: string[] }[];
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

      <div className="relative z-10 flex h-full">
        {/* Left panel — Trading P&L + Tasks + Fleet */}
        <div
          className="hidden lg:flex w-80 xl:w-96 flex-col px-5 pt-5 pb-12 gap-4 overflow-y-auto"
          style={{ maxHeight: '100%' }}
        >
          {/* HUD timestamp */}
          <div className={s.hudTimestamp}>{hudTime}</div>

          {/* LIVE TRADING — real money only (paper lives on the Operations dashboard) */}
          <div className={s.hudPanelBracketed}>
            <div className={s.hudPanelHeader}>LIVE TRADING · REAL $</div>
            {tradingData ? (
              <div style={{ fontFamily: 'var(--font-jetbrains)' }}>
                {/* Prediction markets — Sidewinder (the only live prediction lane) */}
                <div style={{ marginBottom: '14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#00FF88', boxShadow: '0 0 8px rgba(0,255,136,0.6)' }} />
                    <span style={{ color: '#00FF88', fontSize: '12px', letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 600 }}>
                      Sidewinder · Kalshi
                    </span>
                  </div>
                  {tradingData.live.total > 0 ? (
                    <>
                      <div style={{ fontSize: '30px', fontWeight: 700, color: pnlColor(tradingData.live.netPnl), lineHeight: 1.05 }}>
                        {fmtPnl(tradingData.live.netPnl)}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'rgba(224,240,255,0.7)', fontSize: '13px', marginTop: '5px' }}>
                        <span>{tradingData.live.total} trades</span>
                        <span>{tradingData.live.wins}W / {tradingData.live.losses}L</span>
                        <span>{tradingData.live.winRate}%</span>
                      </div>
                      {tradingData.live.lastTrade && (
                        <div style={{ marginTop: '7px', fontSize: '12px', color: 'rgba(224,240,255,0.5)', display: 'flex', justifyContent: 'space-between' }}>
                          <span>last: {tradingData.live.lastTrade.lane} {tradingData.live.lastTrade.direction}</span>
                          <span style={{ color: pnlColor(tradingData.live.lastTrade.pnl) }}>{fmtPnl(tradingData.live.lastTrade.pnl)}</span>
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ color: 'rgba(224,240,255,0.45)', fontSize: '13px' }}>No live trades yet</div>
                  )}
                  {tradingData.kalshiAccount && (
                    <div style={{ marginTop: '8px', paddingTop: '7px', borderTop: '1px solid rgba(0,255,136,0.12)', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      <span style={{ fontSize: '16px', fontWeight: 700, color: '#E0F0FF' }}>
                        ${tradingData.kalshiAccount.total_value.toFixed(2)}
                      </span>
                      <span style={{ fontSize: '12px', color: 'rgba(224,240,255,0.6)' }}>
                        in account · net{' '}
                        <span style={{ color: pnlColor(tradingData.kalshiAccount.net_pnl) }}>{fmtPnl(tradingData.kalshiAccount.net_pnl)}</span>{' '}
                        (fees in)
                      </span>
                    </div>
                  )}
                  {tradingData.allocation && tradingData.allocation.strategies.length > 0 && (
                    <div style={{ marginTop: '8px', paddingTop: '7px', borderTop: '1px solid rgba(0,255,136,0.12)' }}>
                      <div style={{ fontSize: '10px', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'rgba(224,240,255,0.4)', marginBottom: '5px' }}>
                        Capital by strategy
                      </div>
                      {tradingData.allocation.strategies.map((s) => (
                        <div key={s.strategy_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '3px' }}>
                          <span style={{ fontSize: '12px', color: '#E0F0FF' }}>{s.display_name}</span>
                          <span style={{ fontSize: '12px', color: 'rgba(224,240,255,0.6)' }}>
                            ${s.current_value.toFixed(2)} ·{' '}
                            <span style={{ color: pnlColor(s.realized_pnl) }}>{fmtPnl(s.realized_pnl)}</span> net · {s.wins}W/{s.losses}L
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {/* Options bot — live (account + status) */}
                {optionsData && (
                  <div style={{ borderTop: '1px solid rgba(0,212,255,0.12)', paddingTop: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <span style={{ color: '#00D4FF', fontSize: '12px', letterSpacing: '0.2em', textTransform: 'uppercase', fontWeight: 600 }}>
                        Options · Alpaca
                      </span>
                      <span style={{
                        color: optionsData.kill_switch?.armed ? '#FF4444' : optionsData.status === 'LIVE' ? '#00FF88' : '#FFB800',
                        fontWeight: 600, fontSize: '12px',
                      }}>
                        {optionsData.kill_switch?.armed ? 'HALTED' : optionsData.status}
                      </span>
                    </div>
                    {optionsData.account ? (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                        <span style={{ fontSize: '20px', fontWeight: 700, color: '#E0F0FF' }}>
                          ${optionsData.account.equity.toLocaleString()}
                        </span>
                        <span style={{ fontSize: '12px', color: 'rgba(224,240,255,0.6)' }}>
                          ${optionsData.account.options_buying_power.toLocaleString()} BP
                          {optionsData.account.options_level != null ? ` · L${optionsData.account.options_level}` : ''}
                        </span>
                      </div>
                    ) : null}
                    <div style={{ marginTop: '5px', fontSize: '12px', color: 'rgba(224,240,255,0.5)' }}>
                      {optionsData.summary?.open_positions ?? 0} open · {optionsData.summary?.filled ?? 0} filled
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className={s.hudPanelText}>Loading...</p>
            )}
          </div>

          <div className={s.hudAccentLine} />

          {/* Active Tasks */}
          <div className={s.hudPanelBracketed}>
            <div className={s.hudPanelHeader}>ACTIVE TASKS</div>
            {activeTasks.length > 0 ? (
              activeTasks.slice(0, 6).map((task, i) => (
                <div
                  key={task.id || i}
                  style={{
                    fontFamily: 'var(--font-jetbrains)',
                    fontSize: '13px',
                    padding: '9px 0',
                    borderBottom: i < Math.min(activeTasks.length, 6) - 1 ? '1px solid rgba(0,212,255,0.08)' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: '#00D4FF', fontSize: '12px', textTransform: 'capitalize', letterSpacing: '0.05em' }}>
                      {task.assignee}
                    </span>
                  </div>
                  <div style={{ color: 'rgba(224,240,255,0.85)', marginTop: '3px', lineHeight: '1.45' }}>
                    {task.title.length > 64 ? task.title.slice(0, 64) + '...' : task.title}
                  </div>
                </div>
              ))
            ) : (
              <p className={s.hudPanelText}>No active tasks</p>
            )}
          </div>

          <div className={s.hudAccentLine} />

          {/* Fleet Status */}
          <div className={s.hudPanelBracketed}>
            <div className={s.hudPanelHeader}>FLEET STATUS</div>
            {statusData?.fleet && statusData.fleet.length > 0 ? (
              statusData.fleet.map((a) => (
                <div key={a.name}>
                  <div className={s.hudFleetRow}>
                    <span className={a.status === 'ONLINE' ? s.hudDotOnline : s.hudDotStale} />
                    <span className={s.hudFleetName}>{a.name}</span>
                    <span className={s.hudFleetAgo}>{a.minutesAgo}m</span>
                  </div>
                  {a.task && <div className={s.hudFleetTask}>{a.task}</div>}
                </div>
              ))
            ) : (
              <p className={s.hudPanelText}>Loading...</p>
            )}
          </div>

          {/* Second Brain — ideas / throwback / connections at a glance */}
          <div className={s.hudPanelBracketed}>
            <div className={s.hudPanelHeader}>SECOND BRAIN</div>
            {brainData ? (
              <>
                {brainData.throwback && (
                  <div style={{ marginBottom: '6px' }}>
                    <div style={{ fontSize: '9px', letterSpacing: '0.15em', color: 'rgba(224,240,255,0.35)', textTransform: 'uppercase' }}>Throwback</div>
                    <div style={{ fontSize: '11px', color: '#E0F0FF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brainData.throwback.title}</div>
                  </div>
                )}
                <div style={{ fontSize: '9px', letterSpacing: '0.15em', color: 'rgba(224,240,255,0.35)', textTransform: 'uppercase', marginBottom: '2px' }}>New Ideas</div>
                {brainData.ideas.length > 0 ? (
                  brainData.ideas.slice(0, 4).map((idea, i) => (
                    <div key={i} style={{ fontSize: '11px', color: 'rgba(224,240,255,0.8)', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {idea.title}</div>
                  ))
                ) : (
                  <div style={{ fontSize: '11px', color: 'rgba(224,240,255,0.4)' }}>none yet</div>
                )}
                {brainData.connections.length > 0 && (
                  <div style={{ marginTop: '6px' }}>
                    <div style={{ fontSize: '9px', letterSpacing: '0.15em', color: 'rgba(224,240,255,0.35)', textTransform: 'uppercase', marginBottom: '2px' }}>Connections</div>
                    {brainData.connections.slice(0, 2).map((c, i) => (
                      <div key={i} style={{ fontSize: '10px', color: 'rgba(224,240,255,0.65)', marginBottom: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.a} ↔ {c.b}</div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className={s.hudPanelText}>Loading...</p>
            )}
          </div>
        </div>

        {/* Center */}
        <div className="flex-1 flex flex-col items-center justify-center px-4 gap-4">
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
            <div className={s.orbRing2} />
            <div className={s.orbRing1} />
            <div className={orbCoreClass} />
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
          <div className="flex items-center gap-3 relative">
            <h1
              className="text-2xl font-semibold tracking-[0.4em]"
              style={{
                color: '#00D4FF',
                fontFamily: 'var(--font-sora)',
                textShadow: '0 0 20px rgba(0,212,255,0.3)',
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

        {/* Right panel — North Star + Focus + Awaiting Input */}
        <div className="hidden lg:flex w-80 xl:w-96 flex-col px-5 pt-5 pb-12 gap-4 overflow-y-auto" style={{ maxHeight: '100%' }}>
          {/* Model indicator */}
          <div className="flex justify-center">
            <div className={s.hudModelBadge}>
              <span className={s.hudModelDot} />
              Haiku + Opus
            </div>
          </div>

          {/* North Star */}
          <div className={s.hudPanelBracketed}>
            <div className={s.hudPanelHeader}>NORTH STAR</div>
            <p className={s.hudPanelText}>
              {statusData?.northStar || 'Loading...'}
            </p>
          </div>

          <div className={s.hudAccentLine} />

          {/* Today's Focus */}
          <div className={s.hudPanelBracketed}>
            <div className={s.hudPanelHeader}>TODAY&apos;S FOCUS</div>
            <p className={s.hudPanelText}>
              {statusData?.focus || 'Loading...'}
            </p>
          </div>

          <div className={s.hudAccentLine} />

          {/* Awaiting Input — pending approvals / decisions */}
          <div className={s.hudPanelBracketed}>
            <div className={s.hudPanelHeader}>AWAITING YOUR INPUT</div>
            {statusData?.pendingQuestions && statusData.pendingQuestions.length > 0 ? (
              statusData.pendingQuestions.slice(0, 5).map((q, i) => {
                const key = `pending-${i}`;
                const isExpanded = expandedPanelItem === key;
                return (
                  <p
                    key={i}
                    className={isExpanded ? s.hudPanelItemExpanded : s.hudPanelItem}
                    onClick={() => togglePanelItem(key)}
                    title="Click to expand"
                  >
                    {q}
                  </p>
                );
              })
            ) : (
              <p className={s.hudPanelText}>No pending items</p>
            )}
          </div>
        </div>

        {/* Bottom HUD bar */}
        <div className={s.hudBottomBar}>
          <span>JARVIS COCKPIT v2.1</span>
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
