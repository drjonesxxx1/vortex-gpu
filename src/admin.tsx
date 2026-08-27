import React, { useState, useEffect, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ShieldAlert, Cpu, Activity, Server, Zap, RefreshCw, Play, CheckCircle2,
  XCircle, Clock, Database, Terminal, HardDrive, Thermometer, Monitor,
} from 'lucide-react';
import './index.css';

/**
 * VortexGPU Admin — standalone hidden bundle.
 * Served ONLY at /admin?token=... (server 404s without the token).
 * Never linked from the public SPA.
 */

type GpuNode = {
  hostname: string;
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
  status: 'online' | 'offline';
};

type GpuJob = {
  id: string;
  hostname: string;
  kind: string;
  command: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result: string;
  createdAt: number;
  completedAt: number | null;
};

type ApiVm = {
  id: string;
  vm_id: number;
  node_hostname: string;
  name: string;
  os: string;
  sku: string;
  state: string;
  port: number | null;
  username: string | null;
  password: string | null;
  app: string | null;
  created_at: number;
};

type ApiUser = { id: string; username: string; balance_minutes: number; created_at: number };

function readToken(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('token') || '';
  const fromStore = localStorage.getItem('vortex_admin_token') || '';
  return fromUrl || fromStore;
}

function AdminApp() {
  const [token, setToken] = useState(readToken());
  const [authed, setAuthed] = useState(false);
  const [nodes, setNodes] = useState<GpuNode[]>([]);
  const [jobs, setJobs] = useState<GpuJob[]>([]);
  const [instances, setInstances] = useState<ApiVm[]>([]);
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [dispatchHost, setDispatchHost] = useState('');
  const [dispatchCmd, setDispatchCmd] = useState('');
  const [creditUserId, setCreditUserId] = useState('');
  const [creditMinutes, setCreditMinutes] = useState(60);
  const [msg, setMsg] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchState = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/state', { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 404) { setAuthed(false); return; }
      if (res.ok) {
        const data = await res.json();
        setNodes(data.nodes || []);
        setJobs(data.jobs || []);
        setInstances(data.vms || []);
        setUsers(data.users || []);
        setAuthed(true);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (token) localStorage.setItem('vortex_admin_token', token);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetchState();
    const t = setInterval(fetchState, 5000);
    return () => clearInterval(t);
  }, [token, fetchState]);

  const runJob = async () => {
    if (!dispatchHost || !dispatchCmd) { setMsg('Host and command required'); return; }
    setMsg('');
    const res = await fetch('/api/admin/gpu/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostname: dispatchHost, command: dispatchCmd }),
    });
    const data = await res.json();
    setMsg(res.ok ? `Job ${data.jobId} dispatched` : (data.error || 'failed'));
    fetchState();
  };

  const creditUser = async () => {
    if (!creditUserId) { setMsg('User id required'); return; }
    setMsg('');
    const res = await fetch('/api/admin/credit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: creditUserId, minutes: creditMinutes }),
    });
    const data = await res.json();
    setMsg(res.ok ? 'Balance credited' : (data.error || 'failed'));
    fetchState();
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6 font-mono text-zinc-100">
        <div className="w-full max-w-md bg-zinc-950 border border-red-500/40 rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-3 text-red-400">
            <ShieldAlert className="w-8 h-8" />
            <h1 className="text-lg font-bold uppercase tracking-wider">Admin Token Required</h1>
          </div>
          <input
            type="password"
            placeholder="Paste admin token"
            onChange={(e) => setToken(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-cyan-300 outline-none focus:border-red-500"
          />
          <p className="text-xs text-zinc-500">This panel is not linked anywhere in the public app.</p>
        </div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6 font-mono text-zinc-100">
        <div className="text-center space-y-4">
          <ShieldAlert className="w-12 h-12 text-red-500 mx-auto" />
          <h1 className="text-xl font-bold text-red-400">UNAUTHORIZED</h1>
          <p className="text-sm text-zinc-500">Invalid admin token.</p>
          <button onClick={() => { setToken(''); setAuthed(false); localStorage.removeItem('vortex_admin_token'); }} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold">Reset</button>
        </div>
      </div>
    );
  }

  const online = nodes.filter((n) => n.status === 'online').length;

  return (
    <div className="min-h-screen bg-black text-zinc-100 font-mono p-6 max-w-6xl mx-auto space-y-6">
      <header className="flex items-center justify-between border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-600 to-rose-800 flex items-center justify-center">
            <Server className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-black tracking-wider">VORTEX<span className="text-red-400">_GPU</span> ADMIN</h1>
            <p className="text-xs text-zinc-500">GPU node registry &amp; job dispatcher — hidden surface</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs bg-emerald-500/20 text-emerald-300 px-3 py-1 rounded border border-emerald-500/30">
            {online}/{nodes.length} nodes online
          </span>
          <button onClick={fetchState} className="p-2 bg-zinc-900 border border-zinc-800 rounded-lg hover:bg-zinc-800" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* GPU NODES */}
      <section>
        <h2 className="text-sm font-bold text-cyan-400 mb-3 flex items-center gap-2"><Cpu className="w-4 h-4" /> GPU NODES</h2>
        {nodes.length === 0 && <p className="text-sm text-zinc-600">No nodes registered. Run the Windows agent script on your GPU host.</p>}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {nodes.map((n) => (
            <div key={n.hostname} className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl space-y-2">
              <div className="flex justify-between items-center">
                <span className="font-bold text-cyan-300">{n.hostname}</span>
                <span className={`text-[10px] px-2 py-0.5 rounded border ${n.status === 'online' ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}`}>
                  {n.status.toUpperCase()}
                </span>
              </div>
              <div className="text-xs text-amber-300 font-bold">{n.gpuModel}</div>
              <div className="text-[11px] text-zinc-500">Driver {n.driverVersion}</div>
              <div className="space-y-1.5 pt-2 text-[11px]">
                <div className="flex justify-between"><span className="text-zinc-400 flex items-center gap-1"><Activity className="w-3 h-3" /> GPU</span><span className="text-emerald-400 font-bold">{n.gpuUtilPct}%</span></div>
                <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden"><div className="bg-emerald-400 h-full" style={{ width: `${n.gpuUtilPct}%` }} /></div>
                <div className="flex justify-between"><span className="text-zinc-400 flex items-center gap-1"><HardDrive className="w-3 h-3" /> VRAM</span><span className="text-amber-300 font-bold">{n.memUsedMb}/{n.memTotalMb} MB</span></div>
                <div className="flex justify-between"><span className="text-zinc-400 flex items-center gap-1"><Thermometer className="w-3 h-3" /> Temp</span><span className="text-cyan-300 font-bold">{n.tempC}°C</span></div>
                <div className="flex justify-between"><span className="text-zinc-400 flex items-center gap-1"><Database className="w-3 h-3" /> RAM</span><span className="text-zinc-300">{n.ramUsedGb}/{n.ramTotalGb} GB</span></div>
                <div className="flex justify-between"><span className="text-zinc-400 flex items-center gap-1"><Clock className="w-3 h-3" /> Uptime</span><span className="text-zinc-300">{Math.floor(n.uptimeSec / 3600)}h {Math.floor((n.uptimeSec % 3600) / 60)}m</span></div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* JOB DISPATCH */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="p-5 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3">
          <h2 className="text-sm font-bold text-amber-400 flex items-center gap-2"><Zap className="w-4 h-4" /> DISPATCH GPU JOB</h2>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">TARGET NODE:</label>
            <select value={dispatchHost} onChange={(e) => setDispatchHost(e.target.value)} className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 outline-none">
              <option value="">Select node...</option>
              {nodes.filter((n) => n.status === 'online').map((n) => <option key={n.hostname} value={n.hostname}>{n.hostname}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">COMMAND (run on Windows host):</label>
            <input value={dispatchCmd} onChange={(e) => setDispatchCmd(e.target.value)} placeholder="e.g. nvidia-smi --query-gpu=name --format=csv" className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 outline-none font-mono text-xs" />
          </div>
          <button onClick={runJob} className="w-full py-2.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 text-black font-bold rounded-lg text-xs uppercase flex items-center justify-center gap-2">
            <Play className="w-4 h-4" /> Dispatch
          </button>
          {msg && <p className="text-xs text-zinc-400">{msg}</p>}
        </div>

        {/* JOB QUEUE */}
        <div className="p-5 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3">
          <h2 className="text-sm font-bold text-cyan-400 flex items-center gap-2"><Terminal className="w-4 h-4" /> JOB QUEUE</h2>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {jobs.length === 0 && <p className="text-xs text-zinc-600">No jobs dispatched yet.</p>}
            {jobs.map((j) => (
              <div key={j.id} className="p-3 bg-zinc-900/60 border border-zinc-800 rounded-lg">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-bold text-cyan-300">{j.hostname}</span>
                  <span className={`flex items-center gap-1 ${j.status === 'done' ? 'text-emerald-400' : j.status === 'failed' ? 'text-red-400' : j.status === 'running' ? 'text-amber-400' : 'text-zinc-400'}`}>
                    {j.status === 'done' ? <CheckCircle2 className="w-3 h-3" /> : j.status === 'failed' ? <XCircle className="w-3 h-3" /> : <RefreshCw className="w-3 h-3 animate-spin" />}
                    {j.status.toUpperCase()}
                  </span>
                </div>
                <div className="text-[11px] text-zinc-500 font-mono mt-1 break-all">{j.kind === 'provision_comfyui' ? 'provision: ' + JSON.stringify(j.payload) : j.command}</div>
                {j.result && <pre className="text-[11px] text-emerald-400 bg-black rounded p-2 mt-2 overflow-x-auto whitespace-pre-wrap">{j.result}</pre>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CREDIT USER */}
      <section className="p-5 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3">
        <h2 className="text-sm font-bold text-emerald-400 flex items-center gap-2"><Database className="w-4 h-4" /> CREDIT USER BALANCE</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <input value={creditUserId} onChange={(e) => setCreditUserId(e.target.value)} placeholder="User ID" className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 outline-none font-mono text-xs" />
          <input type="number" value={creditMinutes} onChange={(e) => setCreditMinutes(Number(e.target.value))} placeholder="Minutes" className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 outline-none font-mono text-xs" />
          <button onClick={creditUser} className="py-2 bg-emerald-500 hover:bg-emerald-400 text-black font-bold rounded-lg text-xs">Credit</button>
        </div>
      </section>

      {/* INSTANCES */}
      <section className="p-5 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3">
        <h2 className="text-sm font-bold text-cyan-400 flex items-center gap-2"><Monitor className="w-4 h-4" /> RENTED MACHINES ({instances.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left text-zinc-300">
            <thead><tr className="border-b border-zinc-800 text-zinc-500 uppercase text-[10px]">
              <th className="py-2 px-3">Name</th><th className="py-2 px-3">OS</th><th className="py-2 px-3">SKU</th><th className="py-2 px-3">VMID</th><th className="py-2 px-3">Port</th><th className="py-2 px-3">State</th>
            </tr></thead>
            <tbody className="divide-y divide-zinc-800/50">
              {instances.map((i) => (
                <tr key={i.id} className="hover:bg-zinc-900/50">
                  <td className="py-2 px-3 font-bold text-cyan-300">{i.name}</td>
                  <td className="py-2 px-3 text-zinc-400">{i.os}</td>
                  <td className="py-2 px-3 text-amber-300">{i.sku}</td>
                  <td className="py-2 px-3 font-mono text-zinc-400">{i.vm_id}</td>
                  <td className="py-2 px-3 font-mono text-emerald-400">{i.port ?? '—'}</td>
                  <td className="py-2 px-3"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${i.state === 'running' ? 'bg-emerald-500/20 text-emerald-300' : i.state === 'failed' ? 'bg-red-500/20 text-red-300' : 'bg-amber-500/20 text-amber-300'}`}>{i.state}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* USERS */}
      <section className="p-5 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3">
        <h2 className="text-sm font-bold text-cyan-400 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> USERS ({users.length})</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left text-zinc-300">
            <thead><tr className="border-b border-zinc-800 text-zinc-500 uppercase text-[10px]">
              <th className="py-2 px-3">User</th><th className="py-2 px-3">Balance</th><th className="py-2 px-3">ID</th>
            </tr></thead>
            <tbody className="divide-y divide-zinc-800/50">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-zinc-900/50">
                  <td className="py-2 px-3 font-bold text-cyan-300">{u.username}</td>
                  <td className="py-2 px-3 text-amber-300">{u.balance_minutes}m</td>
                  <td className="py-2 px-3 font-mono text-zinc-500">{u.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AdminApp />
  </React.StrictMode>
);
