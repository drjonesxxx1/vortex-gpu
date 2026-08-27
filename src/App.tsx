import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Monitor, Cpu, Plus, Power, Clock, Shield, Terminal, Zap,
  Bitcoin, Laptop, Server, KeyRound, Sparkles, LogOut, X, ExternalLink, Copy, Globe, UserPlus, LogIn,
  ArrowRight, CheckCircle2, Rocket, Lock, Gauge, Loader2,
} from 'lucide-react';
import { Cyber3DCanvas } from './components/Cyber3DCanvas';
import './index.css';

/**
 * VortexGPU — rent-a-PC storefront.
 * Unified products: Ubuntu GPU Session (in-browser 4080), Windows RDP, Linux SSH.
 * Pricing: $1/hr. First machine FREE, 2nd & 3rd billed. Bitcoin via BTCPay.
 * Token auth: register / login / logout — everyone gets their own account.
 */

interface ApiVm {
  id: string; vm_id: number; os: string; sku: string; state: string;
  port: number | null; username: string | null; password: string | null;
  app: string | null; created_at: number;
}

interface ApiSession {
  id: string; instance_id: string; node_hostname: string; port: number;
  password: string; resolution: string; proxy: string | null; state: string; created_at: number;
}

interface User { id: string; username: string; balance_minutes: number; unlimited?: boolean; }

// One-click noVNC desktop URL. The container serves the full noVNC client at
// /static/vnc.html (verified — no /vnc.html exists at the root); host/port/
// encrypt default to window.location in noVNC, so only `path` must carry the
// gateway prefix, and `password` skips the manual VNC password prompt.
function desktopUrlFor(s: ApiSession): string {
  const params = new URLSearchParams({
    autoconnect: 'true',
    resize: 'scale',
    path: `session/${s.instance_id}/websockify`,
    password: s.password,
  });
  return `/session/${s.instance_id}/static/vnc.html?${params.toString()}`;
}

function fmtUptime(createdAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - createdAt) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${ss}s` : `${ss}s`;
}

function App() {
  const [auth, setAuth] = useState<{ token: string; user: User } | null>(null);
  const [vms, setVms] = useState<ApiVm[]>([]);
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [gpuSku, setGpuSku] = useState('NVIDIA GeForce RTX 4080 SUPER 16GB');
  const [price, setPrice] = useState(1);
  const [maxMachines, setMaxMachines] = useState(3);
  const [freeMachines, setFreeMachines] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<'landing' | 'auth'>('landing');

  useEffect(() => {
    const raw = localStorage.getItem('vortex_auth');
    if (raw) { try { const a = JSON.parse(raw); if (a?.token) setAuth(a); } catch {} }
  }, []);

  const refresh = useCallback(async () => {
    if (!auth) return;
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${auth.token}` } });
      if (r.status === 401) { setAuth(null); localStorage.removeItem('vortex_auth'); return; }
      if (r.ok) {
        const d = await r.json();
        setVms(d.vms || []);
        setSessions(d.sessions || []);
        setGpuSku(d.gpu_sku || gpuSku);
        setPrice(d.price_per_hour || 1);
        setMaxMachines(d.max_machines === -1 ? 999 : d.max_machines || 3);
        setFreeMachines(d.free_machines || 1);
        setAuth((a) => (a ? { ...a, user: { ...a.user, ...d.user } } : a));
      }
    } catch (e) { console.error(e); }
  }, [auth?.token]);

  // 1s clock for live uptime counters on session cards.
  const [nowTs, setNowTs] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Poll every 4s so provisioning sessions flip 'Open Desktop' to active live.
  useEffect(() => {
    if (!auth) return;
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [auth, refresh]);

  if (!auth) {
    return view === 'landing'
      ? <LandingPage onLaunch={() => setView('auth')} />
      : <AuthGate onAuthed={setAuth} onBack={() => setView('landing')} />;
  }

  const user = auth.user;
  const hrs = Math.floor(user.balance_minutes / 60);
  const mins = user.balance_minutes % 60;
  const activeCount = [...vms, ...sessions].filter((r: any) => r.state === 'running' || r.state === 'provisioning').length;
  const atCap = !user.unlimited && activeCount >= maxMachines;

  const api = (path: string, body?: any) => fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

  const deployVm = async (os: 'windows' | 'linux') => {
    setLoading(true); setError('');
    try {
      const r = await api('/api/vms/provision', { os });
      const d = await r.json();
      if (r.ok) refresh(); else setError(d.error || 'deploy failed');
    } catch { setError('network error'); } finally { setLoading(false); }
  };

  const spawnSession = async () => {
    setLoading(true); setError('');
    try {
      const r = await api('/api/session/spawn', { resolution: '1440x900' });
      const d = await r.json();
      if (r.ok) refresh(); else setError(d.error || 'spawn failed');
    } catch { setError('network error'); } finally { setLoading(false); }
  };

  const destroyVm = async (vmId: string) => { await api('/api/vms/destroy', { vmId }); refresh(); };
  const destroySession = async (sessionId: string) => { await api('/api/session/destroy', { sessionId }); refresh(); };
  const logout = () => { setAuth(null); localStorage.removeItem('vortex_auth'); };

  return (
    <div className="min-h-screen bg-[#05070d] text-zinc-100 font-sans">
      <header className="border-b border-zinc-800/70 bg-zinc-950/60 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-black tracking-tight text-white text-lg">
            <Cpu className="w-5 h-5 text-cyan-400" /> VORTEX<span className="text-cyan-400">GPU</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right">
              <div className="text-[11px] text-zinc-500 uppercase tracking-wide">Balance</div>
              <div className="text-sm font-bold text-amber-300">{hrs}h {mins}m</div>
            </div>
            <TopUpButton token={auth.token} onAdded={() => refresh()} />
            <div className="text-right">
              <div className="text-cyan-300 font-bold text-sm">@{user.username}{user.unlimited && <span className="text-amber-400" title="Unlimited machines"> ∞</span>}</div>
              <div className="text-[10px] text-zinc-500">{user.unlimited ? '∞ machines' : `${activeCount}/${maxMachines} machines · ${freeMachines} free`}</div>
            </div>
            <button onClick={logout} className="p-2 text-zinc-500 hover:text-white rounded-lg border border-zinc-800" title="Logout"><LogOut className="w-4 h-4" /></button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-6 space-y-6">
        {error && (
          <div className="p-3 bg-red-950/60 border border-red-500/40 rounded-xl text-sm text-red-300 flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-400 font-bold"><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* Products */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-lg">Products</h2>
            <span className="text-xs text-zinc-500">{gpuSku} · ${price}/hr · first machine free</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <ProductCard
              icon={<Terminal className="w-7 h-7 text-emerald-400" />}
              name="Ubuntu GPU Session"
              tag="In-browser · 4080 SUPER"
              desc="Full Ubuntu desktop in your browser with the 4080 attached. Install anything, run any GPU job."
              cta="⚡ Spawn Session"
              onClick={spawnSession}
              accent="emerald"
            />
            <ProductCard
              icon={<Laptop className="w-7 h-7 text-cyan-400" />}
              name="Windows 10"
              tag="RDP · full desktop"
              desc="Real Windows 10 VM via RDP. Games, CUDA, GUI apps."
              cta="Deploy Windows"
              onClick={() => deployVm('windows')}
              accent="cyan"
            />
            <ProductCard
              icon={<Server className="w-7 h-7 text-purple-400" />}
              name="Linux"
              tag="SSH · headless compute"
              desc="Debian VM over SSH. Headless compute, docker, servers."
              cta="Deploy Linux"
              onClick={() => deployVm('linux')}
              accent="purple"
            />
          </div>
          {atCap && <p className="mt-2 text-[11px] text-amber-400">Machine limit reached ({maxMachines} max). Stop one to deploy another.</p>}
        </div>

        {/* Your resources */}
        <div>
          <h2 className="font-bold text-lg mb-3">Your Resources</h2>
          {(vms.length === 0 && sessions.length === 0) ? (
            <div className="text-center py-16 border border-dashed border-zinc-800 rounded-2xl">
              <Monitor className="w-12 h-12 mx-auto text-zinc-700 mb-3" />
              <p className="text-zinc-500">Nothing running yet. Your first machine is free — spawn a session or deploy a VM above.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {sessions.map((s) => {
                const isRunning = s.state === 'running';
                const isProvisioning = s.state === 'provisioning';
                const isActive = isRunning || isProvisioning;
                return (
                <div key={s.id} className={`bg-zinc-900/40 border rounded-2xl p-5 ${isRunning ? 'border-emerald-500/50 shadow-lg shadow-emerald-500/5' : isProvisioning ? 'border-amber-500/30' : 'border-zinc-800'}`}>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <Terminal className="w-5 h-5 text-emerald-400" />
                      <div>
                        <div className="font-bold">Ubuntu Session <span className="text-[10px] text-zinc-500">{s.instance_id}</span></div>
                        <div className="text-[11px] text-zinc-500">{gpuSku} · node {s.node_hostname}:{s.port}</div>
                      </div>
                    </div>
                    <StateBadge state={s.state} />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                    <div className="flex items-center gap-1.5">
                      <Monitor className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-zinc-500">Resolution</span>
                      <span className="text-zinc-200 font-mono">{s.resolution}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-zinc-500">Uptime</span>
                      <span className="text-zinc-200 font-mono">{isActive ? fmtUptime(s.created_at, nowTs) : '—'}</span>
                    </div>
                    <div className="col-span-2 flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5 text-cyan-400" />
                      <span className="text-zinc-500">Proxy</span>
                      <span className="text-cyan-300 font-mono truncate">{s.proxy ? s.proxy : 'none yet (pool refreshing)'}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-4">
                    {isRunning ? (
                      <a href={desktopUrlFor(s)} target="_blank" rel="noopener noreferrer" className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-lg text-sm shadow-lg shadow-emerald-500/20 transition-colors">
                        <ExternalLink className="w-4 h-4" /> Open Desktop
                      </a>
                    ) : isProvisioning ? (
                      <button disabled className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-zinc-800 text-zinc-400 font-bold rounded-lg text-sm cursor-wait">
                        <Loader2 className="w-4 h-4 animate-spin text-amber-400" /> Starting desktop&hellip;
                      </button>
                    ) : (
                      <button disabled className="flex-1 flex items-center justify-center gap-1.5 py-2.5 bg-zinc-800/60 text-zinc-600 font-bold rounded-lg text-sm cursor-not-allowed">
                        <Power className="w-4 h-4" /> Stopped
                      </button>
                    )}
                    {isActive && (
                      <button onClick={() => destroySession(s.id)} className="px-3 py-2 border border-red-500/40 text-red-300 rounded-lg text-xs font-bold hover:bg-red-500/10">Stop</button>
                    )}
                  </div>
                  <CopyField label="VNC password" value={s.password} />
                </div>
                );
              })}
              {vms.map((vm) => (
                <div key={vm.id} className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      {vm.os === 'windows' ? <Laptop className="w-5 h-5 text-cyan-400" /> : <Server className="w-5 h-5 text-purple-400" />}
                      <div>
                        <div className="font-bold">{vm.os === 'windows' ? 'Windows 10' : 'Linux'} <span className="text-[10px] text-zinc-500">#{vm.vm_id}</span></div>
                        <div className="text-[11px] text-zinc-500">{vm.sku}</div>
                      </div>
                    </div>
                    <StateBadge state={vm.state} />
                  </div>
                  {vm.state === 'running' && (
                    <div className="mt-4 p-3 bg-black/50 rounded-xl border border-zinc-800 space-y-1.5 font-mono text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-500 flex items-center gap-1.5"><KeyRound className="w-3.5 h-3.5" /> {vm.os === 'windows' ? 'RDP' : 'SSH'}</span>
                        <span className="text-cyan-300">10.30.20.85:{vm.port}</span>
                      </div>
                      <div className="flex items-center justify-between"><span className="text-zinc-500">user</span><span className="text-amber-300">{vm.username}</span></div>
                      <div className="flex items-center justify-between"><span className="text-zinc-500">pass</span><span className="text-amber-300">{vm.password}</span></div>
                      {vm.app && <div className="flex items-center justify-between"><span className="text-zinc-500">app</span><span className="text-purple-300">{vm.app}</span></div>}
                    </div>
                  )}
                  <div className="flex gap-2 mt-4">
                    {(vm.state === 'running' || vm.state === 'provisioning') && (
                      <button onClick={() => destroyVm(vm.id)} className="flex-1 py-2 border border-red-500/40 text-red-300 rounded-lg text-xs font-bold hover:bg-red-500/10"><Power className="w-3.5 h-3.5 inline" /> Stop</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="text-center text-[11px] text-zinc-600">
          ${price}/hr · {freeMachines} machine free · {maxMachines} max · Bitcoin via BTCPay · clean residential proxies on sessions
        </p>
      </main>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const cls = state === 'running' ? 'bg-emerald-500/20 text-emerald-300'
    : state === 'provisioning' ? 'bg-amber-500/20 text-amber-300'
    : state === 'failed' ? 'bg-red-500/20 text-red-300'
    : 'bg-zinc-800 text-zinc-400';
  return <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${cls}`}>{state}</span>;
}

// Copyable credential row (manual VNC fallback) with Copied feedback.
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2 bg-black/50 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-[11px] font-mono">
      <KeyRound className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
      <span className="text-zinc-500">{label}:</span>
      <span className="text-amber-300 flex-1 truncate select-all">{value}</span>
      <button
        onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="flex items-center gap-1 text-cyan-400 hover:text-cyan-300 font-bold shrink-0"
      >
        {copied ? <><CheckCircle2 className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
      </button>
    </div>
  );
}

function ProductCard({ icon, name, tag, desc, cta, onClick, accent }: {
  icon: React.ReactNode; name: string; tag: string; desc: string; cta: string;
  onClick: () => void; accent: 'emerald' | 'cyan' | 'purple';
}) {
  const grad = accent === 'emerald' ? 'from-emerald-500 to-teal-600'
    : accent === 'cyan' ? 'from-cyan-500 to-blue-600'
    : 'from-purple-500 to-indigo-600';
  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-5 flex flex-col">
      <div className="flex items-center gap-2 mb-1">{icon}<span className="font-bold">{name}</span></div>
      <div className="text-[11px] text-zinc-500 mb-2">{tag}</div>
      <p className="text-xs text-zinc-400 mb-4 flex-1">{desc}</p>
      <button onClick={onClick} className={`w-full py-3 bg-gradient-to-r ${grad} text-black font-bold rounded-xl text-sm`}>{cta}</button>
    </div>
  );
}

function TopUpButton({ token, onAdded }: { token: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-500/20 border border-amber-500/40 text-amber-300 rounded-lg text-xs font-bold hover:bg-amber-500/30">
        <Bitcoin className="w-3.5 h-3.5" /> Top Up
      </button>
      {open && <PayModal token={token} onClose={() => setOpen(false)} onAdded={onAdded} />}
    </>
  );
}

function PayModal({ token, onClose, onAdded }: { token: string; onClose: () => void; onAdded: () => void }) {
  const [hours, setHours] = useState(5);
  const [invoice, setInvoice] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const gen = async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/btcpay/create-invoice', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ usdAmount: hours }) });
      const d = await r.json();
      if (r.ok) setInvoice(d);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!invoice) return;
    const t = setInterval(async () => {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) { const d = await r.json(); if (d.user.balance_minutes > 0) { onAdded(); onClose(); } }
    }, 5000);
    return () => clearInterval(t);
  }, [invoice, token]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur p-4 overflow-y-auto">
      <div className="w-full max-w-md bg-zinc-950 border border-amber-500/40 rounded-2xl p-6 max-h-[85vh] overflow-y-auto my-auto">
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-bold text-lg flex items-center gap-2"><Bitcoin className="w-5 h-5 text-amber-400" /> Top Up Balance</h3>
          <button onClick={onClose} className="text-zinc-500 hover:text-white"><X className="w-5 h-5" /></button>
        </div>
        {!invoice ? (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-2">
              {[1, 5, 12, 24].map((h) => (
                <button key={h} onClick={() => setHours(h)} className={`p-3 rounded-lg border text-center ${hours === h ? 'border-amber-500 bg-amber-500/10 text-amber-300' : 'border-zinc-800 text-zinc-400'}`}>
                  <div className="font-bold">${h}</div><div className="text-[10px]">{h}h</div>
                </button>
              ))}
            </div>
            <button onClick={gen} disabled={loading} className="w-full py-3 bg-amber-500 text-black font-bold rounded-xl">{loading ? 'Creating...' : `Pay $${hours} for ${hours} hours`}</button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-3 bg-zinc-900 rounded-xl text-center">
              <div className="text-2xl font-bold text-amber-400">${invoice.amountUsd}.00</div>
              <div className="text-xs text-zinc-500">credits {invoice.minutesAdded} minutes</div>
            </div>
            <a href={invoice.checkoutLink} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 w-full py-3 bg-amber-500 text-black font-bold rounded-xl"><ExternalLink className="w-4 h-4" /> Open Bitcoin Checkout</a>
            <div className="flex items-center gap-2 bg-black p-2 rounded-lg text-xs">
              <span className="flex-1 text-cyan-300 truncate">{invoice.checkoutLink}</span>
              <button onClick={() => { navigator.clipboard.writeText(invoice.checkoutLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }} className="text-amber-400 text-[11px]">{copied ? 'Copied' : 'Copy'}</button>
            </div>
            <p className="text-[11px] text-zinc-500 text-center">Balance credited automatically once payment confirms on-chain.</p>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="min-h-screen bg-[#05070d] text-zinc-100 font-sans overflow-x-hidden">
      {/* Nav */}
      <header className="border-b border-zinc-800/70 bg-zinc-950/60 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2 font-black tracking-tight text-white text-lg">
            <Cpu className="w-5 h-5 text-cyan-400" /> VORTEX<span className="text-cyan-400">GPU</span>
          </div>
          <nav className="hidden md:flex items-center gap-6 text-sm text-zinc-400">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#pricing" className="hover:text-white transition-colors">Pricing</a>
            <a href="#how" className="hover:text-white transition-colors">How it works</a>
          </nav>
          <button onClick={onLaunch} className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded-lg text-sm transition-colors">Launch Console</button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 0%, rgba(34,211,238,0.14), transparent 70%)' }} />
        <div className="max-w-6xl mx-auto px-5 py-16 md:py-24 grid md:grid-cols-2 gap-12 items-center relative">
          <div>
            <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-full px-3 py-1.5 mb-5">
              <Bitcoin className="w-3.5 h-3.5" /> Bitcoin · No KYC
            </div>
            <h1 className="text-4xl md:text-5xl font-black tracking-tight leading-[1.08]">
              Rent a <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-emerald-400">real GPU PC</span> by the hour.
            </h1>
            <p className="text-zinc-400 text-lg mt-5 max-w-lg leading-relaxed">
              A full Ubuntu desktop with an <span className="text-white font-semibold">RTX 4080 SUPER</span> in your browser, Windows RDP, and Linux SSH. Settled in Bitcoin — no card, no lock-in.
            </p>
            <div className="flex flex-wrap gap-3 mt-8">
              <button onClick={onLaunch} className="flex items-center gap-2 px-6 py-3.5 bg-gradient-to-r from-cyan-500 to-emerald-500 text-black font-bold rounded-xl hover:opacity-90 transition shadow-lg shadow-cyan-500/20">
                Get started — $1/hr <ArrowRight className="w-4 h-4" />
              </button>
              <a href="#pricing" className="flex items-center gap-2 px-6 py-3.5 border border-zinc-700 text-zinc-200 font-semibold rounded-xl hover:border-zinc-500 transition-colors">
                See pricing
              </a>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 mt-8 text-xs text-zinc-500">
              <span className="flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> First machine free</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> 4080 SUPER / 4070</span>
              <span className="flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-emerald-400" /> Clean residential proxy</span>
            </div>
          </div>
          <div className="relative">
            <div className="h-[380px]">
              <Cyber3DCanvas vmState="running" gpuLoad={74} />
            </div>
            <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-amber-500/15 border border-amber-500/40 text-amber-300 text-xs font-bold rounded-full px-4 py-2 whitespace-nowrap">
              <Bitcoin className="w-4 h-4" /> Settled in BTC via BTCPay
            </div>
          </div>
        </div>
      </section>

      {/* Stat bar */}
      <section className="border-y border-zinc-800/70 bg-zinc-950/40">
        <div className="max-w-6xl mx-auto px-5 py-6 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
          {[['$1', 'per hour'], ['1st', 'machine free'], ['RTX 4080', 'SUPER 16GB'], ['BTC', 'via BTCPay']].map(([v, l]) => (
            <div key={l}>
              <div className="text-2xl md:text-3xl font-black text-cyan-300">{v}</div>
              <div className="text-[11px] uppercase tracking-wider text-zinc-500 mt-1">{l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-black tracking-tight">Three ways to compute</h2>
          <p className="text-zinc-500 mt-3 max-w-xl mx-auto">Every machine is a real isolated instance with the GPU attached — not a shared sandbox.</p>
        </div>
        <div className="grid md:grid-cols-3 gap-5">
          <FeatureCard icon={<Terminal className="w-7 h-7 text-emerald-400" />} name="Ubuntu GPU Session" tag="In-browser · 4080 SUPER" desc="A full Ubuntu desktop streaming to your browser with the RTX 4080 attached. Install anything, run any CUDA job." />
          <FeatureCard icon={<Laptop className="w-7 h-7 text-cyan-400" />} name="Windows 10" tag="RDP · full desktop" desc="A real Windows 10 VM over RDP. Games, GUI apps, CUDA workloads — a genuine desktop." />
          <FeatureCard icon={<Server className="w-7 h-7 text-purple-400" />} name="Linux" tag="SSH · headless" desc="Debian over SSH for headless compute, docker, and long-running server jobs." />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-10">
          {[
            [<Gauge className="w-5 h-5 text-cyan-400" />, 'Dedicated GPU', 'Real passthrough, not shared'],
            [<Shield className="w-5 h-5 text-emerald-400" />, 'No KYC', 'Email-free Bitcoin checkout'],
            [<Globe className="w-5 h-5 text-purple-400" />, 'Clean proxy', 'Residential IP on sessions'],
            [<Lock className="w-5 h-5 text-amber-400" />, 'Isolated', 'Your own VM, full root'],
          ].map(([ic, t, d], i) => (
            <div key={i} className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-4">
              <div className="flex items-center gap-2 text-zinc-200 font-semibold text-sm">{ic}{t}</div>
              <div className="text-[11px] text-zinc-500 mt-1">{d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="border-t border-zinc-800/70 bg-zinc-950/40">
        <div className="max-w-6xl mx-auto px-5 py-20">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-black tracking-tight">Simple, honest pricing</h2>
            <p className="text-zinc-500 mt-3">Pay in Bitcoin. Credits your balance automatically the moment payment confirms.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-5 max-w-4xl mx-auto">
            {[
              ['1 hour', '$1', 'Try it — your first machine is free', 'from-cyan-500 to-blue-600'],
              ['5 hours', '$5', 'Most popular for a session', 'from-emerald-500 to-teal-600'],
              ['24 hours', '$24', 'Best value for long jobs', 'from-purple-500 to-indigo-600'],
            ].map(([h, p, d, g]) => (
              <div key={h} className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-7 flex flex-col items-center text-center">
                <div className="text-sm text-zinc-400 font-semibold">{h}</div>
                <div className={`text-4xl font-black my-3 text-transparent bg-clip-text bg-gradient-to-r ${g}`}>{p}</div>
                <div className="text-xs text-zinc-500 mb-6">{d}</div>
                <button onClick={onLaunch} className={`mt-auto w-full py-3 bg-gradient-to-r ${g} text-black font-bold rounded-xl text-sm`}>Get started</button>
              </div>
            ))}
          </div>
          <p className="text-center text-[11px] text-zinc-600 mt-8">First machine free · up to 3 machines · $1/hour per billed machine · no subscription, no card on file</p>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="max-w-6xl mx-auto px-5 py-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-black tracking-tight">Up and running in a minute</h2>
        </div>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            [<Rocket className="w-6 h-6 text-cyan-400" />, '1 · Create an account', 'Username + password. No email, no KYC.'],
            [<Bitcoin className="w-6 h-6 text-amber-400" />, '2 · Top up in Bitcoin', 'Pay $1–$24 via BTCPay. Balance credits instantly.'],
            [<Monitor className="w-6 h-6 text-emerald-400" />, '3 · Deploy your machine', 'Spawn an Ubuntu session or deploy Windows/Linux. First one is free.'],
          ].map(([ic, t, d], i) => (
            <div key={i} className="text-center">
              <div className="w-14 h-14 mx-auto rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center mb-4">{ic}</div>
              <div className="font-bold">{t}</div>
              <div className="text-sm text-zinc-500 mt-2">{d}</div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-zinc-800/70">
        <div className="max-w-4xl mx-auto px-5 py-20 text-center">
          <h2 className="text-3xl md:text-4xl font-black tracking-tight">Your GPU is waiting.</h2>
          <p className="text-zinc-400 mt-4 max-w-xl mx-auto">Rent an RTX 4080 SUPER by the hour, paid in Bitcoin, no KYC. First machine free.</p>
          <button onClick={onLaunch} className="flex items-center gap-2 mx-auto mt-8 px-8 py-4 bg-gradient-to-r from-cyan-500 to-emerald-500 text-black font-bold rounded-xl text-base hover:opacity-90 transition shadow-lg shadow-cyan-500/25">
            Launch the console <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-800/70 bg-zinc-950/60">
        <div className="max-w-6xl mx-auto px-5 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 font-black text-white">
            <Cpu className="w-5 h-5 text-cyan-400" /> VORTEX<span className="text-cyan-400">GPU</span>
          </div>
          <div className="text-xs text-zinc-600 text-center">
            $1/hr · Bitcoin via BTCPay · No KYC · <a href="https://buymeacoffee.com/r26xrthzttg" className="text-zinc-500 hover:text-zinc-300">Support the build</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, name, tag, desc }: { icon: React.ReactNode; name: string; tag: string; desc: string }) {
  return (
    <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-6 hover:border-cyan-500/40 transition-colors">
      <div className="flex items-center gap-2 mb-1">{icon}<span className="font-bold">{name}</span></div>
      <div className="text-[11px] text-cyan-400 mb-2">{tag}</div>
      <p className="text-sm text-zinc-400 leading-relaxed">{desc}</p>
    </div>
  );
}

function AuthGate({ onAuthed, onBack }: { onAuthed: (a: { token: string; user: User }) => void; onBack: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setLoading(true); setError('');
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username.trim(), password }) });
      const d = await r.json();
      if (r.ok) {
        const a = { token: d.token, user: d.user };
        localStorage.setItem('vortex_auth', JSON.stringify(a));
        onAuthed(a);
      } else setError(d.error || 'failed');
    } catch { setError('network error'); } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-[#05070d] flex items-center justify-center p-6 font-sans">
      <div className="w-full max-w-md">
        <button onClick={onBack} className="mb-6 flex items-center gap-1.5 text-sm text-zinc-500 hover:text-white transition-colors">
          <ArrowRight className="w-4 h-4 rotate-180" /> Back to home
        </button>
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 text-3xl font-black tracking-tight text-white">
            <span className="text-cyan-400">VORTEX</span>GPU
          </div>
          <p className="text-sm text-zinc-400 mt-2">Rent a real GPU PC by the hour. Ubuntu sessions, Windows RDP, Linux SSH.</p>
        </div>

        <div className="flex gap-2 mb-4">
          <button onClick={() => { setMode('login'); setError(''); }} className={`flex-1 py-2 rounded-xl border text-sm font-bold ${mode === 'login' ? 'border-cyan-500 bg-cyan-500/10 text-cyan-300' : 'border-zinc-800 text-zinc-500'}`}>
            <LogIn className="w-4 h-4 inline mr-1" /> Login
          </button>
          <button onClick={() => { setMode('register'); setError(''); }} className={`flex-1 py-2 rounded-xl border text-sm font-bold ${mode === 'register' ? 'border-emerald-500 bg-emerald-500/10 text-emerald-300' : 'border-zinc-800 text-zinc-500'}`}>
            <UserPlus className="w-4 h-4 inline mr-1" /> Register
          </button>
        </div>

        <form onSubmit={submit} className="bg-zinc-900/50 border border-zinc-800 rounded-2xl p-6 space-y-4 backdrop-blur">
          <label className="block text-xs text-zinc-400">USERNAME:</label>
          <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="your username" autoComplete="username" className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-cyan-300 text-sm outline-none focus:border-cyan-500" />
          <label className="block text-xs text-zinc-400">PASSWORD:</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={mode === 'register' ? 'min 6 characters' : 'your password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 text-cyan-300 text-sm outline-none focus:border-cyan-500" />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button disabled={loading} className="w-full py-3 bg-gradient-to-r from-cyan-500 to-blue-600 text-black font-bold rounded-xl text-sm disabled:opacity-50">
            {loading ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>
        <p className="text-[11px] text-zinc-600 text-center mt-4">$1.00 / hour · 1st machine free · up to 3 machines · Bitcoin via BTCPay</p>
      </div>
    </div>
  );
}

export default App;
