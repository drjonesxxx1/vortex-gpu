import React, { useState } from 'react';
import { Terminal, Shield, Cpu, RefreshCw, Send, HelpCircle, HardDrive, Zap } from 'lucide-react';
import { VM, UserSession } from '../types';

interface NeonTerminalProps {
  vm: VM | null;
  user: UserSession;
  onExecuteCommand: (cmd: string) => void;
  onVmStateChange: (state: 'booting' | 'running' | 'off') => void;
}

export const NeonTerminal: React.FC<NeonTerminalProps> = ({
  vm,
  user,
  onExecuteCommand,
  onVmStateChange,
}) => {
  const [inputCmd, setInputCmd] = useState('');
  const [logs, setLogs] = useState<Array<{ id: string; text: string; type: 'cmd' | 'output' | 'system' | 'error' }>>([
    { id: '1', text: '=== VORTEX_GPU KERNEL v4.8.1-PROXIFLY READY ===', type: 'system' },
    { id: '2', text: `SESSION IDENT: ${user.username.toUpperCase()} | BALANCE: ${user.balanceMinutes} MINUTES`, type: 'system' },
    { id: '3', text: 'Type "help", "status", "proxifly rotate", "apps", or "gpu-info" for available hacking controls.', type: 'system' },
  ]);

  const handleSend = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputCmd.trim()) return;

    const trimmed = inputCmd.trim();
    const newLogs = [...logs, { id: String(Date.now()), text: `${user.username}@vortex-node:~$ ${trimmed}`, type: 'cmd' as const }];
    setInputCmd('');

    const lower = trimmed.toLowerCase();

    if (lower === 'help') {
      newLogs.push({
        id: String(Date.now() + 1),
        text: `AVAILABLE COMMANDS:
- status : Show active VM, GPU load, Proxifly IP, and RDP port
- poweron / poweroff : Toggle physical node power
- proxifly rotate : Force IP rotation via Proxifly residential pool
- gpu-info : Query NVIDIA RTX 4080/4070 driver stats & CUDA status
- apps : List deployable AI apps (ComfyUI, Ollama, Fooocus)
- clear : Clear terminal screen history
- rdp-setup : Re-generate auto RDP credentials & streaming token`,
        type: 'output',
      });
    } else if (lower === 'status') {
      if (!vm) {
        newLogs.push({ id: String(Date.now() + 1), text: 'NO ACTIVE VM INSTANCE DEPLOYED. Use the UI to provision a $1/hr GPU VM.', type: 'error' });
      } else {
        newLogs.push({
          id: String(Date.now() + 1),
          text: `[VM:${vm.id}] OS: ${vm.os.toUpperCase()} | STATE: ${vm.state.toUpperCase()}
GPU: ${vm.gpuSpec} | VRAM: ${vm.stats.vramUsedGb}/${vm.stats.vramTotalGb} GB
PROXIFLY IP: ${vm.proxiflyIp} (${vm.proxiflyLocation}) [${vm.proxiflyProtocol}]
AUTO POWER-OFF: Enabled if disconnected for > 10 min.`,
          type: 'output',
        });
      }
    } else if (lower === 'proxifly rotate') {
      newLogs.push({
        id: String(Date.now() + 1),
        text: '[PROXIFLY] Initiating residential IP rotation sequence...',
        type: 'system',
      });
      setTimeout(() => {
        onExecuteCommand('proxifly_rotate');
      }, 500);
    } else if (lower === 'poweron') {
      onVmStateChange('booting');
      newLogs.push({ id: String(Date.now() + 1), text: '[POWER] Booting GPU host node...', type: 'system' });
    } else if (lower === 'poweroff') {
      onVmStateChange('off');
      newLogs.push({ id: String(Date.now() + 1), text: '[POWER] Shutdown signal sent to node.', type: 'system' });
    } else if (lower === 'gpu-info') {
      newLogs.push({
        id: String(Date.now() + 1),
        text: `+-----------------------------------------------------------------------------+
| NVIDIA-SMI 555.42.02    Driver Version: 555.42.02    CUDA Version: 12.5     |
|-------------------------------+----------------------+----------------------+
| GPU  Name        Persistence-M| Bus-Id        Disp.A | Volatile Uncorr. ECC |
| Fan  Temp  Perf  Pwr:Usage/Cap|         Memory-Usage | GPU-Util  Compute M. |
|===============================+======================+======================|
|   0  NVIDIA GeForce RTX 4080   On | 00000000:01:00.0  On |                  N/A |
| 35%   58C    P2   210W / 320W |   8420MiB / 16376MiB |    74%      Default  |
+-------------------------------+----------------------+----------------------+`,
        type: 'output',
      });
    } else if (lower === 'clear') {
      setLogs([]);
      return;
    } else {
      newLogs.push({
        id: String(Date.now() + 1),
        text: `vortex-sh: command not found: "${trimmed}". Type "help" for syntax.`,
        type: 'error',
      });
    }

    setLogs(newLogs);
    onExecuteCommand(trimmed);
  };

  return (
    <div className="flex flex-col h-full bg-zinc-950 rounded-xl border border-cyan-500/30 overflow-hidden font-mono shadow-2xl">
      {/* Terminal Header Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/90 border-b border-cyan-500/20">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-red-500/80" />
          <div className="w-3 h-3 rounded-full bg-amber-500/80" />
          <div className="w-3 h-3 rounded-full bg-emerald-500/80" />
          <span className="ml-2 text-xs text-cyan-400 font-bold flex items-center gap-1.5">
            <Terminal className="w-3.5 h-3.5" />
            VORTEX_NEON_SH // PROXIFLY_ACTIVE
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-zinc-400">
          <span className="text-emerald-400 flex items-center gap-1">
            <Shield className="w-3 h-3" /> NO KYC
          </span>
          <span className="text-amber-400 flex items-center gap-1">
            <Zap className="w-3 h-3" /> $1/HR
          </span>
        </div>
      </div>

      {/* Terminal Output Stream */}
      <div className="flex-1 p-4 overflow-y-auto space-y-2 text-xs leading-relaxed max-h-[260px]">
        {logs.map((log) => (
          <div
            key={log.id}
            className={`${
              log.type === 'cmd'
                ? 'text-cyan-300 font-semibold'
                : log.type === 'system'
                ? 'text-emerald-400/90'
                : log.type === 'error'
                ? 'text-red-400 font-medium'
                : 'text-zinc-300 font-mono whitespace-pre-wrap'
            }`}
          >
            {log.text}
          </div>
        ))}
      </div>

      {/* Quick Action Chips */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900/60 border-t border-cyan-500/10 overflow-x-auto text-[11px]">
        <button
          onClick={() => {
            setInputCmd('status');
            handleSend();
          }}
          className="px-2 py-0.5 rounded bg-cyan-950/60 hover:bg-cyan-900/80 text-cyan-400 border border-cyan-500/30 transition-colors"
        >
          status
        </button>
        <button
          onClick={() => {
            setInputCmd('proxifly rotate');
            handleSend();
          }}
          className="px-2 py-0.5 rounded bg-emerald-950/60 hover:bg-emerald-900/80 text-emerald-400 border border-emerald-500/30 transition-colors"
        >
          proxifly rotate
        </button>
        <button
          onClick={() => {
            setInputCmd('gpu-info');
            handleSend();
          }}
          className="px-2 py-0.5 rounded bg-amber-950/60 hover:bg-amber-900/80 text-amber-400 border border-amber-500/30 transition-colors"
        >
          gpu-info
        </button>
        <button
          onClick={() => {
            setInputCmd('help');
            handleSend();
          }}
          className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
        >
          help
        </button>
      </div>

      {/* Command Input Prompt */}
      <form onSubmit={handleSend} className="flex items-center px-3 py-2 bg-zinc-950 border-t border-cyan-500/20">
        <span className="text-emerald-400 font-bold text-xs mr-2">{user.username}@node:~$</span>
        <input
          type="text"
          value={inputCmd}
          onChange={(e) => setInputCmd(e.target.value)}
          placeholder="type command..."
          className="flex-1 bg-transparent text-cyan-300 placeholder-zinc-600 outline-none text-xs font-mono"
        />
        <button type="submit" className="text-cyan-400 hover:text-cyan-200 transition-colors p-1">
          <Send className="w-3.5 h-3.5" />
        </button>
      </form>
    </div>
  );
};
