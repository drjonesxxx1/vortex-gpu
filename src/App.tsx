import React, { Suspense, lazy, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity, ArrowRight, Bitcoin, BookOpen, CheckCircle2, ChevronRight, Clock,
  Cpu, ExternalLink, Eye, EyeOff, Globe, Laptop, Lock,
  LogIn, LogOut, Menu, Monitor, Plug, Power, Rocket, Server, Settings as SettingsIcon,
  Shield, Terminal, Trash2, UserPlus, Wallet, X, Zap,
} from 'lucide-react';
import {
  ACCENTS, Alert, BTN_AMBER, BTN_BASE, BTN_GHOST, BTN_PRIMARY, ConfirmDialog, CopyField,
  INPUT_CLS, Spinner, StateBadge, cx, fmtBalance, readError, useDialogChrome,
} from './components/ui';
import { SettingsView } from './components/SettingsView';
import { GuideView } from './components/GuideView';
import { vmEndpoint } from './connect';
import {
  type Capacity, type Health, fmtVram, readCapacity, useHealth,
} from './health';
import './index.css';

/** three.js is ~460 kB of the bundle and the hero renders fine without it for a
 *  beat, so it is code-split out of the critical path. */
const Cyber3DCanvas = lazy(() =>
  import('./components/Cyber3DCanvas').then((m) => ({ default: m.Cyber3DCanvas })),
);

/**
 * VortexGPU — anonymous, Bitcoin-settled GPU rental.
 *
 * Everything rendered here is backed by a real endpoint in server.ts:
 *   GET  /api/health                 public status + pricing constants
 *   POST /api/auth/register|login    { username, password } -> { token, user }
 *   GET  /api/me                     user, vms[], sessions[], limits, gpu sku
 *   POST /api/session/spawn          Ubuntu GPU session (in-browser noVNC)
 *   POST /api/vms/provision          Windows RDP / Linux SSH VM
 *   POST /api/session/destroy | /api/vms/destroy
 *   POST /api/btcpay/create-invoice  { usdAmount } -> { checkoutLink, ... }
 *
 * Billing model as implemented server-side: the first FREE_MACHINES concurrent
 * machines cost nothing; each additional running machine burns one balance
 * minute per wall-clock minute, and hitting zero auto-stops everything.
 */

/* ------------------------------------------------------------------ types */

interface ApiVm {
  id: string; vm_id: number; os: string; sku: string; state: string;
  /** Host address of the guest. NULL while `provisioning` — the clone writes it
   *  at the same moment it flips the row to `running`. */
  ip: string | null;
  port: number | null; username: string | null; password: string | null;
  app: string | null; created_at: number;
}

interface ApiSession {
  id: string; instance_id: string; node_hostname: string; port: number;
  password: string; resolution: string; proxy: string | null; state: string; created_at: number;
}

interface User { id: string; username: string; balance_minutes: number; unlimited?: boolean }

interface Auth { token: string; user: User }

/* ---------------------------------------------------------------- helpers */

const AUTH_KEY = 'vortex_auth';

/** noVNC lives at /static/vnc.html inside the container; only `path` needs the
 *  gateway prefix since host/port/encrypt default to window.location. */
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

/* Buttons, alerts, badges, copy fields, dialog chrome and the `{error}` reader
 * all live in ./components/ui so the settings area speaks the same dialect. */

/* ------------------------------------------------------------ small parts */

function Logo({ className = 'text-lg' }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-extrabold tracking-tight text-white', className)}>
      <Cpu className="w-5 h-5 text-cyan-400" aria-hidden="true" />
      <span>
        VORTEX<span className="text-cyan-400">GPU</span>
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------- app */

export default function App() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const [restored, setRestored] = useState(false);
  /** Signed-out surfaces. The guide is reachable without an account, so it is a
   *  peer of the landing page rather than something behind the auth gate. */
  const [view, setView] = useState<'landing' | 'auth' | 'guide'>('landing');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) {
        const a = JSON.parse(raw);
        if (a?.token && a?.user) setAuth(a);
      }
    } catch { /* corrupt entry — treat as logged out */ }
    setRestored(true);
  }, []);

  const signIn = useCallback((a: Auth) => {
    try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch { /* private mode */ }
    setAuth(a);
  }, []);

  const signOut = useCallback((token?: string, landOn: 'landing' | 'auth' = 'landing') => {
    if (token) {
      // Best-effort server-side token revocation; never blocks the UI.
      fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    }
    try { localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ }
    setAuth(null);
    setView(landOn);
  }, []);

  // Avoid a landing-page flash for returning users while localStorage is read.
  if (!restored) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-ink-950" aria-busy="true">
        <span className="sr-only">Loading</span>
        <Spinner className="w-6 h-6 text-cyan-400" />
      </div>
    );
  }

  if (!auth) {
    if (view === 'guide') {
      return <GuidePage onBack={() => setView('landing')} onLaunch={() => setView('auth')} />;
    }
    return view === 'landing'
      ? <LandingPage onLaunch={() => setView('auth')} onGuide={() => setView('guide')} />
      : <AuthGate onAuthed={signIn} onBack={() => setView('landing')} />;
  }

  return (
    <Dashboard
      auth={auth}
      setAuth={setAuth}
      onSignOut={() => signOut(auth.token)}
      /* "Log out everywhere" already revoked this token server-side, so skip
       * the extra logout call and drop straight onto the sign-in form. */
      onSessionsRevoked={() => signOut(undefined, 'auth')}
    />
  );
}

/* ------------------------------------------------------------- dashboard */

function Dashboard({
  auth, setAuth, onSignOut, onSessionsRevoked,
}: {
  auth: Auth;
  setAuth: React.Dispatch<React.SetStateAction<Auth | null>>;
  onSignOut: () => void;
  onSessionsRevoked: () => void;
}) {
  const { token } = auth;
  const [vms, setVms] = useState<ApiVm[]>([]);
  const [sessions, setSessions] = useState<ApiSession[]>([]);
  const [meta, setMeta] = useState({
    gpuSku: 'NVIDIA GeForce RTX 4080 SUPER 16GB',
    price: 1,
    maxMachines: 3,
    freeMachines: 1,
  });
  const [health, setHealth] = useState<Health | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [payOpen, setPayOpen] = useState(false);
  /** Same toggle pattern as settings: one piece of state, no router. */
  const [tab, setTab] = useState<'console' | 'settings' | 'guide'>('console');
  /** Deletion is irreversible, so it goes through an explicit dialog. */
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'vm' | 'session'; id: string; label: string } | null
  >(null);
  const [deleteError, setDeleteError] = useState('');
  const [nowTs, setNowTs] = useState(() => Date.now());

  const expired = useRef(false);
  const signOutRef = useRef(onSignOut);
  signOutRef.current = onSignOut;

  const refresh = useCallback(async () => {
    // Capacity rides the existing poll rather than adding a second timer. It is
    // fired off alongside /api/me and never allowed to fail the account load:
    // stale capacity is a disabled button, a stale account is a broken console.
    const healthReq = fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setHealth(d as Health); })
      .catch(() => { /* capacity falls back to "unknown" */ });
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 401) {
        if (!expired.current) { expired.current = true; signOutRef.current(); }
        return;
      }
      if (!r.ok) { setConnectionLost(true); return; }
      const d = await r.json();
      setVms(d.vms || []);
      setSessions(d.sessions || []);
      setMeta({
        gpuSku: d.gpu_sku || 'GPU',
        price: d.price_per_hour ?? 1,
        maxMachines: d.max_machines === -1 ? Infinity : (d.max_machines || 3),
        freeMachines: d.free_machines ?? 1,
      });
      setAuth((a) => (a ? { ...a, user: { ...a.user, ...d.user } } : a));
      setConnectionLost(false);
      setLoaded(true);
    } catch {
      setConnectionLost(true);
    } finally {
      await healthReq;
    }
  }, [token, setAuth]);

  // Poll so provisioning machines flip to "running" without a manual reload.
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 4000);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Live uptime counters.
  useEffect(() => {
    const t = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const user = auth.user;
  const unlimited = !!user.unlimited;

  const machines = useMemo(
    () => [...sessions, ...vms].filter((r) => r.state === 'running' || r.state === 'provisioning'),
    [sessions, vms],
  );
  const activeCount = machines.length;
  const freeSlotsLeft = unlimited ? Infinity : Math.max(0, meta.freeMachines - activeCount);
  const billableRunning = unlimited ? 0 : Math.max(0, activeCount - meta.freeMachines);
  const atCap = !unlimited && activeCount >= meta.maxMachines;
  /** Server rule: past the free allowance, a zero balance is a hard 402. */
  const needsBalance = !unlimited && freeSlotsLeft === 0 && user.balance_minutes <= 0;
  const lowBalance = !unlimited && billableRunning > 0 && user.balance_minutes > 0 && user.balance_minutes <= 20;

  const post = useCallback(
    (path: string, body: unknown) =>
      fetch(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    [token],
  );

  const run = useCallback(
    async (key: string, path: string, body: unknown, fallbackMsg: string) => {
      if (busy) return;
      setBusy(key);
      setError('');
      try {
        const r = await post(path, body);
        if (!r.ok) {
          let msg = await readError(r, fallbackMsg);
          // The VRAM preflight can still lose a race with the poll: capacity
          // looked fine when the button rendered and was gone by the time the
          // request landed. Surface the server's own text, and never leave any
          // doubt about billing on a request that did nothing.
          if (r.status === 503 && !/charg/i.test(msg)) msg += ' Nothing was charged.';
          setError(msg);
        }
        await refresh();
      } catch {
        setError('Network error — check your connection and try again.');
      } finally {
        setBusy(null);
      }
    },
    [busy, post, refresh],
  );

  const spawnSession = () => run('session', '/api/session/spawn', { resolution: '1440x900' }, 'Could not start session');
  const deployVm = (os: 'windows' | 'linux') =>
    run(os, '/api/vms/provision', { os }, `Could not deploy ${os === 'windows' ? 'Windows' : 'Linux'}`);
  const destroySession = (id: string) => run(`d:${id}`, '/api/session/destroy', { sessionId: id }, 'Could not stop session');
  const destroyVm = (id: string) => run(`d:${id}`, '/api/vms/destroy', { vmId: id }, 'Could not stop machine');

  /** Removes the row for good. The server only allows it for stopped/failed
   *  machines and answers 409 otherwise, which is shown inside the dialog. */
  const runDelete = async () => {
    if (!confirmDelete || busy) return;
    const target = confirmDelete;
    setBusy(`x:${target.id}`);
    setDeleteError('');
    try {
      const r = target.kind === 'vm'
        ? await post('/api/vms/delete', { vmId: target.id })
        : await post('/api/session/delete', { sessionId: target.id });
      if (!r.ok) { setDeleteError(await readError(r, 'Could not delete this machine')); return; }
      setConfirmDelete(null);
      await refresh();
    } catch {
      setDeleteError('Network error — check your connection and try again.');
    } finally {
      setBusy(null);
    }
  };
  const askDelete = (kind: 'vm' | 'session', id: string, label: string) => {
    setDeleteError('');
    setConfirmDelete({ kind, id, label });
  };

  const blocked = atCap
    ? `Machine limit reached (${meta.maxMachines} max). Stop one first.`
    : needsBalance
      ? 'Top up to deploy another machine'
      : null;

  /** Ubuntu sessions are the only product the VRAM preflight guards, so the
   *  Windows/Linux VM cards keep the account-level `blocked` rule alone. */
  const capacity = readCapacity(health);
  const sessionBlocked = blocked ?? capacity.sessionBlocked;

  return (
    <div className="min-h-screen bg-ink-950 text-zinc-100">
      <a className="skip-link" href="#console">Skip to console</a>

      <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-3">
          <Logo />
          <div className="flex items-center gap-2 sm:gap-4">
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Balance</div>
              <div className="font-mono text-sm font-bold text-amber-300">
                {unlimited ? '∞' : fmtBalance(user.balance_minutes)}
              </div>
            </div>
            <button type="button" onClick={() => setPayOpen(true)} className={cx(BTN_AMBER, 'px-3 py-2 text-xs')}>
              <Bitcoin className="w-4 h-4" aria-hidden="true" />
              <span className="hidden sm:inline">Buy minutes</span>
              <span className="sr-only sm:hidden">Buy minutes</span>
            </button>
            <div className="hidden text-right md:block">
              <div className="text-sm font-bold text-cyan-300">
                @{user.username}
                {unlimited && <span className="ml-1 text-amber-400" title="Unlimited account">∞</span>}
              </div>
              <div className="text-[10px] text-zinc-500">
                {unlimited ? 'unlimited machines' : `${activeCount}/${meta.maxMachines} machines`}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setTab((t) => (t === 'guide' ? 'console' : 'guide'))}
              aria-label={tab === 'guide' ? 'Back to console' : 'How it works'}
              title={tab === 'guide' ? 'Back to console' : 'How it works'}
              aria-pressed={tab === 'guide'}
              className={cx(
                'rounded-lg border p-2 transition-colors',
                tab === 'guide'
                  ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-300'
                  : 'border-white/10 text-zinc-400 hover:border-white/25 hover:text-white',
              )}
            >
              <BookOpen className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => setTab((t) => (t === 'settings' ? 'console' : 'settings'))}
              aria-label={tab === 'settings' ? 'Back to console' : 'Settings'}
              title={tab === 'settings' ? 'Back to console' : 'Settings'}
              aria-pressed={tab === 'settings'}
              className={cx(
                'rounded-lg border p-2 transition-colors',
                tab === 'settings'
                  ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-300'
                  : 'border-white/10 text-zinc-400 hover:border-white/25 hover:text-white',
              )}
            >
              <SettingsIcon className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={onSignOut}
              aria-label="Sign out"
              title="Sign out"
              className="rounded-lg border border-white/10 p-2 text-zinc-400 hover:border-white/25 hover:text-white"
            >
              <LogOut className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <main id="console" className="mx-auto max-w-6xl space-y-8 px-5 py-8">
        <div aria-live="polite" className="space-y-3 empty:hidden">
          {error && (
            <Alert
              onDismiss={() => setError('')}
              action={
                /^insufficient balance/i.test(error) ? (
                  <button type="button" onClick={() => { setError(''); setPayOpen(true); }} className={cx(BTN_AMBER, 'px-3 py-1.5 text-xs')}>
                    <Bitcoin className="w-3.5 h-3.5" aria-hidden="true" /> Buy minutes
                  </button>
                ) : undefined
              }
            >
              {error}
            </Alert>
          )}
          {connectionLost && <Alert tone="warn">Lost contact with the gateway. Retrying every few seconds…</Alert>}
          {lowBalance && (
            <Alert
              tone="warn"
              action={
                <button type="button" onClick={() => setPayOpen(true)} className={cx(BTN_AMBER, 'px-3 py-1.5 text-xs')}>
                  <Bitcoin className="w-3.5 h-3.5" aria-hidden="true" /> Top up
                </button>
              }
            >
              Only {fmtBalance(user.balance_minutes)} left. Machines stop automatically when the balance hits zero.
            </Alert>
          )}
        </div>

        {tab === 'guide' ? (
          <GuideView health={health} onBack={() => setTab('console')} backLabel="Back to console" />
        ) : tab === 'settings' ? (
          <SettingsView
            token={token}
            fallbackUser={user}
            onBack={() => setTab('console')}
            onLoggedOutEverywhere={onSessionsRevoked}
          />
        ) : (
        <>
        {/* ---- Account summary ---- */}
        <section aria-label="Account summary" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="surface rounded-2xl p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-zinc-500">
              <Wallet className="w-3.5 h-3.5" aria-hidden="true" /> Balance
            </div>
            <div className="mt-2 font-mono text-3xl font-bold text-amber-300">
              {unlimited ? '∞' : fmtBalance(user.balance_minutes)}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {unlimited
                ? 'Unlimited account — never billed'
                : `≈ $${(user.balance_minutes / 60 * meta.price).toFixed(2)} of runtime`}
            </p>
          </div>

          <div className="surface rounded-2xl p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-zinc-500">
              <Monitor className="w-3.5 h-3.5" aria-hidden="true" /> Machines
            </div>
            <div className="mt-2 font-mono text-3xl font-bold text-cyan-300">
              {activeCount}
              <span className="text-lg text-zinc-600">/{unlimited ? '∞' : meta.maxMachines}</span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {unlimited
                ? 'No concurrency limit'
                : freeSlotsLeft > 0
                  ? `${freeSlotsLeft} free slot${freeSlotsLeft === 1 ? '' : 's'} remaining`
                  : `${billableRunning} billed at $${meta.price}/hr each`}
            </p>
          </div>

          <div className="surface rounded-2xl p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-zinc-500">
              <Zap className="w-3.5 h-3.5" aria-hidden="true" /> Burn rate
            </div>
            <div className="mt-2 font-mono text-3xl font-bold text-zinc-100">
              ${(billableRunning * meta.price).toFixed(2)}
              <span className="text-lg text-zinc-600">/hr</span>
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {billableRunning === 0 ? 'Nothing billing right now' : `${billableRunning} billable machine${billableRunning === 1 ? '' : 's'}`}
            </p>
          </div>

          <GpuCapacityCard capacity={capacity} gpuSku={meta.gpuSku} />
        </section>

        {/* ---- Deploy ---- */}
        <section aria-labelledby="deploy-h">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="deploy-h" className="text-xl font-bold tracking-tight">Deploy a machine</h2>
            <p className="text-xs text-zinc-500">
              ${meta.price}/hr · first {meta.freeMachines} machine{meta.freeMachines === 1 ? '' : 's'} free
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <ProductCard
              icon={<Terminal className="w-6 h-6" aria-hidden="true" />}
              accent="emerald"
              name="Ubuntu GPU Session"
              tag="In-browser desktop"
              desc="A full Ubuntu desktop streamed to your browser, with the GPU attached. Install anything and run CUDA jobs. The card is shared, so check the VRAM headroom above before a heavy run."
              cta="Spawn session"
              onClick={spawnSession}
              busy={busy === 'session'}
              disabled={!!busy || !!sessionBlocked}
              blockedReason={sessionBlocked}
              onBlockedAction={needsBalance && !atCap ? () => setPayOpen(true) : undefined}
            />
            <ProductCard
              icon={<Laptop className="w-6 h-6" aria-hidden="true" />}
              accent="cyan"
              name="Windows 10"
              tag="RDP · full desktop"
              desc="A real Windows 10 VM over RDP with administrator access. GUI apps and general compute — CPU and RAM only, no GPU attached."
              cta="Deploy Windows"
              onClick={() => deployVm('windows')}
              busy={busy === 'windows'}
              disabled={!!busy || !!blocked}
              blockedReason={blocked}
              onBlockedAction={needsBalance && !atCap ? () => setPayOpen(true) : undefined}
            />
            <ProductCard
              icon={<Server className="w-6 h-6" aria-hidden="true" />}
              accent="violet"
              name="Linux"
              tag="SSH · headless"
              desc="Debian 12 over SSH for headless compute, Docker and long-running server jobs — CPU and RAM only, no GPU attached."
              cta="Deploy Linux"
              onClick={() => deployVm('linux')}
              busy={busy === 'linux'}
              disabled={!!busy || !!blocked}
              blockedReason={blocked}
              onBlockedAction={needsBalance && !atCap ? () => setPayOpen(true) : undefined}
            />
          </div>
        </section>

        {/* ---- Resources ---- */}
        <section aria-labelledby="res-h">
          <h2 id="res-h" className="mb-4 text-xl font-bold tracking-tight">Your machines</h2>

          {!loaded ? (
            <div className="grid gap-4 md:grid-cols-2" aria-busy="true">
              <span className="sr-only">Loading your machines</span>
              <div className="skeleton h-56 rounded-2xl" />
              <div className="skeleton h-56 rounded-2xl" />
            </div>
          ) : vms.length === 0 && sessions.length === 0 ? (
            <div className="surface rounded-2xl px-6 py-14 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
                <Monitor className="w-6 h-6 text-cyan-400" aria-hidden="true" />
              </div>
              <h3 className="text-base font-semibold text-zinc-100">Nothing running yet</h3>
              <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-500">
                {needsBalance
                  ? 'Your free allowance is in use. Buy minutes with Bitcoin to start another machine.'
                  : `Your first ${meta.freeMachines} machine${meta.freeMachines === 1 ? '' : 's'} cost nothing. Spawn an Ubuntu GPU session to get going.`}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={() => { if (!busy && !sessionBlocked) spawnSession(); }}
                  aria-disabled={!!busy || !!sessionBlocked}
                  aria-busy={busy === 'session'}
                  aria-describedby={sessionBlocked ? 'empty-spawn-why' : undefined}
                  title={sessionBlocked ?? undefined}
                  className={cx(
                    BTN_PRIMARY, 'px-5 py-2.5 text-sm',
                    'aria-disabled:pointer-events-none aria-disabled:opacity-45',
                  )}
                >
                  {busy === 'session' ? <Spinner /> : <Terminal className="w-4 h-4" aria-hidden="true" />}
                  {busy === 'session' ? 'Starting…' : 'Spawn Ubuntu session'}
                </button>
                <button type="button" onClick={() => setPayOpen(true)} className={cx(BTN_GHOST, 'px-5 py-2.5 text-sm')}>
                  <Bitcoin className="w-4 h-4" aria-hidden="true" /> Buy minutes
                </button>
              </div>
              {sessionBlocked && (
                <p id="empty-spawn-why" className="mt-4 text-xs text-amber-400">{sessionBlocked}</p>
              )}
            </div>
          ) : (
            <ul className="grid list-none gap-4 p-0 md:grid-cols-2">
              {sessions.map((s) => (
                <li key={s.id}>
                  <SessionCard
                    s={s}
                    gpuSku={meta.gpuSku}
                    now={nowTs}
                    busy={busy === `d:${s.id}`}
                    deleting={busy === `x:${s.id}`}
                    disabled={!!busy}
                    onStop={() => destroySession(s.id)}
                    onDelete={() => askDelete('session', s.id, `Ubuntu GPU session ${s.instance_id}`)}
                  />
                </li>
              ))}
              {vms.map((vm) => (
                <li key={vm.id}>
                  <VmCard
                    vm={vm}
                    now={nowTs}
                    busy={busy === `d:${vm.id}`}
                    deleting={busy === `x:${vm.id}`}
                    disabled={!!busy}
                    onStop={() => destroyVm(vm.id)}
                    onDelete={() => askDelete('vm', vm.id, `${vm.os === 'windows' ? 'Windows 10' : 'Linux'} machine #${vm.vm_id}`)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="border-t border-white/10 pt-6 text-center text-xs text-zinc-600">
          ${meta.price}/hr per billed machine · first {meta.freeMachines} free ·{' '}
          {unlimited ? 'unlimited' : meta.maxMachines} concurrent max · Bitcoin via BTCPay
        </p>
        </>
        )}
      </main>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this machine?"
          confirmLabel="Delete permanently"
          busyLabel="Deleting…"
          busy={busy === `x:${confirmDelete.id}`}
          error={deleteError}
          icon={<Trash2 className="w-5 h-5 text-red-400" aria-hidden="true" />}
          onConfirm={runDelete}
          onClose={() => { if (!busy) { setConfirmDelete(null); setDeleteError(''); } }}
        >
          <p>
            <span className="font-semibold text-zinc-200">{confirmDelete.label}</span> will be removed from your
            console for good.
          </p>
          <p>
            This cannot be undone, and anything left on its disk goes with it. Deleting a stopped machine does not
            cost or refund any balance.
          </p>
        </ConfirmDialog>
      )}

      {payOpen && <PayModal token={token} pricePerHour={meta.price} currentMinutes={user.balance_minutes} onClose={() => setPayOpen(false)} onCredited={refresh} />}
    </div>
  );
}

/* ------------------------------------------------------------ dash cards */

/**
 * Real VRAM headroom on the session node. The headline number moves with every
 * poll, so it sits outside the live region — only `detail`, which changes when
 * the *state* changes, is announced, otherwise assistive tech would read a new
 * megabyte count every four seconds.
 */
function GpuCapacityCard({ capacity, gpuSku }: { capacity: Capacity; gpuSku: string }) {
  const { state, freeMb, totalMb, minMb, detail } = capacity;
  const tone =
    state === 'ready' ? 'text-emerald-300'
      : state === 'busy' ? 'text-amber-300'
        : state === 'offline' ? 'text-red-300'
          : 'text-zinc-500';
  const bar =
    state === 'ready' ? 'bg-emerald-400' : state === 'busy' ? 'bg-amber-400' : 'bg-zinc-600';
  const pct = totalMb > 0 ? Math.min(100, Math.max(0, (freeMb / totalMb) * 100)) : 0;
  const headline =
    state === 'unknown' ? '—' : state === 'offline' ? 'Offline' : fmtVram(freeMb);

  return (
    <div className="surface rounded-2xl p-5">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-zinc-500">
        <Cpu className="w-3.5 h-3.5" aria-hidden="true" /> GPU capacity
      </div>
      <div className={cx('mt-2 font-mono text-3xl font-bold leading-none', tone)}>
        {headline}
        {(state === 'ready' || state === 'busy') && (
          <span className="ml-1 text-lg text-zinc-600">free</span>
        )}
      </div>

      {totalMb > 0 && state !== 'offline' && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <div className={cx('h-full rounded-full transition-[width] duration-500', bar)} style={{ width: `${pct}%` }} />
        </div>
      )}

      <p className="mt-2 text-xs leading-relaxed text-zinc-500" aria-live="polite">{detail}</p>
      <p className="mt-1 truncate text-[11px] text-zinc-600" title={gpuSku}>
        {gpuSku}
        {minMb > 0 && state !== 'unknown' && ` · session needs ${Math.round(minMb)} MiB`}
      </p>
    </div>
  );
}

function ProductCard({
  icon, name, tag, desc, cta, onClick, accent, busy, disabled, blockedReason, onBlockedAction,
}: {
  icon: React.ReactNode; name: string; tag: string; desc: string; cta: string;
  onClick: () => void; accent: keyof typeof ACCENTS;
  busy: boolean; disabled: boolean; blockedReason: string | null;
  onBlockedAction?: () => void;
}) {
  const a = ACCENTS[accent];
  const showTopUp = !!blockedReason && !!onBlockedAction;
  /** A blocked control has to say why in a way a keyboard or screen-reader user
   *  can actually reach. A natively `disabled` button drops out of the tab order
   *  and takes its own description with it, so it is marked aria-disabled
   *  instead: still focusable, still announced, but inert on click. */
  const whyId = `why-${useId()}`;
  const showWhy = !!blockedReason && !showTopUp;
  const inert = disabled || busy;
  return (
    <div className={cx('surface surface-hover flex flex-col rounded-2xl p-5', a.ring)}>
      <div className={cx('mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5', a.text)}>
        {icon}
      </div>
      <h3 className="font-semibold text-zinc-100">{name}</h3>
      <p className={cx('mt-0.5 text-[11px] font-medium uppercase tracking-wider', a.text)}>{tag}</p>
      <p className="mt-3 flex-1 text-sm leading-relaxed text-zinc-400">{desc}</p>

      {showTopUp ? (
        <button type="button" onClick={onBlockedAction} className={cx(BTN_AMBER, 'mt-5 w-full py-3 text-sm')}>
          <Bitcoin className="w-4 h-4" aria-hidden="true" /> {blockedReason}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => { if (!inert) onClick(); }}
          aria-disabled={inert}
          aria-busy={busy}
          aria-describedby={showWhy ? whyId : undefined}
          title={blockedReason ?? undefined}
          className={cx(
            BTN_BASE, a.btn, 'mt-5 w-full py-3 text-sm',
            // pointer-events-none also kills the accent hover state, which would
            // otherwise light up an inert button. Focus is unaffected.
            'aria-disabled:pointer-events-none aria-disabled:opacity-45',
          )}
        >
          {busy ? <><Spinner /> Starting…</> : <>{cta} <ArrowRight className="w-4 h-4" aria-hidden="true" /></>}
        </button>
      )}

      {showWhy && (
        <p id={whyId} className="mt-2 text-center text-[11px] leading-relaxed text-amber-400">{blockedReason}</p>
      )}
    </div>
  );
}

function SessionCard({
  s, gpuSku, now, busy, deleting, disabled, onStop, onDelete,
}: {
  s: ApiSession; gpuSku: string; now: number; busy: boolean; deleting: boolean;
  disabled: boolean; onStop: () => void; onDelete: () => void;
}) {
  const isRunning = s.state === 'running';
  const isProvisioning = s.state === 'provisioning';
  const isActive = isRunning || isProvisioning;
  /** The server refuses to delete anything still running. */
  const removable = s.state === 'stopped' || s.state === 'failed';

  return (
    <article
      className={cx(
        'surface flex h-full flex-col rounded-2xl p-5',
        isRunning && 'border-emerald-400/35 shadow-[0_20px_50px_-30px_rgba(16,185,129,0.7)]',
        isProvisioning && 'border-amber-400/30',
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-emerald-400">
            <Terminal className="w-4 h-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-semibold">Ubuntu GPU Session</h3>
            <p className="truncate font-mono text-[11px] text-zinc-500">{s.instance_id} · {gpuSku}</p>
          </div>
        </div>
        <StateBadge state={s.state} />
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <div>
          <dt className="text-zinc-500">Resolution</dt>
          <dd className="font-mono text-zinc-200">{s.resolution}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-zinc-500"><Clock className="w-3 h-3" aria-hidden="true" /> Uptime</dt>
          <dd className="font-mono text-zinc-200">{isActive ? fmtUptime(s.created_at, now) : '—'}</dd>
        </div>
        <div className="col-span-2">
          <dt className="flex items-center gap-1 text-zinc-500"><Globe className="w-3 h-3" aria-hidden="true" /> Egress proxy</dt>
          <dd className="truncate font-mono text-cyan-300">{s.proxy || 'none assigned (pool refreshing)'}</dd>
        </div>
      </dl>

      <div className="mt-auto pt-4">
        <div className="flex gap-2">
          {isRunning ? (
            <a
              href={desktopUrlFor(s)}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(BTN_BASE, 'flex-1 bg-emerald-400 py-2.5 text-sm text-ink-950 hover:bg-emerald-300')}
            >
              <ExternalLink className="w-4 h-4" aria-hidden="true" /> Open desktop
            </a>
          ) : isProvisioning ? (
            <span className={cx(BTN_BASE, 'flex-1 cursor-wait bg-white/5 py-2.5 text-sm text-zinc-300')} aria-live="polite">
              <Spinner className="w-4 h-4 text-amber-400" /> Booting desktop…
            </span>
          ) : (
            <span className={cx(BTN_BASE, 'flex-1 bg-white/5 py-2.5 text-sm text-zinc-500')}>
              <Power className="w-4 h-4" aria-hidden="true" />{' '}
              {s.state === 'failed' ? 'Failed to start' : s.state === 'stopping' ? 'Stopping…' : 'Stopped'}
            </span>
          )}
          {isActive && (
            <button
              type="button"
              onClick={onStop}
              disabled={disabled}
              aria-busy={busy}
              aria-label={`Stop session ${s.instance_id}`}
              className={cx(BTN_BASE, 'border border-red-500/40 px-4 py-2.5 text-xs text-red-300 hover:bg-red-500/10')}
            >
              {busy ? <Spinner className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" aria-hidden="true" />} Stop
            </button>
          )}
          {removable && (
            <button
              type="button"
              onClick={onDelete}
              disabled={disabled}
              aria-busy={deleting}
              aria-label={`Delete session ${s.instance_id}`}
              className={cx(BTN_BASE, 'border border-red-500/40 px-4 py-2.5 text-xs text-red-300 hover:bg-red-500/10')}
            >
              {deleting ? <Spinner className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          )}
        </div>
        <div className="mt-3">
          <CopyField label="VNC password" value={s.password} secret />
        </div>
      </div>
    </article>
  );
}

function VmCard({
  vm, now, busy, deleting, disabled, onStop, onDelete,
}: {
  vm: ApiVm; now: number; busy: boolean; deleting: boolean;
  disabled: boolean; onStop: () => void; onDelete: () => void;
}) {
  const isWin = vm.os === 'windows';
  const isActive = vm.state === 'running' || vm.state === 'provisioning';
  /** The server refuses to delete anything still running. */
  const removable = vm.state === 'stopped' || vm.state === 'failed';
  /** null until the host address lands — see the waiting state below. */
  const endpoint = vmEndpoint(vm.os, vm.ip, vm.port, vm.username);
  return (
    <article
      className={cx(
        'surface flex h-full flex-col rounded-2xl p-5',
        vm.state === 'running' && (isWin ? 'border-cyan-400/35' : 'border-violet-400/35'),
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5', isWin ? 'text-cyan-400' : 'text-violet-400')}>
            {isWin ? <Laptop className="w-4 h-4" aria-hidden="true" /> : <Server className="w-4 h-4" aria-hidden="true" />}
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-semibold">{isWin ? 'Windows 10' : 'Linux'}</h3>
            <p className="truncate font-mono text-[11px] text-zinc-500">#{vm.vm_id} · {vm.sku}</p>
          </div>
        </div>
        <StateBadge state={vm.state} />
      </header>

      {vm.state === 'provisioning' && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-xs text-amber-200" aria-live="polite">
          <Spinner className="w-3.5 h-3.5" /> Cloning the template and booting — this takes a couple of minutes.
          Connection details appear here the moment it is running.
        </p>
      )}
      {(vm.state === 'stopping' || vm.state === 'stopped') && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-zinc-400">
          {vm.state === 'stopping'
            ? <><Spinner className="w-3.5 h-3.5" /> Shutting down — this machine has stopped billing.</>
            : <><Power className="w-3.5 h-3.5" aria-hidden="true" /> Stopped and no longer billing. Delete it to clear it from the console.</>}
        </p>
      )}
      {vm.state === 'failed' && (
        <p className="mt-4 rounded-lg border border-red-500/30 bg-red-950/30 px-3 py-2 text-xs text-red-200">
          Provisioning failed. Nothing was charged for this machine — try deploying again.
        </p>
      )}

      {vm.state === 'running' && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-[11px]">
            <span className="flex items-center gap-1.5 text-zinc-500">
              <Plug className="w-3.5 h-3.5" aria-hidden="true" /> {endpoint?.protocol ?? (isWin ? 'RDP' : 'SSH')}
            </span>
            <span className="text-cyan-300">port {vm.port ?? '—'}</span>
          </div>
          {/* `ip` is written when the clone finishes. A row that reports
           *  `running` normally has one, but a drifted row might not — so the
           *  address is rendered from the endpoint or not at all, never as the
           *  string "null". */}
          {endpoint ? (
            <>
              <CopyField label="host" value={endpoint.address} />
              <CopyField label={isWin ? 'rdp' : 'ssh'} value={endpoint.command} />
            </>
          ) : (
            <p
              className="flex items-center gap-2 rounded-lg border border-amber-400/25 bg-amber-400/5 px-2.5 py-2 text-[11px] text-amber-200"
              aria-live="polite"
            >
              <Spinner className="w-3.5 h-3.5" /> Waiting for the host address — it appears as soon as the host reports it.
            </p>
          )}
          {vm.username && <CopyField label="user" value={vm.username} />}
          {vm.password && <CopyField label="pass" value={vm.password} secret />}
          <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <Clock className="w-3 h-3" aria-hidden="true" /> Uptime {fmtUptime(vm.created_at, now)}
          </p>
        </div>
      )}

      {isActive && (
        <div className="mt-auto pt-4">
          <button
            type="button"
            onClick={onStop}
            disabled={disabled}
            aria-busy={busy}
            aria-label={`Stop ${isWin ? 'Windows' : 'Linux'} machine ${vm.vm_id}`}
            className={cx(BTN_BASE, 'w-full border border-red-500/40 py-2.5 text-xs text-red-300 hover:bg-red-500/10')}
          >
            {busy ? <Spinner className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" aria-hidden="true" />}
            {busy ? 'Stopping…' : 'Stop machine'}
          </button>
        </div>
      )}

      {removable && (
        <div className="mt-auto pt-4">
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            aria-busy={deleting}
            aria-label={`Delete ${isWin ? 'Windows' : 'Linux'} machine ${vm.vm_id}`}
            className={cx(BTN_BASE, 'w-full border border-red-500/40 py-2.5 text-xs text-red-300 hover:bg-red-500/10')}
          >
            {deleting ? <Spinner className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />}
            {deleting ? 'Deleting…' : 'Delete machine'}
          </button>
        </div>
      )}
    </article>
  );
}

/* ------------------------------------------------------------- pay modal */

const PRESETS = [1, 5, 12, 24];

function PayModal({
  token, pricePerHour, currentMinutes, onClose, onCredited,
}: {
  token: string; pricePerHour: number; currentMinutes: number;
  onClose: () => void; onCredited: () => void;
}) {
  const [usd, setUsd] = useState(5);
  const [invoice, setInvoice] = useState<{ amountUsd: number; minutesAdded: number; checkoutLink: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [credited, setCredited] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const baseline = useRef(currentMinutes);

  // Escape to close + focus trapped inside the dialog.
  useDialogChrome(dialogRef, onClose);

  const create = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/btcpay/create-invoice', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ usdAmount: usd }),
      });
      if (!r.ok) { setError(await readError(r, 'Could not create the invoice')); return; }
      const d = await r.json();
      if (!d?.checkoutLink) { setError('BTCPay returned no checkout link. Try again shortly.'); return; }
      setInvoice(d);
    } catch {
      setError('Network error — could not reach the payment service.');
    } finally {
      setLoading(false);
    }
  };

  // Watch for the webhook crediting the balance; stop after 20 minutes.
  useEffect(() => {
    if (!invoice) return;
    let ticks = 0;
    const t = window.setInterval(async () => {
      ticks++;
      if (ticks > 240) { window.clearInterval(t); return; }
      try {
        const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        const d = await r.json();
        if ((d?.user?.balance_minutes ?? 0) > baseline.current) {
          window.clearInterval(t);
          setCredited(true);
          onCredited();
        }
      } catch { /* keep waiting */ }
    }, 5000);
    return () => window.clearInterval(t);
  }, [invoice, token, onCredited]);

  const minutes = Math.round((usd / (pricePerHour || 1)) * 60);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pay-title"
        className="surface my-auto w-full max-w-md rounded-2xl border-amber-400/30 p-6"
      >
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h2 id="pay-title" className="flex items-center gap-2 text-lg font-bold">
              <Bitcoin className="w-5 h-5 text-amber-400" aria-hidden="true" /> Buy GPU minutes
            </h2>
            <p className="mt-1 text-xs text-zinc-500">Paid in Bitcoin via BTCPay. No card, no account details.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded-lg p-1.5 text-zinc-500 hover:bg-white/5 hover:text-white"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div aria-live="polite">
          {error && <div className="mb-4"><Alert onDismiss={() => setError('')}>{error}</Alert></div>}
        </div>

        {credited ? (
          <div className="py-6 text-center">
            <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-400" aria-hidden="true" />
            <h3 className="font-semibold text-emerald-300">Payment confirmed</h3>
            <p className="mt-1 text-sm text-zinc-400">Your balance has been credited.</p>
            <button type="button" onClick={onClose} className={cx(BTN_PRIMARY, 'mt-5 w-full py-3 text-sm')}>
              Back to console
            </button>
          </div>
        ) : !invoice ? (
          <div className="space-y-5">
            <fieldset>
              <legend className="mb-2 text-xs font-medium uppercase tracking-widest text-zinc-500">Amount</legend>
              <div className="grid grid-cols-4 gap-2">
                {PRESETS.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => setUsd(h)}
                    aria-pressed={usd === h}
                    className={cx(
                      'rounded-xl border p-3 text-center transition-colors',
                      usd === h
                        ? 'border-amber-400 bg-amber-400/10 text-amber-300'
                        : 'border-white/10 text-zinc-400 hover:border-white/25',
                    )}
                  >
                    <span className="block font-bold">${h}</span>
                    <span className="block text-[10px]">{h}h</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-zinc-500">Or a custom amount (USD)</span>
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={usd}
                onChange={(e) => setUsd(Math.max(1, Math.min(1000, Math.round(Number(e.target.value) || 1))))}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 font-mono text-sm text-amber-300 outline-none focus:border-amber-400"
              />
            </label>

            <p className="rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-sm text-zinc-400">
              <span className="font-mono text-amber-300">${usd}.00</span> credits{' '}
              <span className="font-mono text-zinc-100">{minutes}</span> minutes
              <span className="text-zinc-500"> ({fmtBalance(minutes)}) of billed runtime.</span>
            </p>

            <button type="button" onClick={create} disabled={loading} aria-busy={loading} className={cx(BTN_AMBER, 'w-full py-3 text-sm')}>
              {loading ? <><Spinner /> Creating invoice…</> : <>Continue to Bitcoin checkout <ArrowRight className="w-4 h-4" aria-hidden="true" /></>}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border border-white/10 bg-black/30 p-4 text-center">
              <div className="font-mono text-3xl font-bold text-amber-400">${invoice.amountUsd}.00</div>
              <div className="mt-1 text-xs text-zinc-500">credits {invoice.minutesAdded} minutes</div>
            </div>
            <a
              href={invoice.checkoutLink}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(BTN_AMBER, 'w-full py-3 text-sm')}
            >
              <ExternalLink className="w-4 h-4" aria-hidden="true" /> Open Bitcoin checkout
            </a>
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-xs">
              <span className="flex-1 truncate font-mono text-cyan-300">{invoice.checkoutLink}</span>
              <button
                type="button"
                aria-label="Copy checkout link"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(invoice.checkoutLink);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  } catch { /* clipboard blocked */ }
                }}
                className="font-bold text-amber-400 hover:text-amber-300"
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="flex items-center justify-center gap-2 text-center text-[11px] text-zinc-500" aria-live="polite">
              <Spinner className="w-3 h-3" /> Waiting for on-chain confirmation — your balance credits automatically.
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------- auth gate */

function AuthGate({ onAuthed, onBack }: { onAuthed: (a: Auth) => void; onBack: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const health = useHealth();

  // Mirrors the server's validation exactly, so users never round-trip for it.
  const usernameOk = /^[a-zA-Z0-9_.-]{3,32}$/.test(username.trim());
  const passwordOk = password.length >= 6;
  const canSubmit = mode === 'login'
    ? username.trim().length > 0 && password.length > 0
    : usernameOk && passwordOk;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || loading) return;
    setLoading(true);
    setError('');
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!r.ok) { setError(await readError(r, mode === 'login' ? 'Sign in failed' : 'Registration failed')); return; }
      const d = await r.json();
      if (!d?.token) { setError('Unexpected response from the server.'); return; }
      onAuthed({ token: d.token, user: d.user });
    } catch {
      setError('Network error — could not reach the gateway.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-12">
      <div className="pointer-events-none absolute inset-0 bg-aurora" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden="true" />

      <div className="relative w-full max-w-md">
        <button
          type="button"
          onClick={onBack}
          className="mb-6 inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-white"
        >
          <ArrowRight className="w-4 h-4 rotate-180" aria-hidden="true" /> Back to home
        </button>

        <div className="mb-8 text-center">
          <Logo className="text-2xl" />
          <h1 className="mt-4 text-2xl font-bold tracking-tight">
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="mt-2 text-sm text-zinc-400">
            Username and password only. No email, no KYC, no card.
          </p>
        </div>

        <div role="tablist" aria-label="Authentication mode" className="mb-4 grid grid-cols-2 gap-2">
          {(['login', 'register'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => { setMode(m); setError(''); }}
              className={cx(
                'flex items-center justify-center gap-2 rounded-xl border py-2.5 text-sm font-semibold transition-colors',
                mode === m
                  ? 'border-cyan-400 bg-cyan-400/10 text-cyan-300'
                  : 'border-white/10 text-zinc-400 hover:border-white/25',
              )}
            >
              {m === 'login'
                ? <><LogIn className="w-4 h-4" aria-hidden="true" /> Sign in</>
                : <><UserPlus className="w-4 h-4" aria-hidden="true" /> Register</>}
            </button>
          ))}
        </div>

        <form onSubmit={submit} noValidate className="surface space-y-4 rounded-2xl p-6">
          <div>
            <label htmlFor="username" className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-zinc-500">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="satoshi"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              aria-describedby="username-hint"
              className={INPUT_CLS}
            />
            <p id="username-hint" className={cx('mt-1.5 text-[11px]', mode === 'register' && username && !usernameOk ? 'text-amber-400' : 'text-zinc-600')}>
              3–32 characters: letters, numbers, and <span className="font-mono">_ . -</span>
            </p>
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-zinc-500">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? 'at least 6 characters' : 'your password'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                aria-describedby="password-hint"
                className={cx(INPUT_CLS, 'pr-12')}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex items-center px-3 text-zinc-500 hover:text-white"
              >
                {showPw ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
              </button>
            </div>
            <p id="password-hint" className={cx('mt-1.5 text-[11px]', mode === 'register' && password && !passwordOk ? 'text-amber-400' : 'text-zinc-600')}>
              {mode === 'register'
                ? 'Minimum 6 characters. There is no email recovery — store it safely.'
                : 'Accounts are anonymous; passwords cannot be reset.'}
            </p>
          </div>

          <div aria-live="assertive">
            {error && <Alert onDismiss={() => setError('')}>{error}</Alert>}
          </div>

          <button type="submit" disabled={!canSubmit || loading} aria-busy={loading} className={cx(BTN_PRIMARY, 'w-full py-3 text-sm')}>
            {loading
              ? <><Spinner /> {mode === 'login' ? 'Signing in…' : 'Creating account…'}</>
              : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>

        <p className="mt-5 text-center text-[11px] text-zinc-600">
          ${health?.priceUsdPerHour ?? 1}/hr · first {health?.freeMachines ?? 1} machine free · up to{' '}
          {health?.maxVmsPerUser ?? 3} concurrent · Bitcoin via BTCPay
        </p>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- landing page */

/** In-page anchors, plus one entry that leaves the page for the full guide.
 *  Kept as one list so the desktop nav and the mobile menu cannot drift. */
const NAV_LINKS: Array<{ label: string; href?: string; guide?: true }> = [
  { href: '#hardware', label: 'Hardware' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#how', label: 'How it works' },
  { label: 'Guide', guide: true },
  { href: '#faq', label: 'FAQ' },
];

/** The signed-out guide, wrapped in the site's own header and footer so it is a
 *  real destination rather than a modal bolted onto the landing page. */
function GuidePage({ onBack, onLaunch }: { onBack: () => void; onLaunch: () => void }) {
  const health = useHealth();
  return (
    <div className="min-h-screen bg-ink-950 text-zinc-100">
      <a className="skip-link" href="#guide">Skip to the guide</a>

      <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-5 py-3.5">
          <button type="button" onClick={onBack} aria-label="VortexGPU home" className="shrink-0">
            <Logo />
          </button>
          <button type="button" onClick={onLaunch} className={cx(BTN_PRIMARY, 'px-4 py-2 text-sm')}>
            Launch console
          </button>
        </div>
      </header>

      <main id="guide" className="mx-auto max-w-6xl px-5 py-8">
        <GuideView health={health} onBack={onBack} backLabel="Back to home" onGetStarted={onLaunch} />
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-10 md:flex-row">
          <Logo />
          {/* No price here on purpose: the guide body already prints the live
              figure, and a second copy would need a hardcoded fallback. */}
          <p className="text-center text-xs text-zinc-600">Bitcoin via BTCPay · No KYC</p>
        </div>
      </footer>
    </div>
  );
}

function LandingPage({ onLaunch, onGuide }: { onLaunch: () => void; onGuide: () => void }) {
  const health = useHealth();
  const [menuOpen, setMenuOpen] = useState(false);

  const price = health?.priceUsdPerHour ?? 1;
  const freeMachines = health?.freeMachines ?? 1;
  const maxMachines = health?.maxVmsPerUser ?? 3;
  const gpuSku = health?.gpuSku ?? 'NVIDIA GeForce RTX 4080 SUPER 16GB';
  const capacity = readCapacity(health);

  return (
    <div className="min-h-screen bg-ink-950 text-zinc-100">
      <a className="skip-link" href="#main">Skip to content</a>

      {/* ---- Nav ---- */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-ink-950/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5">
          <a href="#main" className="shrink-0"><Logo /></a>

          <nav aria-label="Primary" className="hidden items-center gap-7 text-sm text-zinc-400 md:flex">
            {NAV_LINKS.map((l) => (
              l.guide ? (
                <button key={l.label} type="button" onClick={onGuide} className="transition-colors hover:text-white">
                  {l.label}
                </button>
              ) : (
                <a key={l.label} href={l.href} className="transition-colors hover:text-white">{l.label}</a>
              )
            ))}
          </nav>

          <div className="flex items-center gap-2">
            <button type="button" onClick={onLaunch} className={cx(BTN_PRIMARY, 'px-4 py-2 text-sm')}>
              Launch console
            </button>
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              className="rounded-lg border border-white/10 p-2 text-zinc-300 md:hidden"
            >
              {menuOpen ? <X className="w-5 h-5" aria-hidden="true" /> : <Menu className="w-5 h-5" aria-hidden="true" />}
            </button>
          </div>
        </div>

        {menuOpen && (
          <nav id="mobile-nav" aria-label="Primary mobile" className="border-t border-white/10 md:hidden">
            <ul className="mx-auto flex max-w-6xl list-none flex-col gap-1 p-3">
              {NAV_LINKS.map((l) => (
                <li key={l.label}>
                  {l.guide ? (
                    <button
                      type="button"
                      onClick={() => { setMenuOpen(false); onGuide(); }}
                      className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-zinc-300 hover:bg-white/5"
                    >
                      {l.label} <ChevronRight className="w-4 h-4 text-zinc-600" aria-hidden="true" />
                    </button>
                  ) : (
                    <a
                      href={l.href}
                      onClick={() => setMenuOpen(false)}
                      className="flex items-center justify-between rounded-lg px-3 py-2.5 text-sm text-zinc-300 hover:bg-white/5"
                    >
                      {l.label} <ChevronRight className="w-4 h-4 text-zinc-600" aria-hidden="true" />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        )}
      </header>

      <main id="main">
        {/* ---- Hero ---- */}
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-0 bg-aurora" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-0 bg-grid" aria-hidden="true" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-16 md:py-24 lg:grid-cols-2">
            <div className="animate-rise">
              <StatusPill capacity={capacity} />

              <h1 className="mt-6 text-display font-black">
                Rent a real GPU PC,{' '}
                <span className="bg-gradient-to-r from-cyan-300 via-cyan-400 to-emerald-400 bg-clip-text text-transparent">
                  by the hour
                </span>
                .
              </h1>

              <p className="mt-6 max-w-lg text-lg leading-relaxed text-zinc-400">
                A full Ubuntu desktop with an{' '}
                <span className="font-semibold text-zinc-100">RTX&nbsp;4080&nbsp;SUPER</span> attached — in your browser
                in about a minute. Windows over RDP and Linux over SSH too. Settled in Bitcoin, no card and no KYC.
              </p>

              <div className="mt-9 flex flex-wrap gap-3">
                <button type="button" onClick={onLaunch} className={cx(BTN_PRIMARY, 'px-6 py-3.5 text-base')}>
                  Get started — ${price}/hr <ArrowRight className="w-4 h-4" aria-hidden="true" />
                </button>
                <a href="#pricing" className={cx(BTN_GHOST, 'px-6 py-3.5 text-base')}>See pricing</a>
              </div>

              <ul className="mt-9 flex list-none flex-wrap gap-x-6 gap-y-2.5 p-0 text-sm text-zinc-500">
                {[
                  `First ${freeMachines} machine free`,
                  'No email, no KYC',
                  'Per-minute billing',
                ].map((t) => (
                  <li key={t} className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" aria-hidden="true" /> {t}
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative h-[320px] md:h-[420px]">
              <Suspense
                fallback={<div className="surface h-full w-full rounded-2xl bg-aurora" aria-hidden="true" />}
              >
                <Cyber3DCanvas
                  vmState="running"
                  intensity={70}
                  caption={
                    <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/60 px-3 py-2 backdrop-blur">
                      <span className="truncate font-mono text-[11px] text-cyan-300">{gpuSku}</span>
                      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-amber-300">
                        <Bitcoin className="w-3.5 h-3.5" aria-hidden="true" /> BTC
                      </span>
                    </div>
                  }
                />
              </Suspense>
            </div>
          </div>
        </section>

        {/* ---- Stat bar (real values from /api/health) ---- */}
        <section aria-label="At a glance" className="border-y border-white/10 bg-white/[0.015]">
          <div className="mx-auto grid max-w-6xl grid-cols-2 gap-6 px-5 py-8 text-center md:grid-cols-4">
            {[
              [`$${price}`, 'per hour, per machine'],
              [`${freeMachines}`, `machine${freeMachines === 1 ? '' : 's'} free, always`],
              ['4080 SUPER', 'shared — live headroom shown'],
            ].map(([v, l]) => (
              <div key={l}>
                <div className="font-mono text-2xl font-black text-cyan-300 md:text-3xl">{v}</div>
                <div className="mt-1.5 text-[11px] uppercase tracking-wider text-zinc-500">{l}</div>
              </div>
            ))}
            {/* Live VRAM, not a fixed "16GB" — the card is shared, so the honest
                number is what is free on the session node right now. The hero
                pill owns the live announcement; this cell would only echo it. */}
            <div>
              <div
                className={cx(
                  'font-mono text-2xl font-black md:text-3xl',
                  capacity.state === 'busy' ? 'text-amber-300'
                    : capacity.state === 'offline' ? 'text-red-300'
                      : 'text-cyan-300',
                )}
              >
                {capacity.state === 'unknown' ? '—' : capacity.state === 'offline' ? 'Offline' : fmtVram(capacity.freeMb)}
              </div>
              <div className="mt-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
                {capacity.state === 'offline' ? 'session node offline' : 'GPU VRAM free right now'}
              </div>
            </div>
          </div>
        </section>

        {/* ---- Hardware / products ---- */}
        <section id="hardware" className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <SectionHead
            eyebrow="Three ways to compute"
            title="One GPU, whichever interface you want"
            sub="Every machine is a real isolated instance, not a queued batch job. The GPU is attached to the Ubuntu session; the Windows and Linux VMs are CPU and RAM only."
          />
          <div className="grid gap-5 md:grid-cols-3">
            <FeatureCard
              icon={<Terminal className="w-6 h-6" aria-hidden="true" />} accent="emerald"
              name="Ubuntu GPU Session" tag="In-browser · noVNC"
              desc="A full Ubuntu desktop streamed to your browser with the RTX 4080 attached. Nothing to install locally — open a tab and you have a workstation."
            />
            <FeatureCard
              icon={<Laptop className="w-6 h-6" aria-hidden="true" />} accent="cyan"
              name="Windows 10" tag="RDP · full desktop"
              desc="A real Windows 10 VM over RDP with administrator access. GUI applications and general compute on a genuine desktop — CPU and RAM only, no GPU attached."
            />
            <FeatureCard
              icon={<Server className="w-6 h-6" aria-hidden="true" />} accent="violet"
              name="Linux" tag="SSH · headless"
              desc="Debian 12 over SSH with root. Docker and long-lived server jobs, without a desktop in the way. CPU and RAM only — for GPU work use the Ubuntu session."
            />
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              [<Cpu key="i" className="w-5 h-5 text-cyan-400" aria-hidden="true" />, 'Real GPU', 'A physical RTX 4080 SUPER, shared — live headroom shown before you deploy'],
              [<Shield key="i" className="w-5 h-5 text-emerald-400" aria-hidden="true" />, 'No KYC', 'Username, password, Bitcoin. Nothing else collected'],
              [<Globe key="i" className="w-5 h-5 text-violet-400" aria-hidden="true" />, 'Clean egress', 'Sessions get a residential proxy when the pool has one'],
              [<Lock key="i" className="w-5 h-5 text-amber-400" aria-hidden="true" />, 'Isolated', 'Your own instance with full root. Stop halts billing; delete reclaims it'],
            ].map(([ic, t, d]) => (
              <div key={String(t)} className="surface rounded-xl p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">{ic}{t}</div>
                <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{d}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---- Pricing ---- */}
        <section id="pricing" className="border-t border-white/10 bg-white/[0.015]">
          <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
            <SectionHead
              eyebrow="Pricing"
              title="One price. No subscription."
              sub={`$${price} per hour per billed machine, charged by the minute. Your first ${freeMachines} concurrent machine${freeMachines === 1 ? '' : 's'} cost${freeMachines === 1 ? 's' : ''} nothing.`}
            />
            <div className="mx-auto grid max-w-4xl gap-5 md:grid-cols-3">
              {[
                { usd: 1, label: 'Try it', desc: 'Enough for a quick render or a model test.', featured: false },
                { usd: 5, label: 'A session', desc: 'The usual top-up for an afternoon of work.', featured: true },
                { usd: 24, label: 'A full day', desc: 'Long training runs and overnight jobs.', featured: false },
              ].map((t) => (
                <div
                  key={t.usd}
                  className={cx(
                    'surface relative flex flex-col rounded-2xl p-7 text-center',
                    t.featured && 'border-cyan-400/40 shadow-[0_24px_60px_-40px_rgba(34,211,238,0.9)]',
                  )}
                >
                  {t.featured && (
                    <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-cyan-400 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-950">
                      Most common
                    </span>
                  )}
                  <div className="text-sm font-semibold text-zinc-400">{t.label}</div>
                  <div className="my-3 font-mono text-4xl font-black text-zinc-50">${t.usd}</div>
                  <div className="font-mono text-xs text-cyan-300">
                    = {Math.round((t.usd / price) * 60)} minutes
                  </div>
                  <p className="mt-4 mb-7 flex-1 text-xs leading-relaxed text-zinc-500">{t.desc}</p>
                  <button type="button" onClick={onLaunch} className={cx(t.featured ? BTN_PRIMARY : BTN_GHOST, 'mt-auto w-full py-3 text-sm')}>
                    Get started
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-8 text-center text-xs text-zinc-600">
              Balance is spent one minute per billed machine per minute. At zero, machines stop automatically —
              you can never overdraw. Up to {maxMachines} concurrent machines per account.
            </p>
          </div>
        </section>

        {/* ---- How it works ---- */}
        <section id="how" className="mx-auto max-w-6xl px-5 py-20 md:py-28">
          <SectionHead eyebrow="How it works" title="Running in about a minute" sub="" />
          <ol className="grid list-none gap-8 p-0 md:grid-cols-3">
            {[
              [<Rocket key="i" className="w-5 h-5 text-cyan-400" aria-hidden="true" />, 'Create an account', 'Pick a username and a password. No email, no verification, no KYC.'],
              [<Bitcoin key="i" className="w-5 h-5 text-amber-400" aria-hidden="true" />, 'Top up in Bitcoin', 'BTCPay generates an invoice; your balance credits the moment payment confirms.'],
              [<Monitor key="i" className="w-5 h-5 text-emerald-400" aria-hidden="true" />, 'Deploy your machine', 'Spawn an Ubuntu GPU session or a Windows/Linux VM and connect straight away.'],
            ].map(([ic, t, d], i) => (
              <li key={String(t)} className="relative">
                <div className="mb-4 flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5">{ic}</span>
                  <span className="font-mono text-xs text-zinc-600">STEP {i + 1}</span>
                </div>
                <h3 className="font-semibold text-zinc-100">{t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-zinc-500">{d}</p>
              </li>
            ))}
          </ol>

          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-zinc-500">
              Want the whole picture — what each machine type actually is, how billing works, how to connect?
            </p>
            <button type="button" onClick={onGuide} className={cx(BTN_GHOST, 'px-6 py-3 text-sm')}>
              <BookOpen className="w-4 h-4" aria-hidden="true" /> Read the full guide
            </button>
          </div>
        </section>

        {/* ---- FAQ ---- */}
        <section id="faq" className="border-t border-white/10 bg-white/[0.015]">
          <div className="mx-auto max-w-3xl px-5 py-20 md:py-28">
            <SectionHead eyebrow="FAQ" title="Questions people actually ask" sub="" />
            <div className="space-y-3">
              {[
                ['Is the first machine really free?', `Yes. Your first ${freeMachines} concurrent machine${freeMachines === 1 ? '' : 's'} ${freeMachines === 1 ? 'is' : 'are'} never billed. Only machines beyond that allowance draw down your balance.`],
                ['What happens when my balance runs out?', 'Billed machines are stopped automatically at zero. You are never charged more than you have topped up, and there is no card on file to overdraw.'],
                ['Do I need to install anything?', 'No. An Ubuntu GPU session runs entirely in the browser over noVNC. Windows and Linux VMs use your own RDP or SSH client.'],
                ['What data do you collect?', 'A username, a password hash, and your balance. There is no email field, so there is also no password recovery — store your password somewhere safe.'],
                ['How is payment handled?', 'Through a self-hosted BTCPay Server. You pay a Bitcoin invoice; a signed webhook credits your balance. No third-party payment processor sees you.'],
              ].map(([q, a]) => (
                <details key={q} className="surface group rounded-xl px-5 py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold text-zinc-100">
                    {q}
                    <ChevronRight className="w-4 h-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-90" aria-hidden="true" />
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-400">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ---- CTA ---- */}
        <section className="relative overflow-hidden border-t border-white/10">
          <div className="pointer-events-none absolute inset-0 bg-aurora" aria-hidden="true" />
          <div className="relative mx-auto max-w-3xl px-5 py-20 text-center md:py-28">
            <h2 className="text-h2 font-black">Your GPU is idle right now.</h2>
            <p className="mx-auto mt-4 max-w-xl text-zinc-400">
              Spin up an RTX 4080 SUPER in the time it takes to read this. First machine free — you can try it before
              you pay anything at all.
            </p>
            <button type="button" onClick={onLaunch} className={cx(BTN_PRIMARY, 'mx-auto mt-9 px-8 py-4 text-base')}>
              Launch the console <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-10 md:flex-row">
          <Logo />
          <p className="text-center text-xs text-zinc-600">
            ${price}/hr · Bitcoin via BTCPay · No KYC ·{' '}
            <a href="https://buymeacoffee.com/r26xrthzttg" target="_blank" rel="noopener noreferrer" className="text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">
              Support the build
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * Live capacity indicator — reflects /api/health, not a decorative fake. It
 * reports free VRAM on the session node rather than a node count, because a
 * node being up says nothing about whether a session can actually start on it.
 */
function StatusPill({ capacity }: { capacity: Capacity }) {
  const skin = {
    unknown: 'border-white/10 bg-white/5 text-zinc-500',
    ready: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
    busy: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
    offline: 'border-red-500/30 bg-red-500/10 text-red-300',
  }[capacity.state];
  const dot = {
    unknown: 'bg-zinc-500',
    ready: 'bg-emerald-400 animate-live',
    busy: 'bg-amber-400',
    offline: 'bg-red-400',
  }[capacity.state];

  return (
    // Polite, and keyed on a label that only changes when the *state* changes —
    // announcing a fresh megabyte count on every poll would be unusable.
    <span
      className={cx(
        'inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-full border px-3 py-1.5 text-[11px] uppercase tracking-[0.18em]',
        skin,
      )}
    >
      {capacity.state === 'unknown'
        ? <Activity className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        : <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', dot)} aria-hidden="true" />}
      {/* Only the state word is live: the figure moves on every poll and would
          otherwise be re-announced continuously. */}
      <span aria-live="polite">{capacity.status}</span>
      {capacity.figure && (
        <>
          <span aria-hidden="true" className="opacity-40">·</span>
          <span className="tracking-normal opacity-90">{capacity.figure}</span>
        </>
      )}
    </span>
  );
}

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="mb-12 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cyan-400">{eyebrow}</p>
      <h2 className="mt-3 text-h2 font-black">{title}</h2>
      {sub && <p className="mx-auto mt-4 max-w-xl leading-relaxed text-zinc-400">{sub}</p>}
    </div>
  );
}

function FeatureCard({
  icon, name, tag, desc, accent,
}: {
  icon: React.ReactNode; name: string; tag: string; desc: string; accent: keyof typeof ACCENTS;
}) {
  const a = ACCENTS[accent];
  return (
    <div className={cx('surface surface-hover rounded-2xl p-6', a.ring)}>
      <div className={cx('mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-white/10 bg-white/5', a.text)}>
        {icon}
      </div>
      <h3 className="font-semibold text-zinc-100">{name}</h3>
      <p className={cx('mt-0.5 text-[11px] font-medium uppercase tracking-wider', a.text)}>{tag}</p>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">{desc}</p>
    </div>
  );
}
