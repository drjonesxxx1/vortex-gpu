import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, AlertTriangle, CheckCircle2, Clock, Cpu, Database, FileText, Gauge,
  HardDrive, KeyRound, Monitor, Network, Play, RefreshCw, Server, ShieldAlert,
  Terminal, Thermometer, Users as UsersIcon, XCircle, Zap,
} from 'lucide-react';
import {
  Alert, BTN_BASE, BTN_GHOST, ConfirmDialog, INPUT_CLS, Spinner, StateBadge,
  cx, fmtBalance, readError,
} from './components/ui';
import './index.css';

/**
 * VortexGPU Admin — standalone hidden bundle.
 * Served ONLY at /admin?token=... (server 404s without the token).
 * Never linked from the public SPA.
 *
 * Every figure on this page comes from a real response field:
 *   GET /api/admin/state -> { nodes, jobs, vms, users, invoices, proxyPool }
 *   GET /api/health      -> session-node + VRAM headroom + spawn floor
 * Nothing here is derived from a hardcoded spec sheet. If the API does not
 * expose it, the panel says so rather than inventing it.
 */

/* ---------------------------------------------------------------- types --
   These mirror the server payloads exactly (verified against a live
   GET /api/admin/state). `adminToken` was deliberately removed from the
   state response — do not reintroduce it. */

type NodeStatus = 'online' | 'offline';

type GpuNode = {
  hostname: string;
  ip: string;
  gpuModel: string;
  driverVersion: string;
  memTotalMb: number;
  memUsedMb: number;
  gpuUtilPct: number;
  tempC: number;
  cpuUtilPct: number;
  ramTotalGb: number;
  ramUsedGb: number;
  uptimeSec: number;
  lastSeen: number;
  status: NodeStatus;
};

type JobStatus = 'pending' | 'running' | 'done' | 'failed';

type GpuJob = {
  id: string;
  hostname: string;
  /* Server's current union is shell | hashcat | comfyui | provision_ubuntu |
     destroy_ubuntu, but jobs.json is append-only and still holds older kinds
     (provision_comfyui, destroy_instance). Keep this a string so historical
     rows render instead of falling through a stale equality check. */
  kind: string;
  command: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  result: string;
  createdAt: number;
  completedAt: number | null;
};

type ApiVm = {
  id: string;
  user_id: string;
  vm_id: number;
  node_hostname: string;
  name: string;
  os: string;
  sku: string;
  state: string;
  ip: string | null;
  port: number | null;
  username: string | null;
  password: string | null;
  app: string | null;
  created_at: number;
};

type ApiUser = {
  id: string;
  username: string;
  balance_minutes: number;
  unlimited: number;
  created_at: number;
};

type ApiInvoice = {
  id: string;
  user_id: string;
  amount_usd: number;
  minutes: number;
  btcpay_invoice_id: string | null;
  checkout_link: string | null;
  status: string;
  created_at: number;
  settled_at: number | null;
};

type ProxyEntry = { ip: string; location: string; latencyMs: number };

type AdminState = {
  nodes: GpuNode[];
  jobs: GpuJob[];
  vms: ApiVm[];
  users: ApiUser[];
  invoices: ApiInvoice[];
  proxyPool: ProxyEntry[];
};

/** Subset of GET /api/health this panel reads. Public route, no bearer. */
type Health = {
  gpuNodesOnline: number;
  gpuNodesTotal: number;
  sessionNode: string;
  sessionNodeOnline: boolean;
  gpuVramFreeMb: number;
  gpuVramTotalMb: number;
  minFreeVramMb: number;
  windowsLabel: string;
  linuxLabel: string;
  gpuSku: string;
  priceUsdPerHour: number;
  freeMachines: number;
  maxVmsPerUser: number;
};

const EMPTY_STATE: AdminState = { nodes: [], jobs: [], vms: [], users: [], invoices: [], proxyPool: [] };

/* -------------------------------------------------------------- helpers */

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-ink-950';

/**
 * This project has no `@types/react` installed, so TypeScript does not model
 * JSX's special handling of `key` — it checks list-element attributes straight
 * against the component's prop type and rejects `key`. Declaring it explicitly
 * keeps `npx tsc --noEmit` clean without adding a dependency.
 */
type Keyed = { key?: string | number };

/** "12s ago" / "4m ago" / "3h ago" / "2d ago". Absolute time goes in title=. */
function ago(ts: number | null | undefined, now: number): string {
  if (!ts || !Number.isFinite(ts)) return '—';
  const d = Math.max(0, now - ts);
  if (d < 1_000) return 'just now';
  if (d < 60_000) return `${Math.floor(d / 1_000)}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function absTime(ts: number | null | undefined): string {
  if (!ts || !Number.isFinite(ts)) return 'unknown';
  return new Date(ts).toISOString();
}

/** Job wall-clock, only when the server actually recorded a completion. */
function durationMs(job: GpuJob): number | null {
  if (!job.completedAt || !job.createdAt) return null;
  return Math.max(0, job.completedAt - job.createdAt);
}

function fmtMs(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
}

function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

function readToken(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('token') || localStorage.getItem('vortex_admin_token') || '';
}

/* --------------------------------------------------------- small pieces */

function SectionCard({
  title, icon, count, children, actions,
}: {
  title: string;
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="surface rounded-2xl p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-zinc-200">
          {icon}
          {title}
          {count !== undefined && <span className="text-zinc-500">({count})</span>}
        </h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** One consistent "nothing here" line so a real empty set never reads as a bug. */
function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-zinc-500">{children}</p>;
}

function Meter({ pct, tone }: { pct: number; tone: string }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
      <div className={cx('h-full rounded-full', tone)} style={{ width: `${clamped}%` }} />
    </div>
  );
}

function KeyVal({ icon, label, value, tone = 'text-zinc-300' }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-zinc-500">{icon}{label}</span>
      <span className={cx('font-bold tabular-nums', tone)}>{value}</span>
    </div>
  );
}

/* ------------------------------------------------------- capacity banner */

/**
 * Real GPU headroom on the session node against the spawn floor the server
 * actually enforces (MIN_FREE_VRAM_MB). Every number here is a /api/health
 * field. When health has not loaded we say so instead of drawing zeroes.
 */
function CapacityPanel({ health, healthError }: { health: Health | null; healthError: string }) {
  if (healthError) {
    return (
      <SectionCard title="Session capacity" icon={<Gauge className="w-4 h-4 text-cyan-400" aria-hidden="true" />}>
        <Alert>{healthError}</Alert>
      </SectionCard>
    );
  }
  if (!health) {
    return (
      <SectionCard title="Session capacity" icon={<Gauge className="w-4 h-4 text-cyan-400" aria-hidden="true" />}>
        <p className="flex items-center gap-2 text-xs text-zinc-500"><Spinner /> Reading /api/health…</p>
      </SectionCard>
    );
  }

  const { gpuVramFreeMb: free, gpuVramTotalMb: total, minFreeVramMb: floor } = health;
  const freePct = total > 0 ? (free / total) * 100 : 0;
  const floorPct = total > 0 ? (floor / total) * 100 : 0;
  const belowFloor = floor > 0 && free < floor;
  const blocked = !health.sessionNodeOnline || belowFloor;

  return (
    <SectionCard
      title="Session capacity"
      icon={<Gauge className="w-4 h-4 text-cyan-400" aria-hidden="true" />}
      actions={
        <span
          className={cx(
            'rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider ring-1',
            blocked ? 'bg-red-500/15 text-red-300 ring-red-500/30' : 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30',
          )}
        >
          {blocked ? 'Spawns blocked' : 'Spawns eligible'}
        </span>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span className="text-zinc-500">Free VRAM on <span className="font-bold text-zinc-300">{health.sessionNode}</span></span>
            <span className="font-mono tabular-nums">
              <span className={cx('text-lg font-black', belowFloor ? 'text-red-300' : 'text-emerald-300')}>{free.toLocaleString()}</span>
              <span className="text-zinc-500"> / {total.toLocaleString()} MB</span>
            </span>
          </div>

          {/* Floor marker sits on the same track as the fill so the operator can
              see headroom vs. the refusal threshold at a glance. */}
          <div className="relative h-3 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className={cx('h-full rounded-full', belowFloor ? 'bg-red-500/70' : 'bg-emerald-400/80')}
              style={{ width: `${Math.max(0, Math.min(100, freePct))}%` }}
            />
            {total > 0 && floor > 0 && (
              <div
                className="absolute inset-y-0 w-0.5 bg-amber-300"
                style={{ left: `${Math.max(0, Math.min(100, floorPct))}%` }}
                aria-hidden="true"
              />
            )}
          </div>
          <p className="text-[11px] text-zinc-500">
            Amber marker = spawn floor <span className="font-mono text-amber-300">{floor.toLocaleString()} MB</span> (MIN_FREE_VRAM_MB).
            {' '}Below it <code className="text-zinc-400">/api/session/spawn</code> returns 503 and charges nothing — that is the guard working.
            {' '}The card is shared with other workloads on the box, so this figure moves on its own.
          </p>
          {belowFloor && (
            <Alert tone="warn">Free VRAM is under the spawn floor. New GPU sessions will be refused until it recovers.</Alert>
          )}
          {!health.sessionNodeOnline && (
            <Alert>Session node <span className="font-mono">{health.sessionNode}</span> is not reporting. No GPU session can start.</Alert>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 self-start text-xs">
          <dt className="text-zinc-500">Session node</dt>
          <dd className="text-right font-mono font-bold text-zinc-200">{health.sessionNode}</dd>
          <dt className="text-zinc-500">Reporting</dt>
          <dd className={cx('text-right font-bold', health.sessionNodeOnline ? 'text-emerald-300' : 'text-red-300')}>
            {health.sessionNodeOnline ? 'online' : 'offline'}
          </dd>
          <dt className="text-zinc-500">Nodes online</dt>
          <dd className="text-right font-mono text-zinc-200">{health.gpuNodesOnline}/{health.gpuNodesTotal}</dd>
          <dt className="text-zinc-500">Advertised SKU</dt>
          <dd className="text-right text-zinc-300">{health.gpuSku}</dd>
          <dt className="text-zinc-500">Guest images</dt>
          <dd className="text-right text-zinc-300">{health.windowsLabel} · {health.linuxLabel}</dd>
          <dt className="text-zinc-500">Price / free / cap</dt>
          <dd className="text-right font-mono text-zinc-300">
            ${health.priceUsdPerHour}/hr · {health.freeMachines} free · max {health.maxVmsPerUser}
          </dd>
        </dl>
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------ node cards */

function NodeCard({ node, sessionNode, now }: Keyed & { node: GpuNode; sessionNode: string | null; now: number }) {
  const offline = node.status !== 'online';
  const vramFree = Math.max(0, (node.memTotalMb || 0) - (node.memUsedMb || 0));
  const vramPct = node.memTotalMb > 0 ? (node.memUsedMb / node.memTotalMb) * 100 : 0;
  const isSession = !!sessionNode && node.hostname === sessionNode;

  return (
    <div className={cx('surface rounded-2xl p-4', offline && 'opacity-70 border-red-500/25')}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-bold text-cyan-300">{node.hostname}</span>
            {isSession && (
              <span className="shrink-0 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-400/30">
                session node
              </span>
            )}
          </div>
          <div className="truncate font-mono text-[10px] text-zinc-600">{node.ip}</div>
        </div>
        <span
          className={cx(
            'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1',
            offline ? 'bg-red-500/15 text-red-300 ring-red-500/30' : 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30',
          )}
        >
          {node.status}
        </span>
      </div>

      <div className="text-xs font-bold text-amber-300">{node.gpuModel}</div>
      <div className="text-[11px] text-zinc-500">Driver {node.driverVersion || '—'}</div>

      <div className="mt-3 space-y-2 text-[11px]">
        <KeyVal icon={<Activity className="w-3 h-3" aria-hidden="true" />} label="GPU util" value={`${node.gpuUtilPct}%`} tone="text-emerald-300" />
        <Meter pct={node.gpuUtilPct} tone="bg-emerald-400/80" />
        <KeyVal
          icon={<HardDrive className="w-3 h-3" aria-hidden="true" />}
          label="VRAM used"
          value={`${node.memUsedMb.toLocaleString()} / ${node.memTotalMb.toLocaleString()} MB`}
          tone="text-amber-300"
        />
        <Meter pct={vramPct} tone={vramPct > 85 ? 'bg-red-500/80' : 'bg-amber-400/80'} />
        <KeyVal icon={<HardDrive className="w-3 h-3" aria-hidden="true" />} label="VRAM free" value={`${vramFree.toLocaleString()} MB`} tone="text-cyan-300" />
        <KeyVal icon={<Cpu className="w-3 h-3" aria-hidden="true" />} label="CPU" value={`${node.cpuUtilPct}%`} />
        <KeyVal icon={<Thermometer className="w-3 h-3" aria-hidden="true" />} label="Temp" value={`${node.tempC}°C`} />
        <KeyVal icon={<Database className="w-3 h-3" aria-hidden="true" />} label="RAM" value={`${node.ramUsedGb} / ${node.ramTotalGb} GB`} />
        <KeyVal icon={<Clock className="w-3 h-3" aria-hidden="true" />} label="Uptime" value={fmtUptime(node.uptimeSec)} />
        <KeyVal
          icon={<RefreshCw className="w-3 h-3" aria-hidden="true" />}
          label="Heartbeat"
          value={<span title={absTime(node.lastSeen)}>{ago(node.lastSeen, now)}</span>}
          tone={offline ? 'text-red-300' : 'text-zinc-300'}
        />
      </div>

      {offline && (
        <p className="mt-3 rounded-lg border border-red-500/25 bg-red-950/30 px-2.5 py-1.5 text-[10px] text-red-200">
          No heartbeat for {ago(node.lastSeen, now).replace(' ago', '')}. The agent is down, or the box is. Jobs queued here will sit pending.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- job rows */

function JobRow({ job, now }: Keyed & { job: GpuJob; now: number }) {
  const failed = job.status === 'failed';
  const inflight = job.status === 'running' || job.status === 'pending';
  const dur = durationMs(job);
  const payloadKeys = Object.keys(job.payload || {});
  const hasPayload = payloadKeys.length > 0;

  return (
    <li
      className={cx(
        'rounded-xl border p-3',
        failed ? 'border-red-500/40 bg-red-950/25' : 'border-white/10 bg-black/30',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-2">
          <span className="font-bold text-cyan-300">{job.hostname}</span>
          <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">{job.kind}</span>
        </span>
        <span
          className={cx(
            'flex items-center gap-1.5 font-bold uppercase tracking-wider',
            failed ? 'text-red-300' : job.status === 'done' ? 'text-emerald-300' : 'text-amber-300',
          )}
        >
          {failed ? <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
            : job.status === 'done' ? <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
              : <Spinner className="w-3.5 h-3.5" />}
          {job.status}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
        <span className="font-mono">{job.id}</span>
        <span title={absTime(job.createdAt)}>queued {ago(job.createdAt, now)}</span>
        {dur !== null ? <span>took {fmtMs(dur)}</span> : inflight ? <span className="text-amber-300">still open</span> : null}
      </div>

      {job.command && (
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/60 p-2 font-mono text-[11px] text-zinc-300">
          {job.command}
        </pre>
      )}
      {!job.command && hasPayload && (
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/60 p-2 font-mono text-[11px] text-zinc-400">
          {JSON.stringify(job.payload, null, 2)}
        </pre>
      )}

      {job.result ? (
        <>
          <div className={cx('mt-2 text-[10px] font-bold uppercase tracking-wider', failed ? 'text-red-300' : 'text-zinc-500')}>
            {failed ? 'Failure output' : 'Result'}
          </div>
          <pre
            className={cx(
              'mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg p-2 font-mono text-[11px]',
              failed ? 'bg-red-950/40 text-red-200' : 'bg-black/60 text-emerald-300',
            )}
          >
            {job.result}
          </pre>
        </>
      ) : (
        <p className="mt-2 text-[10px] text-zinc-600">
          {inflight ? 'No output yet — the agent has not reported back.' : 'Completed with no output.'}
        </p>
      )}
    </li>
  );
}

/* --------------------------------------------------------------- tables */

function ScrollTable({ head, children }: { head: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="max-h-96 overflow-auto rounded-xl border border-white/10">
      <table className="w-full min-w-[36rem] text-left text-xs">
        <thead className="sticky top-0 z-10 bg-ink-900/95 backdrop-blur">
          <tr className="border-b border-white/10 text-[10px] uppercase tracking-wider text-zinc-500">{head}</tr>
        </thead>
        <tbody className="divide-y divide-white/5">{children}</tbody>
      </table>
    </div>
  );
}

const TH = 'px-3 py-2 font-bold whitespace-nowrap';
const TD = 'px-3 py-2 whitespace-nowrap';

/* ============================================================== the app */

type Pending =
  | { kind: 'run'; hostname: string; command: string }
  | { kind: 'credit'; user: ApiUser; minutes: number }
  | { kind: 'password'; user: ApiUser; newPassword: string };

function AdminApp() {
  const [token, setToken] = useState(readToken);
  const [tokenDraft, setTokenDraft] = useState('');
  const [authed, setAuthed] = useState<boolean | null>(null); // null = not yet known
  const [state, setState] = useState<AdminState>(EMPTY_STATE);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState('');
  const [stateError, setStateError] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Action form state
  const [dispatchHost, setDispatchHost] = useState('');
  const [dispatchCmd, setDispatchCmd] = useState('');
  const [creditUserId, setCreditUserId] = useState('');
  const [creditMinutes, setCreditMinutes] = useState(60);
  const [pwUserId, setPwUserId] = useState('');
  const [pwValue, setPwValue] = useState('');
  const [jobFilter, setJobFilter] = useState<'all' | 'failed' | 'open'>('all');

  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /* Relative timestamps must keep ticking even when polling is failing. */
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  const fetchState = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/state', { headers: { Authorization: `Bearer ${token}` } });
      if (!alive.current) return;
      if (res.status === 404) {
        // Admin routes 404 rather than 403 — an undiscoverable surface. For the
        // holder of a *wrong* token that is indistinguishable from "no such
        // route", so it is the one status we treat as auth failure.
        setAuthed(false);
        setStateError('');
        return;
      }
      if (!res.ok) {
        setStateError(await readError(res, 'Could not load admin state'));
        return;
      }
      const data = (await res.json()) as Partial<AdminState>;
      setState({
        nodes: data.nodes ?? [],
        jobs: data.jobs ?? [],
        vms: data.vms ?? [],
        users: data.users ?? [],
        invoices: data.invoices ?? [],
        proxyPool: data.proxyPool ?? [],
      });
      setAuthed(true);
      setStateError('');
      setLastOk(Date.now());
    } catch (e) {
      if (!alive.current) return;
      setStateError(`Network error reaching /api/admin/state: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [token]);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      if (!alive.current) return;
      if (!res.ok) { setHealthError(await readError(res, 'Could not load /api/health')); return; }
      setHealth((await res.json()) as Health);
      setHealthError('');
    } catch (e) {
      if (alive.current) setHealthError(`Network error reaching /api/health: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const refresh = useCallback(() => { setNow(Date.now()); fetchState(); fetchHealth(); }, [fetchState, fetchHealth]);

  useEffect(() => {
    if (token) localStorage.setItem('vortex_admin_token', token);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    refresh();
    const t = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(t);
  }, [token, refresh]);

  const users = state.users;
  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const onlineNodes = useMemo(() => state.nodes.filter((n) => n.status === 'online'), [state.nodes]);
  const failedJobs = useMemo(() => state.jobs.filter((j) => j.status === 'failed'), [state.jobs]);
  const openJobs = useMemo(() => state.jobs.filter((j) => j.status === 'running' || j.status === 'pending'), [state.jobs]);
  const shownJobs = jobFilter === 'failed' ? failedJobs : jobFilter === 'open' ? openJobs : state.jobs;

  /* ------------------------------------------------------ confirm + send */

  const closeDialog = () => { setPending(null); setConfirmText(''); setDialogError(''); setBusy(false); };

  /** `error` is the server's own `{error:"..."}` string when it sent one. */
  const post = async (path: string, body: unknown): Promise<{ error: string; data: any }> => {
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) return { error: await readError(res, `${path} failed`), data: null };
      return { error: '', data: await res.json().catch(() => ({})) };
    } catch (e) {
      return { error: `Network error: ${e instanceof Error ? e.message : String(e)}`, data: null };
    }
  };

  const confirmPending = async () => {
    if (!pending) return;
    setDialogError('');

    if (pending.kind === 'run') {
      setBusy(true);
      const r = await post('/api/admin/gpu/run', { hostname: pending.hostname, command: pending.command });
      setBusy(false);
      if (r.error) { setDialogError(r.error); return; }
      setNotice({ tone: 'ok', text: `Job ${r.data?.jobId ?? ''} dispatched to ${pending.hostname}.` });
      setDispatchCmd('');
      closeDialog();
      refresh();
      return;
    }

    if (pending.kind === 'credit') {
      setBusy(true);
      // The server takes userId only — it does not accept a username here.
      const r = await post('/api/admin/credit', { userId: pending.user.id, minutes: pending.minutes });
      setBusy(false);
      if (r.error) { setDialogError(r.error); return; }
      setNotice({
        tone: 'ok',
        text: `${pending.minutes >= 0 ? 'Credited' : 'Debited'} ${Math.abs(pending.minutes)} min ${pending.minutes >= 0 ? 'to' : 'from'} ${pending.user.username}.`,
      });
      closeDialog();
      refresh();
      return;
    }

    // password — require the operator to retype the exact username.
    if (confirmText !== pending.user.username) {
      setDialogError(`Type the username "${pending.user.username}" exactly to confirm.`);
      return;
    }
    setBusy(true);
    const r = await post('/api/admin/set-password', { userId: pending.user.id, newPassword: pending.newPassword });
    setBusy(false);
    if (r.error) { setDialogError(r.error); return; }
    setNotice({ tone: 'ok', text: `Password set for ${pending.user.username}. Their existing sessions were revoked — hand them the new password over a trusted channel.` });
    setPwValue('');
    closeDialog();
    refresh();
  };

  /* ------------------------------------------------------------- gating */

  if (!token) {
    return (
      <div className="min-h-screen bg-ink-950 bg-aurora flex items-center justify-center p-6 text-zinc-100">
        <form
          onSubmit={(e) => { e.preventDefault(); if (tokenDraft.trim()) setToken(tokenDraft.trim()); }}
          className="surface w-full max-w-md space-y-4 rounded-2xl border-red-500/30 p-6"
        >
          <div className="flex items-center gap-3 text-red-300">
            <ShieldAlert className="w-8 h-8" aria-hidden="true" />
            <h1 className="text-lg font-black uppercase tracking-wider">Admin token required</h1>
          </div>
          <label htmlFor="admin-token" className="block text-xs text-zinc-400">Admin token</label>
          <input
            id="admin-token"
            type="password"
            autoComplete="off"
            autoFocus
            value={tokenDraft}
            placeholder="Paste admin token"
            onChange={(e) => setTokenDraft(e.target.value)}
            className={cx(INPUT_CLS, 'font-mono')}
          />
          <button type="submit" disabled={!tokenDraft.trim()} className={cx(BTN_BASE, FOCUS, 'w-full bg-cyan-400 py-2.5 text-sm text-ink-950 hover:bg-cyan-300')}>
            Unlock
          </button>
          <p className="text-xs text-zinc-500">
            This panel is not linked anywhere in the public app, and every admin route answers 404 without this token.
          </p>
        </form>
      </div>
    );
  }

  if (authed === false) {
    return (
      <div className="min-h-screen bg-ink-950 bg-aurora flex items-center justify-center p-6 text-zinc-100">
        <div className="surface max-w-md space-y-4 rounded-2xl border-red-500/30 p-8 text-center">
          <ShieldAlert className="mx-auto w-12 h-12 text-red-400" aria-hidden="true" />
          <h1 className="text-xl font-black text-red-300">Unauthorized</h1>
          <p className="text-sm text-zinc-400">
            The admin API answered 404. That is what it returns for an invalid token — the surface is deliberately undiscoverable.
          </p>
          <button
            onClick={() => { localStorage.removeItem('vortex_admin_token'); setTokenDraft(''); setAuthed(null); setToken(''); }}
            className={cx(BTN_BASE, FOCUS, 'w-full bg-red-500 py-2.5 text-sm text-white hover:bg-red-400')}
          >
            Use a different token
          </button>
        </div>
      </div>
    );
  }

  if (authed === null) {
    return (
      <div className="min-h-screen bg-ink-950 bg-aurora flex items-center justify-center p-6 text-zinc-100">
        <div aria-live="polite" className="flex items-center gap-3 text-sm text-zinc-400">
          {stateError ? <Alert>{stateError}</Alert> : <><Spinner className="w-5 h-5" /> Loading admin state…</>}
        </div>
      </div>
    );
  }

  const creditTarget = usersById.get(creditUserId) ?? null;
  const pwTarget = usersById.get(pwUserId) ?? null;
  const projected = creditTarget ? Math.max(0, creditTarget.balance_minutes + creditMinutes) : 0;

  /* --------------------------------------------------------------- view */

  return (
    <div className="min-h-screen bg-ink-950 bg-grid text-zinc-100">
      <div className="mx-auto max-w-7xl space-y-6 p-6">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-red-600 to-rose-800">
              <Server className="w-5 h-5 text-white" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-lg font-black tracking-wider">VORTEX<span className="text-red-400">_GPU</span> ADMIN</h1>
              <p className="text-xs text-zinc-500">Operator console — hidden surface, never linked from the public app</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="rounded-full bg-white/5 px-3 py-1 text-zinc-300 ring-1 ring-white/10">
              {onlineNodes.length}/{state.nodes.length} nodes online
            </span>
            {failedJobs.length > 0 && (
              <button
                type="button"
                onClick={() => { setJobFilter('failed'); document.getElementById('jobs')?.scrollIntoView({ behavior: 'smooth' }); }}
                className={cx(FOCUS, 'rounded-full bg-red-500/15 px-3 py-1 font-bold text-red-300 ring-1 ring-red-500/30 hover:bg-red-500/25')}
              >
                {failedJobs.length} failed job{failedJobs.length === 1 ? '' : 's'}
              </button>
            )}
            <span className="text-zinc-600" title={lastOk ? absTime(lastOk) : 'never'}>
              synced {ago(lastOk, now)}
            </span>
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh admin state"
              className={cx(BTN_GHOST, FOCUS, 'p-2')}
            >
              <RefreshCw className={cx('w-4 h-4', loading && 'animate-spin')} aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => { localStorage.removeItem('vortex_admin_token'); setTokenDraft(''); setAuthed(null); setToken(''); }}
              className={cx(BTN_GHOST, FOCUS, 'px-3 py-2')}
            >
              Lock
            </button>
          </div>
        </header>

        {/* Async status for the whole page. */}
        <div aria-live="polite" className="space-y-3 empty:hidden">
          {stateError && (
            <Alert onDismiss={() => setStateError('')} action={<button type="button" onClick={refresh} className={cx(BTN_GHOST, FOCUS, 'px-3 py-1.5 text-xs')}>Retry</button>}>
              {stateError}{lastOk ? ` — showing data from ${ago(lastOk, now)}.` : ''}
            </Alert>
          )}
          {notice && (
            <Alert tone={notice.tone === 'ok' ? 'info' : 'error'} onDismiss={() => setNotice(null)}>{notice.text}</Alert>
          )}
        </div>

        <CapacityPanel health={health} healthError={healthError} />

        {/* ---- NODES ---- */}
        <SectionCard title="GPU nodes" icon={<Cpu className="w-4 h-4 text-cyan-400" aria-hidden="true" />} count={state.nodes.length}>
          {state.nodes.length === 0 ? (
            <EmptyRow>No nodes registered. Agents phone home to /api/gpu/register; nothing has reported in.</EmptyRow>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {state.nodes.map((n) => (
                <NodeCard key={n.hostname} node={n} sessionNode={health?.sessionNode ?? null} now={now} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* ---- DANGER ZONE ---- */}
        <section className="rounded-2xl border border-red-500/40 bg-red-950/15 p-5">
          <div className="mb-4 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-400" aria-hidden="true" />
            <h2 className="text-sm font-bold uppercase tracking-wider text-red-300">Danger zone</h2>
            <span className="text-[11px] text-red-200/70">These three controls execute code on a host, move balance, and change a customer credential. Each asks first.</span>
          </div>

          <div className="grid gap-5 lg:grid-cols-3">
            {/* --- gpu/run: remote code execution --- */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const host = dispatchHost.trim();
                const cmd = dispatchCmd.trim();
                if (!host || !cmd) { setNotice({ tone: 'err', text: 'Target node and command are both required.' }); return; }
                setPending({ kind: 'run', hostname: host, command: cmd });
              }}
              className="space-y-3 rounded-xl border border-red-500/30 bg-black/40 p-4"
            >
              <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-red-300">
                <Terminal className="w-4 h-4" aria-hidden="true" /> Run shell command
              </h3>
              <p className="text-[11px] leading-relaxed text-red-200/70">
                Remote code execution on the selected GPU host, as whatever user the agent runs as. There is no sandbox and no undo.
              </p>
              <div>
                <label htmlFor="run-host" className="mb-1 block text-[11px] text-zinc-400">Target node</label>
                <select
                  id="run-host"
                  value={dispatchHost}
                  onChange={(e) => setDispatchHost(e.target.value)}
                  className={cx(INPUT_CLS, FOCUS, 'py-2 text-sm')}
                >
                  <option value="">Select node…</option>
                  {state.nodes.map((n) => (
                    <option key={n.hostname} value={n.hostname} disabled={n.status !== 'online'}>
                      {n.hostname}{n.status !== 'online' ? ' (offline)' : ''}
                    </option>
                  ))}
                </select>
                {state.nodes.length === 0 && <p className="mt-1 text-[11px] text-zinc-500">No nodes registered.</p>}
              </div>
              <div>
                <label htmlFor="run-cmd" className="mb-1 block text-[11px] text-zinc-400">
                  Command <span className="text-zinc-600">(the agent's own shell — Windows or Linux depending on the node)</span>
                </label>
                <textarea
                  id="run-cmd"
                  rows={3}
                  value={dispatchCmd}
                  onChange={(e) => setDispatchCmd(e.target.value)}
                  maxLength={4096}
                  placeholder="nvidia-smi --query-gpu=name,memory.free --format=csv"
                  className={cx(INPUT_CLS, FOCUS, 'resize-y py-2 font-mono text-xs')}
                />
                <p className="mt-1 text-[10px] text-zinc-600">{dispatchCmd.length}/4096 — the server rejects anything longer.</p>
              </div>
              <button type="submit" className={cx(BTN_BASE, FOCUS, 'w-full bg-red-500 py-2.5 text-xs uppercase tracking-wider text-white hover:bg-red-400')}>
                <Play className="w-4 h-4" aria-hidden="true" /> Review &amp; dispatch
              </button>
            </form>

            {/* --- credit --- */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!creditTarget) { setNotice({ tone: 'err', text: 'Pick a user to credit.' }); return; }
                if (!Number.isInteger(creditMinutes) || creditMinutes === 0) { setNotice({ tone: 'err', text: 'Minutes must be a non-zero whole number.' }); return; }
                setPending({ kind: 'credit', user: creditTarget, minutes: creditMinutes });
              }}
              className="space-y-3 rounded-xl border border-amber-500/30 bg-black/40 p-4"
            >
              <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-300">
                <Database className="w-4 h-4" aria-hidden="true" /> Adjust balance
              </h3>
              <p className="text-[11px] leading-relaxed text-amber-200/70">
                Moves real money-equivalent GPU time. Negative values debit. The server clamps the result at zero.
              </p>
              <div>
                <label htmlFor="credit-user" className="mb-1 block text-[11px] text-zinc-400">User</label>
                <select id="credit-user" value={creditUserId} onChange={(e) => setCreditUserId(e.target.value)} className={cx(INPUT_CLS, FOCUS, 'py-2 text-sm')}>
                  <option value="">Select user…</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.username} — {fmtBalance(u.balance_minutes)}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="credit-min" className="mb-1 block text-[11px] text-zinc-400">Minutes (negative to debit)</label>
                <input
                  id="credit-min"
                  type="number"
                  step={1}
                  value={creditMinutes}
                  onChange={(e) => setCreditMinutes(Math.trunc(Number(e.target.value) || 0))}
                  className={cx(INPUT_CLS, FOCUS, 'py-2 font-mono text-sm')}
                />
              </div>
              <p className="min-h-[1.25rem] text-[11px] text-zinc-500">
                {creditTarget
                  ? <>Now {fmtBalance(creditTarget.balance_minutes)} → <span className="font-bold text-amber-300">{fmtBalance(projected)}</span></>
                  : 'Select a user to see the resulting balance.'}
              </p>
              <button type="submit" className={cx(BTN_BASE, FOCUS, 'w-full bg-amber-400 py-2.5 text-xs uppercase tracking-wider text-ink-950 hover:bg-amber-300')}>
                Review &amp; apply
              </button>
            </form>

            {/* --- set-password --- */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!pwTarget) { setNotice({ tone: 'err', text: 'Pick the account to recover.' }); return; }
                if (pwValue.length < 6) { setNotice({ tone: 'err', text: 'Password must be at least 6 characters — the server enforces the same rule as registration.' }); return; }
                setPending({ kind: 'password', user: pwTarget, newPassword: pwValue });
              }}
              className="space-y-3 rounded-xl border border-red-500/30 bg-black/40 p-4"
            >
              <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-red-300">
                <KeyRound className="w-4 h-4" aria-hidden="true" /> Set account password
              </h3>
              <p className="text-[11px] leading-relaxed text-red-200/70">
                Overwrites a real customer credential and revokes their live tokens. This is the only recovery path for a legacy
                account with no password set — those accounts hard-403 on login and cannot self-serve.
              </p>
              <div>
                <label htmlFor="pw-user" className="mb-1 block text-[11px] text-zinc-400">Account</label>
                <select id="pw-user" value={pwUserId} onChange={(e) => setPwUserId(e.target.value)} className={cx(INPUT_CLS, FOCUS, 'py-2 text-sm')}>
                  <option value="">Select account…</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="pw-value" className="mb-1 block text-[11px] text-zinc-400">New password (min 6 chars)</label>
                <input
                  id="pw-value"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={pwValue}
                  onChange={(e) => setPwValue(e.target.value)}
                  className={cx(INPUT_CLS, FOCUS, 'py-2 font-mono text-sm')}
                />
              </div>
              <button type="submit" className={cx(BTN_BASE, FOCUS, 'w-full bg-red-500 py-2.5 text-xs uppercase tracking-wider text-white hover:bg-red-400')}>
                Review &amp; reset
              </button>
            </form>
          </div>
        </section>

        {/* ---- JOBS ---- */}
        <div id="jobs">
          <SectionCard
            title="Job log"
            icon={<Zap className="w-4 h-4 text-cyan-400" aria-hidden="true" />}
            count={state.jobs.length}
            actions={
              <div role="group" aria-label="Filter jobs" className="flex gap-1 rounded-lg border border-white/10 p-0.5 text-[11px]">
                {([['all', `All ${state.jobs.length}`], ['open', `Open ${openJobs.length}`], ['failed', `Failed ${failedJobs.length}`]] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={jobFilter === k}
                    onClick={() => setJobFilter(k)}
                    className={cx(
                      FOCUS, 'rounded px-2.5 py-1 font-bold',
                      jobFilter === k ? 'bg-cyan-400 text-ink-950' : 'text-zinc-400 hover:text-white',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            <p className="mb-3 text-[11px] text-zinc-500">
              The server returns the last 50 jobs, newest first. Failures are highlighted and their output is shown in full.
            </p>
            {shownJobs.length === 0 ? (
              <EmptyRow>
                {state.jobs.length === 0 ? 'No jobs have ever been dispatched.' : `No ${jobFilter} jobs in the last ${state.jobs.length}.`}
              </EmptyRow>
            ) : (
              <ul className="max-h-[32rem] space-y-2 overflow-y-auto pr-1">
                {shownJobs.map((j) => <JobRow key={j.id} job={j} now={now} />)}
              </ul>
            )}
          </SectionCard>
        </div>

        {/* ---- USERS ---- */}
        <SectionCard title="Users" icon={<UsersIcon className="w-4 h-4 text-cyan-400" aria-hidden="true" />} count={users.length}>
          {users.length === 0 ? <EmptyRow>No users registered.</EmptyRow> : (
            <ScrollTable
              head={<>
                <th scope="col" className={TH}>User</th>
                <th scope="col" className={TH}>Balance</th>
                <th scope="col" className={TH}>Plan</th>
                <th scope="col" className={TH}>Registered</th>
                <th scope="col" className={TH}>ID</th>
                <th scope="col" className={TH}>Actions</th>
              </>}
            >
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-white/5">
                  <td className={cx(TD, 'font-bold text-cyan-300')}>{u.username}</td>
                  <td className={cx(TD, 'font-mono tabular-nums text-amber-300')}>{fmtBalance(u.balance_minutes)}</td>
                  <td className={TD}>
                    {u.unlimited
                      ? <span className="rounded-full bg-violet-400/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-violet-300 ring-1 ring-violet-400/30">unlimited</span>
                      : <span className="text-zinc-500">metered</span>}
                  </td>
                  <td className={cx(TD, 'text-zinc-400')} title={absTime(u.created_at)}>{ago(u.created_at, now)}</td>
                  <td className={cx(TD, 'font-mono text-zinc-600')}>{u.id}</td>
                  <td className={TD}>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => { setCreditUserId(u.id); document.getElementById('credit-min')?.focus(); }}
                        className={cx(BTN_GHOST, FOCUS, 'px-2 py-1 text-[11px]')}
                      >
                        Credit
                      </button>
                      <button
                        type="button"
                        onClick={() => { setPwUserId(u.id); document.getElementById('pw-value')?.focus(); }}
                        className={cx(BTN_GHOST, FOCUS, 'px-2 py-1 text-[11px]')}
                      >
                        Set password
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </ScrollTable>
          )}
          <p className="mt-2 text-[11px] text-zinc-600">
            /api/admin/state does not expose <code>password_hash</code>, so this panel cannot flag which accounts are locked out
            (NULL hash). Identify them from the login failure the customer reports, then reset here.
          </p>
        </SectionCard>

        {/* ---- MACHINES ---- */}
        <SectionCard title="Rented machines" icon={<Monitor className="w-4 h-4 text-cyan-400" aria-hidden="true" />} count={state.vms.length}>
          {state.vms.length === 0 ? <EmptyRow>No Proxmox guests are provisioned.</EmptyRow> : (
            <ScrollTable
              head={<>
                <th scope="col" className={TH}>Name</th>
                <th scope="col" className={TH}>Owner</th>
                <th scope="col" className={TH}>OS</th>
                <th scope="col" className={TH}>SKU (label)</th>
                <th scope="col" className={TH}>VMID</th>
                <th scope="col" className={TH}>Address</th>
                <th scope="col" className={TH}>State</th>
                <th scope="col" className={TH}>Created</th>
              </>}
            >
              {state.vms.map((v) => (
                <tr key={v.id} className="hover:bg-white/5">
                  <td className={cx(TD, 'font-bold text-cyan-300')}>{v.name}</td>
                  <td className={cx(TD, 'text-zinc-400')}>{usersById.get(v.user_id)?.username ?? <span className="font-mono text-zinc-600">{v.user_id}</span>}</td>
                  <td className={cx(TD, 'text-zinc-400')}>{v.os}</td>
                  <td className={cx(TD, 'text-amber-300')}>{v.sku}</td>
                  <td className={cx(TD, 'font-mono text-zinc-400')}>{v.vm_id}</td>
                  <td className={cx(TD, 'font-mono text-emerald-300')}>
                    {v.ip ? `${v.ip}${v.port ? `:${v.port}` : ''}` : <span className="text-amber-300">waiting for clone…</span>}
                  </td>
                  <td className={TD}><StateBadge state={v.state} /></td>
                  <td className={cx(TD, 'text-zinc-400')} title={absTime(v.created_at)}>{ago(v.created_at, now)}</td>
                </tr>
              ))}
            </ScrollTable>
          )}
          <p className="mt-2 text-[11px] text-zinc-600">
            Proxmox guests only. GPU sessions live in the <code>sessions</code> table, which /api/admin/state does not return —
            they surface here indirectly, as provision_ubuntu / destroy_ubuntu rows in the job log.
          </p>
        </SectionCard>

        {/* ---- INVOICES ---- */}
        <SectionCard title="Invoices" icon={<FileText className="w-4 h-4 text-cyan-400" aria-hidden="true" />} count={state.invoices.length}>
          {state.invoices.length === 0 ? <EmptyRow>No invoices yet.</EmptyRow> : (
            <ScrollTable
              head={<>
                <th scope="col" className={TH}>User</th>
                <th scope="col" className={TH}>Amount</th>
                <th scope="col" className={TH}>Minutes</th>
                <th scope="col" className={TH}>Status</th>
                <th scope="col" className={TH}>Created</th>
                <th scope="col" className={TH}>Settled</th>
                <th scope="col" className={TH}>BTCPay</th>
              </>}
            >
              {state.invoices.map((inv) => (
                <tr key={inv.id} className="hover:bg-white/5">
                  <td className={cx(TD, 'text-zinc-300')}>{usersById.get(inv.user_id)?.username ?? <span className="font-mono text-zinc-600">{inv.user_id}</span>}</td>
                  <td className={cx(TD, 'font-mono tabular-nums text-emerald-300')}>${inv.amount_usd}</td>
                  <td className={cx(TD, 'font-mono tabular-nums text-amber-300')}>{inv.minutes}</td>
                  <td className={TD}>
                    <span className={cx(
                      'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1',
                      inv.status === 'settled' ? 'bg-emerald-400/15 text-emerald-300 ring-emerald-400/30'
                        : inv.status === 'pending' ? 'bg-amber-400/15 text-amber-300 ring-amber-400/30'
                          : 'bg-white/5 text-zinc-400 ring-white/10',
                    )}>{inv.status}</span>
                  </td>
                  <td className={cx(TD, 'text-zinc-400')} title={absTime(inv.created_at)}>{ago(inv.created_at, now)}</td>
                  <td className={cx(TD, 'text-zinc-400')} title={absTime(inv.settled_at)}>{inv.settled_at ? ago(inv.settled_at, now) : '—'}</td>
                  <td className={cx(TD, 'font-mono text-zinc-600')}>{inv.btcpay_invoice_id ?? '—'}</td>
                </tr>
              ))}
            </ScrollTable>
          )}
        </SectionCard>

        {/* ---- PROXY POOL ---- */}
        <SectionCard title="Proxy pool" icon={<Network className="w-4 h-4 text-cyan-400" aria-hidden="true" />} count={state.proxyPool.length}>
          {state.proxyPool.length === 0 ? <EmptyRow>Proxy pool is empty.</EmptyRow> : (
            <>
              <ScrollTable
                head={<>
                  <th scope="col" className={TH}>IP</th>
                  <th scope="col" className={TH}>Location</th>
                  <th scope="col" className={TH}>Latency</th>
                </>}
              >
                {state.proxyPool.map((p) => (
                  <tr key={p.ip} className="hover:bg-white/5">
                    <td className={cx(TD, 'font-mono text-cyan-300')}>{p.ip}</td>
                    <td className={cx(TD, 'text-zinc-400')}>{p.location}</td>
                    <td className={cx(TD, 'font-mono tabular-nums text-zinc-300')}>{p.latencyMs} ms</td>
                  </tr>
                ))}
              </ScrollTable>
              <p className="mt-2 text-[11px] text-zinc-600">The state endpoint returns at most 20 entries; this is not the full pool size.</p>
            </>
          )}
        </SectionCard>
      </div>

      {/* ------------------------------------------------------- dialogs */}

      {pending?.kind === 'run' && (
        <ConfirmDialog
          title="Execute on a GPU host?"
          confirmLabel="Dispatch command"
          busyLabel="Dispatching…"
          busy={busy}
          error={dialogError}
          onConfirm={confirmPending}
          onClose={closeDialog}
        >
          <p>This runs a shell command on a production GPU box. It is remote code execution by design — there is no sandbox, no dry run and no undo.</p>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Target host</div>
            <div className="font-mono text-base font-bold text-red-300">{pending.hostname}</div>
            {state.nodes.find((n) => n.hostname === pending.hostname)?.status !== 'online' && (
              <p className="mt-1 text-xs text-amber-300">That node is not reporting. The job will queue as pending until its agent returns.</p>
            )}
          </div>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Exact command</div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-red-500/30 bg-black/60 p-3 font-mono text-xs text-red-200">
              {pending.command}
            </pre>
          </div>
        </ConfirmDialog>
      )}

      {pending?.kind === 'credit' && (
        <ConfirmDialog
          title={pending.minutes >= 0 ? 'Credit this balance?' : 'Debit this balance?'}
          confirmLabel={pending.minutes >= 0 ? `Credit ${pending.minutes} min` : `Debit ${Math.abs(pending.minutes)} min`}
          busyLabel="Applying…"
          busy={busy}
          error={dialogError}
          icon={<Database className="w-5 h-5 text-amber-400" aria-hidden="true" />}
          onConfirm={confirmPending}
          onClose={closeDialog}
        >
          <p>This moves real money-equivalent GPU time on a customer account.</p>
          <dl className="grid grid-cols-2 gap-y-1 rounded-lg border border-white/10 bg-black/40 p-3 text-xs">
            <dt className="text-zinc-500">Account</dt>
            <dd className="text-right font-bold text-cyan-300">{pending.user.username}</dd>
            <dt className="text-zinc-500">User ID</dt>
            <dd className="text-right font-mono text-zinc-400">{pending.user.id}</dd>
            <dt className="text-zinc-500">Current balance</dt>
            <dd className="text-right font-mono text-zinc-300">{fmtBalance(pending.user.balance_minutes)}</dd>
            <dt className="text-zinc-500">Adjustment</dt>
            <dd className={cx('text-right font-mono font-bold', pending.minutes >= 0 ? 'text-emerald-300' : 'text-red-300')}>
              {pending.minutes >= 0 ? '+' : ''}{pending.minutes} min
            </dd>
            <dt className="text-zinc-500">Resulting balance</dt>
            <dd className="text-right font-mono font-bold text-amber-300">{fmtBalance(Math.max(0, pending.user.balance_minutes + pending.minutes))}</dd>
          </dl>
          {pending.user.balance_minutes + pending.minutes < 0 && (
            <p className="text-xs text-amber-300">The debit exceeds the balance. The server clamps at 0 — the excess is not carried as debt.</p>
          )}
          {!!pending.user.unlimited && (
            <p className="text-xs text-violet-300">This account is flagged unlimited, so billing never draws this balance down.</p>
          )}
        </ConfirmDialog>
      )}

      {pending?.kind === 'password' && (
        <ConfirmDialog
          title="Change this customer's password?"
          confirmLabel="Set password"
          busyLabel="Setting…"
          busy={busy}
          error={dialogError}
          icon={<KeyRound className="w-5 h-5 text-red-400" aria-hidden="true" />}
          onConfirm={confirmPending}
          onClose={closeDialog}
        >
          <p>
            This overwrites the credential for a real account and revokes every token it currently holds — the customer is logged
            out immediately and can only get back in with the password you set here.
          </p>
          <dl className="grid grid-cols-2 gap-y-1 rounded-lg border border-white/10 bg-black/40 p-3 text-xs">
            <dt className="text-zinc-500">Account</dt>
            <dd className="text-right font-bold text-cyan-300">{pending.user.username}</dd>
            <dt className="text-zinc-500">User ID</dt>
            <dd className="text-right font-mono text-zinc-400">{pending.user.id}</dd>
            <dt className="text-zinc-500">New password</dt>
            <dd className="text-right font-mono break-all text-amber-300">{pending.newPassword}</dd>
          </dl>
          <div>
            <label htmlFor="pw-confirm" className="mb-1 block text-xs text-zinc-400">
              Type <span className="font-mono font-bold text-zinc-200">{pending.user.username}</span> to confirm
            </label>
            <input
              id="pw-confirm"
              autoComplete="off"
              spellCheck={false}
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className={cx(INPUT_CLS, FOCUS, 'py-2 font-mono text-sm')}
            />
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>,
);
