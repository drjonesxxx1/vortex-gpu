import React, { useState } from 'react';
import {
  ShieldAlert,
  Globe,
  Settings,
  Server,
  Cpu,
  Power,
  RefreshCw,
  Sliders,
  CheckCircle,
  XCircle,
  Database,
  Lock,
  Zap,
} from 'lucide-react';
import { ProxiflyGlobalConfig, SystemNode, VM } from '../types';

interface AdminDashboardProps {
  isAdminAuthenticated: boolean;
  onAdminLogin: (user: string, pass: string) => boolean;
  proxiflyConfig: ProxiflyGlobalConfig;
  onUpdateProxifly: (config: Partial<ProxiflyGlobalConfig>) => void;
  nodes: SystemNode[];
  vms: VM[];
  onForceKillVm: (vmId: string) => void;
  onRotateAllProxies: () => void;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  isAdminAuthenticated,
  onAdminLogin,
  proxiflyConfig,
  onUpdateProxifly,
  nodes,
  vms,
  onForceKillVm,
  onRotateAllProxies,
}) => {
  const [loginUser, setLoginUser] = useState('drjones');
  const [loginPass, setLoginPass] = useState('');
  const [loginError, setLoginError] = useState('');

  // Local admin tab
  const [activeTab, setActiveTab] = useState<'proxifly' | 'nodes' | 'vms' | 'gpu_scheduling' | 'powershell_agent'>('proxifly');
  const [scriptCopied, setScriptCopied] = useState(false);

  // Scheduler knobs
  const [idleShutdownMins, setIdleShutdownMins] = useState(10);
  const [oversubscriptionFactor, setOversubscriptionFactor] = useState(4);
  const [enableMigMode, setEnableMigMode] = useState(true);

  const psScript = `# =====================================================================
# VORTEX_GPU PHYSICAL WINDOWS HOST NODE AGENT INSTALLER
# Author: drjones | Target OS: Windows 11 / Windows Server 2025
# Hardware Requirement: NVIDIA GeForce RTX 4070 / 4080 / 4080 Super
# =====================================================================

Write-Host "[VortexGPU] Initializing CUDA 12.5 Host Bridge Agent..." -ForegroundColor Cyan

# 1. Enable Hyper-V & WSL2 Passthrough
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All -NoRestart

# 2. Configure NVIDIA GPU Paravirtualization (vGPU / Time-Slice)
$GpuName = (Get-CimInstance Win32_VideoController | Where-Object {$_.Name -like "*RTX 40*"}).Name
Write-Host "[NVIDIA] Detected local GPU: $GpuName" -ForegroundColor Green

# 3. Register Node Gateway with Vortex Platform
$GatewayUri = "http://localhost:3000/api/vms/control"
$NodeConfig = @{
    hostname = $env:COMPUTERNAME
    gpuModel = $GpuName
    proxiflyBridge = "ENABLED"
    idleTimeoutMin = ${idleShutdownMins}
    timeSliceFactor = ${oversubscriptionFactor}
}

Invoke-RestMethod -Uri $GatewayUri -Method Post -Body ($NodeConfig | ConvertTo-Json) -ContentType "application/json"
Write-Host "[SUCCESS] Windows Host Node active. Ready for $1/hr VM rentals!" -ForegroundColor Green`;

  const copyScript = () => {
    navigator.clipboard.writeText(psScript);
    setScriptCopied(true);
    setTimeout(() => setScriptCopied(false), 2000);
  };

  const handleLoginSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const success = onAdminLogin(loginUser, loginPass);
    if (!success) {
      setLoginError('Invalid Administrator Credentials. Only drjones is authorized.');
    } else {
      setLoginError('');
    }
  };

  if (!isAdminAuthenticated) {
    return (
      <div className="max-w-md mx-auto my-12 p-6 bg-zinc-950 border border-red-500/40 rounded-2xl shadow-2xl font-mono">
        <div className="flex items-center gap-3 mb-6 text-red-400">
          <ShieldAlert className="w-8 h-8 animate-pulse" />
          <div>
            <h2 className="text-lg font-bold text-white uppercase tracking-wider">RESTRICTED ADMIN ACCESS</h2>
            <p className="text-xs text-zinc-400">User Authentication Required: "drjones"</p>
          </div>
        </div>

        {loginError && (
          <div className="mb-4 p-3 bg-red-950/60 border border-red-500/50 rounded-lg text-xs text-red-300">
            {loginError}
          </div>
        )}

        <form onSubmit={handleLoginSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">ADMIN USERNAME:</label>
            <input
              type="text"
              value={loginUser}
              onChange={(e) => setLoginUser(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 font-mono text-sm outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">SECURITY ACCESS PASSCODE:</label>
            <input
              type="password"
              value={loginPass}
              onChange={(e) => setLoginPass(e.target.value)}
              placeholder="••••••••••••"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 font-mono text-sm outline-none focus:border-red-500"
            />
          </div>

          <button
            type="submit"
            className="w-full py-3 bg-red-600 hover:bg-red-500 text-white font-bold rounded-xl tracking-wider text-xs uppercase transition-colors shadow-lg shadow-red-600/30"
          >
            Authenticate drjones Session
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6 font-mono text-zinc-200">
      {/* Admin Top Banner */}
      <div className="flex flex-wrap items-center justify-between p-4 bg-zinc-950 border border-red-500/40 rounded-xl shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center text-red-400">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white tracking-wider flex items-center gap-2">
              DRJONES ROOT SYSTEM CONTROL <span className="text-[10px] bg-red-500/20 text-red-300 px-2 py-0.5 rounded border border-red-500/30 uppercase">Master Admin</span>
            </h2>
            <p className="text-xs text-zinc-400">
              Proxifly Backend Router & RTX 4080 / 4070 Multi-Tenant GPU Scheduler Engine
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setActiveTab('proxifly')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'proxifly'
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
                : 'bg-zinc-900 text-zinc-400 hover:text-white'
            }`}
          >
            PROXIFLY ENGINE
          </button>
          <button
            onClick={() => setActiveTab('gpu_scheduling')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'gpu_scheduling'
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
                : 'bg-zinc-900 text-zinc-400 hover:text-white'
            }`}
          >
            GPU SCHEDULER
          </button>
          <button
            onClick={() => setActiveTab('powershell_agent')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'powershell_agent'
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
                : 'bg-zinc-900 text-zinc-400 hover:text-white'
            }`}
          >
            WINDOWS AGENT (.PS1)
          </button>
          <button
            onClick={() => setActiveTab('nodes')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'nodes'
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
                : 'bg-zinc-900 text-zinc-400 hover:text-white'
            }`}
          >
            HOST NODES
          </button>
          <button
            onClick={() => setActiveTab('vms')}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
              activeTab === 'vms'
                ? 'bg-red-600 text-white shadow-lg shadow-red-600/30'
                : 'bg-zinc-900 text-zinc-400 hover:text-white'
            }`}
          >
            ACTIVE VMS ({vms.length})
          </button>
        </div>
      </div>

      {/* PROXIFLY BACKEND CONTROLS */}
      {activeTab === 'proxifly' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-5 bg-zinc-950 border border-emerald-500/30 rounded-xl space-y-4">
            <div className="flex items-center justify-between border-b border-emerald-500/20 pb-3">
              <h3 className="text-sm font-bold text-emerald-400 flex items-center gap-2">
                <Globe className="w-4 h-4" /> PROXIFLY BACKEND CONFIGURATION
              </h3>
              <button
                onClick={onRotateAllProxies}
                className="px-2.5 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 rounded border border-emerald-500/30 text-xs transition-colors flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" /> Force Global IP Rotation
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-zinc-400 mb-1">PROXIFLY ROUTING MODE:</label>
                <select
                  value={proxiflyConfig.mode}
                  onChange={(e) => onUpdateProxifly({ mode: e.target.value as any })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 outline-none"
                >
                  <option value="random_residential">Random Residential Pool (High Stealth)</option>
                  <option value="datacenter_rotation">Datacenter Fast Rotation (Ultra Latency)</option>
                  <option value="strict_stealth">Strict Stealth Residential (No Leak Guarantee)</option>
                </select>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">AUTO ROTATION INTERVAL (MINUTES):</label>
                <input
                  type="number"
                  value={proxiflyConfig.autoRotateMinutes}
                  onChange={(e) => onUpdateProxifly({ autoRotateMinutes: Number(e.target.value) })}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 outline-none"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <span className="text-zinc-300">BLOCK MALICIOUS SUBNETS:</span>
                <button
                  onClick={() => onUpdateProxifly({ blockMaliciousRanges: !proxiflyConfig.blockMaliciousRanges })}
                  className={`px-3 py-1 rounded text-xs font-bold ${
                    proxiflyConfig.blockMaliciousRanges ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-red-500/20 text-red-300 border border-red-500/40'
                  }`}
                >
                  {proxiflyConfig.blockMaliciousRanges ? 'ACTIVE' : 'DISABLED'}
                </button>
              </div>
            </div>
          </div>

          <div className="p-5 bg-zinc-950 border border-cyan-500/30 rounded-xl space-y-4">
            <h3 className="text-sm font-bold text-cyan-400 border-b border-cyan-500/20 pb-3 flex items-center gap-2">
              <Zap className="w-4 h-4" /> PROXIFLY LIVE METRICS
            </h3>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 bg-zinc-900/80 rounded-lg border border-zinc-800">
                <div className="text-zinc-400">Total Residential Pool:</div>
                <div className="text-lg font-bold text-cyan-300">{proxiflyConfig.activePoolSize.toLocaleString()} IPs</div>
              </div>

              <div className="p-3 bg-zinc-900/80 rounded-lg border border-zinc-800">
                <div className="text-zinc-400">Active Proxy Tunnels:</div>
                <div className="text-lg font-bold text-emerald-400">{proxiflyConfig.activeProxiesCount}</div>
              </div>

              <div className="p-3 bg-zinc-900/80 rounded-lg border border-zinc-800">
                <div className="text-zinc-400">Average Tunnel Latency:</div>
                <div className="text-lg font-bold text-amber-300">{proxiflyConfig.avgLatencyMs} ms</div>
              </div>

              <div className="p-3 bg-zinc-900/80 rounded-lg border border-zinc-800">
                <div className="text-zinc-400">Default Allocation:</div>
                <div className="text-xs font-bold text-emerald-300 mt-1">Randomized on every VM launch</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* GPU SCHEDULER CONFIGURATION */}
      {activeTab === 'gpu_scheduling' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="p-5 bg-zinc-950 border border-amber-500/30 rounded-xl space-y-4">
            <h3 className="text-sm font-bold text-amber-400 border-b border-amber-500/20 pb-3 flex items-center gap-2">
              <Sliders className="w-4 h-4" /> MULTI-TENANT OVERSUBSCRIPTION KNOBS
            </h3>

            <div className="space-y-4 text-xs">
              <div>
                <div className="flex justify-between text-zinc-300 mb-1">
                  <span>MAX TENANT VGPU OVERSUBSCRIPTION:</span>
                  <span className="text-cyan-400 font-bold">{oversubscriptionFactor}x Instances per 4080 GPU</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={12}
                  value={oversubscriptionFactor}
                  onChange={(e) => setOversubscriptionFactor(Number(e.target.value))}
                  className="w-full accent-amber-500 bg-zinc-900 rounded cursor-pointer"
                />
                <p className="text-[10px] text-zinc-500 mt-1">
                  Time-slicing multiplexing allows supporting up to {oversubscriptionFactor * 8} simultaneous active browser stream users per host node card.
                </p>
              </div>

              <div>
                <div className="flex justify-between text-zinc-300 mb-1">
                  <span>IDLE AUTO-POWER OFF TIMEOUT:</span>
                  <span className="text-amber-300 font-bold">{idleShutdownMins} Minutes</span>
                </div>
                <input
                  type="range"
                  min={3}
                  max={60}
                  step={1}
                  value={idleShutdownMins}
                  onChange={(e) => setIdleShutdownMins(Number(e.target.value))}
                  className="w-full accent-amber-500 bg-zinc-900 rounded cursor-pointer"
                />
                <p className="text-[10px] text-zinc-500 mt-1">
                  If no active browser websocket or RDP session is connected, VM powers down to save GPU power and preserve tenant $1/hr budget.
                </p>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-zinc-800">
                <span className="text-zinc-300">NVIDIA CUDA MIG / VGPU MODE:</span>
                <button
                  onClick={() => setEnableMigMode(!enableMigMode)}
                  className={`px-3 py-1 rounded text-xs font-bold ${
                    enableMigMode ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-red-500/20 text-red-300 border border-red-500/40'
                  }`}
                >
                  {enableMigMode ? 'HARDWARE OPTIX ON' : 'SOFTWARE FALLBACK'}
                </button>
              </div>
            </div>
          </div>

          <div className="p-5 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3 text-xs">
            <h3 className="text-sm font-bold text-cyan-400 border-b border-zinc-800 pb-3 flex items-center gap-2">
              <Cpu className="w-4 h-4" /> SCALING & HARDWARE ACCELERATION STATUS
            </h3>

            <div className="space-y-2 text-zinc-300">
              <div className="flex justify-between p-2 bg-zinc-900/60 rounded">
                <span>Total Host Rig VRAM:</span>
                <span className="text-emerald-400 font-bold">128 GB GDDR6X</span>
              </div>
              <div className="flex justify-between p-2 bg-zinc-900/60 rounded">
                <span>Scheduled Virtual Instances:</span>
                <span className="text-cyan-300 font-bold">{vms.length} VMs ({vms.filter(v => v.state === 'running').length} Running)</span>
              </div>
              <div className="flex justify-between p-2 bg-zinc-900/60 rounded">
                <span>Average Node Power Usage:</span>
                <span className="text-amber-300 font-bold">210W / 320W TDP</span>
              </div>
              <div className="flex justify-between p-2 bg-zinc-900/60 rounded">
                <span>In-Browser Stream Latency:</span>
                <span className="text-emerald-400 font-bold">&lt; 18 ms (Sub-frame H.264 WebRTC)</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* WINDOWS LOCAL HOST AGENT SCRIPT GENERATOR */}
      {activeTab === 'powershell_agent' && (
        <div className="p-5 bg-zinc-950 border border-cyan-500/30 rounded-xl space-y-4">
          <div className="flex items-center justify-between border-b border-cyan-500/20 pb-3">
            <div>
              <h3 className="text-sm font-bold text-cyan-300 flex items-center gap-2">
                <Server className="w-4 h-4 text-emerald-400" /> SELF-HOST WINDOWS 11 NODE AGENT DEPLOYMENT
              </h3>
              <p className="text-xs text-zinc-400">
                Run this script in PowerShell (Admin) on your Windows machine with an RTX 4070 / 4080 GPU to hook your local hardware directly into the platform gateway.
              </p>
            </div>

            <button
              onClick={copyScript}
              className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded-lg text-xs transition-colors shadow-md shadow-cyan-500/20"
            >
              {scriptCopied ? 'COPIED TO CLIPBOARD!' : 'COPY POWERSHELL SCRIPT'}
            </button>
          </div>

          <pre className="p-4 bg-black rounded-lg border border-zinc-800 text-xs text-emerald-400 font-mono overflow-x-auto leading-relaxed">
            {psScript}
          </pre>
        </div>
      )}
      {activeTab === 'nodes' && (
        <div className="space-y-4">
          <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl text-xs text-zinc-300 flex justify-between items-center">
            <div>
              <span className="font-bold text-amber-400">VORTEX SCHEDULER ALGORITHM:</span> Dynamic Time-Slice & VRAM Oversubscription for RTX 4080 / 4070 Nodes. Supports 1,000+ concurrent tenant sessions with automatic idle suspend.
            </div>
            <span className="px-2 py-1 bg-emerald-500/20 text-emerald-300 rounded border border-emerald-500/30 text-[10px]">EFFICIENT SCALING ON</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {nodes.map((node) => (
              <div key={node.nodeId} className="p-4 bg-zinc-950 border border-cyan-500/20 rounded-xl space-y-3">
                <div className="flex justify-between items-center border-b border-zinc-800 pb-2">
                  <span className="font-bold text-cyan-300">{node.hostname}</span>
                  <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/30">
                    {node.status.toUpperCase()}
                  </span>
                </div>

                <div className="space-y-1.5 text-xs text-zinc-400">
                  <div>Region: <span className="text-white">{node.region}</span></div>
                  <div>GPU Core: <span className="text-amber-300 font-bold">{node.gpuType}</span></div>
                  <div>Physical GPUs: <span className="text-white">{node.totalGpus}</span></div>
                  <div>Assigned VMs: <span className="text-cyan-400 font-bold">{node.assignedVms}</span></div>
                </div>

                <div className="pt-2 border-t border-zinc-800/80 space-y-1 text-[11px]">
                  <div className="flex justify-between">
                    <span>CPU LOAD:</span>
                    <span className="text-emerald-400 font-bold">{node.cpuUsagePct}%</span>
                  </div>
                  <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-emerald-400 h-full" style={{ width: `${node.cpuUsagePct}%` }} />
                  </div>

                  <div className="flex justify-between pt-1">
                    <span>GPU VRAM UTIL:</span>
                    <span className="text-amber-400 font-bold">{node.gpuUsagePct}%</span>
                  </div>
                  <div className="w-full bg-zinc-900 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-amber-400 h-full" style={{ width: `${node.gpuUsagePct}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ACTIVE VMS MANAGEMENT */}
      {activeTab === 'vms' && (
        <div className="p-4 bg-zinc-950 border border-zinc-800 rounded-xl space-y-3">
          <h3 className="text-sm font-bold text-cyan-400">GLOBAL ACTIVE VM INSTANCES ({vms.length})</h3>

          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left text-zinc-300 border-collapse">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-400 uppercase text-[10px]">
                  <th className="py-2 px-3">VM ID / Name</th>
                  <th className="py-2 px-3">Owner</th>
                  <th className="py-2 px-3">OS / GPU</th>
                  <th className="py-2 px-3">Proxifly IP</th>
                  <th className="py-2 px-3">State</th>
                  <th className="py-2 px-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {vms.map((vm) => (
                  <tr key={vm.id} className="hover:bg-zinc-900/50">
                    <td className="py-2.5 px-3 font-bold text-cyan-300">
                      {vm.name} <span className="text-[10px] text-zinc-500">({vm.id})</span>
                    </td>
                    <td className="py-2.5 px-3 text-amber-300">{vm.userId}</td>
                    <td className="py-2.5 px-3">
                      {vm.os.toUpperCase()} | {vm.gpuSpec}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-emerald-400">
                      {vm.proxiflyIp} <span className="text-[10px] text-zinc-500">({vm.proxiflyLocation})</span>
                    </td>
                    <td className="py-2.5 px-3">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        vm.state === 'running' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-400'
                      }`}>
                        {vm.state.toUpperCase()}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      <button
                        onClick={() => onForceKillVm(vm.id)}
                        className="px-2 py-1 bg-red-600/30 hover:bg-red-600 text-red-300 hover:text-white rounded text-[10px] font-bold transition-colors"
                      >
                        FORCE KILL
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
