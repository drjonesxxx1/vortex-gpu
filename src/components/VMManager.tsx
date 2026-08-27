import React, { useState } from 'react';
import {
  Monitor,
  Power,
  RefreshCw,
  Download,
  Sparkles,
  Globe,
  Cpu,
  Shield,
  Layers,
  Plus,
  Zap,
  Play,
  RotateCcw,
  Clock,
  Terminal,
} from 'lucide-react';
import { VM, OSName, GpuSpec } from '../types';
import { AI_APP_TEMPLATES } from '../data/mockData';

interface VMManagerProps {
  vms: VM[];
  activeVmId: string | null;
  onSelectVm: (id: string) => void;
  onCreateVm: (os: OSName, gpu: GpuSpec, name: string, appTemplate: string) => void;
  onTogglePower: (vmId: string) => void;
  onRollDistro: (vmId: string, newOs: OSName) => void;
  onRotateVmProxy: (vmId: string) => void;
  onLaunchDesktop: (vm: VM) => void;
  userBalanceMinutes: number;
}

export const VMManager: React.FC<VMManagerProps> = ({
  vms,
  activeVmId,
  onSelectVm,
  onCreateVm,
  onTogglePower,
  onRollDistro,
  onRotateVmProxy,
  onLaunchDesktop,
  userBalanceMinutes,
}) => {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newVmName, setNewVmName] = useState('Cyber-Workstation-01');
  const [selectedOs, setSelectedOs] = useState<OSName>('ubuntu24');
  const [selectedGpu, setSelectedGpu] = useState<GpuSpec>('RTX 4080 Super 16GB');
  const [selectedApp, setSelectedApp] = useState<string>('comfyui');

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onCreateVm(selectedOs, selectedGpu, newVmName, selectedApp);
    setShowCreateModal(false);
  };

  const downloadRdpConfig = (vm: VM) => {
    const rdpContent = `full address:s:${vm.proxiflyIp}:${vm.rdpPort}
username:s:${vm.rdpUser}
prompt for credentials:i:1
desktopwidth:i:1920
desktopheight:i:1080
screen mode id:i:2
redirectsmartcards:i:0
audiomode:i:0
videoplaybackmode:i:1
connection type:i:7
networkautodetect:i:1
bandwidthautodetect:i:1
enablecredsspsupport:i:1
authentication level:i:2`;

    const blob = new Blob([rdpContent], { type: 'application/x-rdp' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${vm.name.toLowerCase().replace(/\s+/g, '_')}_autordp.rdp`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="space-y-6 font-mono">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-zinc-950 border border-cyan-500/30 rounded-xl shadow-xl">
        <div>
          <h2 className="text-lg font-bold text-white tracking-wider flex items-center gap-2">
            YOUR GPU VIRTUAL MACHINES
            <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded border border-emerald-500/30">
              $1.00 / HOUR
            </span>
          </h2>
          <p className="text-xs text-zinc-400">
            Hardware accelerated NVIDIA RTX 4080 / 4070. Auto power-off when disconnected.
          </p>
        </div>

        <button
          onClick={() => setShowCreateModal(true)}
          className="px-4 py-2.5 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-black font-bold text-xs rounded-xl flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition-all"
        >
          <Plus className="w-4 h-4" /> PROVISION NEW VM ($1/HR)
        </button>
      </div>

      {/* VM Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {vms.map((vm) => {
          const isSelected = activeVmId === vm.id;
          return (
            <div
              key={vm.id}
              onClick={() => onSelectVm(vm.id)}
              className={`p-5 rounded-xl border transition-all cursor-pointer ${
                isSelected
                  ? 'bg-zinc-950 border-cyan-500 shadow-[0_0_20px_rgba(6,182,212,0.15)]'
                  : 'bg-zinc-950/70 border-zinc-800 hover:border-zinc-700'
              }`}
            >
              {/* Card Top */}
              <div className="flex items-start justify-between border-b border-zinc-800/80 pb-3 mb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold text-cyan-300">{vm.name}</h3>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                        vm.state === 'running'
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : vm.state === 'booting'
                          ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                          : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {vm.state}
                    </span>
                  </div>
                  <div className="text-xs text-zinc-400 mt-1 flex items-center gap-3">
                    <span className="text-amber-300 font-semibold">{vm.gpuSpec}</span>
                    <span>•</span>
                    <span className="uppercase">{vm.os}</span>
                    <span>•</span>
                    <span>32GB RAM / 8 vCPU</span>
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePower(vm.id);
                  }}
                  className={`p-2 rounded-lg border transition-colors ${
                    vm.state === 'running'
                      ? 'bg-emerald-500/20 border-emerald-500/40 text-emerald-400 hover:bg-red-500/20 hover:border-red-500 hover:text-red-400'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-emerald-400'
                  }`}
                  title={vm.state === 'running' ? 'Shut Down VM' : 'Power On VM'}
                >
                  <Power className="w-4 h-4" />
                </button>
              </div>

              {/* Specs & Proxifly Proxy info */}
              <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
                <div className="p-2.5 bg-zinc-900/60 rounded-lg border border-zinc-800/80">
                  <div className="text-zinc-500 text-[10px] uppercase">Proxifly IP Routing:</div>
                  <div className="text-emerald-400 font-bold truncate flex items-center gap-1 mt-0.5">
                    <Globe className="w-3 h-3" /> {vm.proxiflyIp}
                  </div>
                  <div className="text-[10px] text-zinc-400">{vm.proxiflyLocation} ({vm.proxiflyProtocol})</div>
                </div>

                <div className="p-2.5 bg-zinc-900/60 rounded-lg border border-zinc-800/80">
                  <div className="text-zinc-500 text-[10px] uppercase">Auto Idle Protection:</div>
                  <div className="text-amber-300 font-bold flex items-center gap-1 mt-0.5">
                    <Clock className="w-3 h-3" /> Auto Off if Idle
                  </div>
                  <div className="text-[10px] text-zinc-400">Preserves $1/hr budget</div>
                </div>
              </div>

              {/* Quick Action Buttons */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-zinc-800/80 text-[11px]">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onLaunchDesktop(vm);
                  }}
                  disabled={vm.state !== 'running'}
                  className="py-2 px-2 bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-black font-bold rounded-lg flex items-center justify-center gap-1 transition-colors"
                >
                  <Play className="w-3.5 h-3.5" /> BROWSER STREAM
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadRdpConfig(vm);
                  }}
                  className="py-2 px-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 rounded-lg flex items-center justify-center gap-1 transition-colors"
                >
                  <Download className="w-3.5 h-3.5 text-cyan-400" /> AUTO RDP
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRotateVmProxy(vm.id);
                  }}
                  className="py-2 px-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 rounded-lg flex items-center justify-center gap-1 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-400" /> ROTATE IP
                </button>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const newOs: OSName = vm.os === 'ubuntu24' ? 'windows11' : vm.os === 'windows11' ? 'kali' : 'ubuntu24';
                    onRollDistro(vm.id, newOs);
                  }}
                  className="py-2 px-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800 rounded-lg flex items-center justify-center gap-1 transition-colors"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-purple-400" /> ROLL DISTRO
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* PROVISION NEW VM MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-xl bg-zinc-950 border border-cyan-500/40 rounded-2xl p-6 shadow-2xl relative">
            <button
              onClick={() => setShowCreateModal(false)}
              className="absolute top-4 right-4 text-zinc-400 hover:text-white font-bold"
            >
              &times;
            </button>

            <h2 className="text-lg font-bold text-cyan-300 mb-1 flex items-center gap-2">
              <Zap className="w-5 h-5 text-amber-400" /> PROVISION HARDWARE ACCELERATED VM
            </h2>
            <p className="text-xs text-zinc-400 mb-6">
              Instant launch. Flat rate $1.00 / hr. Baked-in RTX 4080 / 4070 GPU + Proxifly random IP.
            </p>

            <form onSubmit={handleCreateSubmit} className="space-y-4 text-xs">
              <div>
                <label className="block text-zinc-400 mb-1">VM INSTANCE IDENTIFIER:</label>
                <input
                  type="text"
                  value={newVmName}
                  onChange={(e) => setNewVmName(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 outline-none focus:border-cyan-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-400 mb-1">OPERATING SYSTEM:</label>
                  <select
                    value={selectedOs}
                    onChange={(e) => setSelectedOs(e.target.value as OSName)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-cyan-300 outline-none"
                  >
                    <option value="ubuntu24">Ubuntu 24.04 LTS Desktop (AI Ready)</option>
                    <option value="windows11">Windows 11 Enterprise (RTX OptiX)</option>
                    <option value="kali">Kali CyberSec Offensive Lab</option>
                    <option value="arch">Arch Linux (Bleeding Edge)</option>
                    <option value="debian">Debian 12 Stable Workspace</option>
                  </select>
                </div>

                <div>
                  <label className="block text-zinc-400 mb-1">GPU ACCELERATION SPECS:</label>
                  <select
                    value={selectedGpu}
                    onChange={(e) => setSelectedGpu(e.target.value as GpuSpec)}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-amber-300 outline-none font-bold"
                  >
                    <option value="RTX 4080 Super 16GB">NVIDIA RTX 4080 Super 16GB VRAM</option>
                    <option value="RTX 4070 12GB">NVIDIA RTX 4070 12GB VRAM</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-zinc-400 mb-1">PRE-INSTALLED AI / APP TEMPLATE:</label>
                <div className="grid grid-cols-2 gap-2">
                  {AI_APP_TEMPLATES.map((tmpl) => (
                    <div
                      key={tmpl.id}
                      onClick={() => setSelectedApp(tmpl.id)}
                      className={`p-2.5 rounded-lg border cursor-pointer transition-all ${
                        selectedApp === tmpl.id
                          ? 'bg-cyan-950/60 border-cyan-500 text-cyan-300'
                          : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                      }`}
                    >
                      <div className="font-bold">{tmpl.name}</div>
                      <div className="text-[10px] text-zinc-500 line-clamp-1">{tmpl.description}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  className="w-full py-3 bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-black font-bold rounded-xl text-xs uppercase tracking-wider"
                >
                  LAUNCH INSTANCE ($1.00 / HOUR)
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
