import React, { useState } from 'react';
import {
  Maximize2,
  Minimize2,
  Terminal,
  Cpu,
  Activity,
  HardDrive,
  Monitor,
  Power,
  Sparkles,
  Bot,
  Settings,
  X,
  Volume2,
  Wifi,
  Globe,
  Lock,
  Layers,
  Zap,
  EyeOff,
  Eye,
  LineChart,
} from 'lucide-react';
import { VM } from '../types';

interface BrowserDesktopViewProps {
  vm: VM;
  onCloseDesktop: () => void;
  onPowerToggle: () => void;
}

export const BrowserDesktopView: React.FC<BrowserDesktopViewProps> = ({
  vm,
  onCloseDesktop,
  onPowerToggle,
}) => {
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [isZenMode, setIsZenMode] = useState(false);
  const [showMonitorModal, setShowMonitorModal] = useState(false);
  const [activeWindow, setActiveWindow] = useState<'comfyui' | 'ollama' | 'terminal' | 'settings' | 'none'>('comfyui');
  const [promptText, setPromptText] = useState('Cyberpunk neon hacker terminal with glowing RTX 4080 GPU core, 8k resolution, flux realistic style');
  const [generatedImages, setGeneratedImages] = useState<string[]>([]);
  const [generating, setGenerating] = useState(false);

  // Ollama local state
  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState<Array<{ sender: 'user' | 'ollama'; text: string }>>([
    { sender: 'ollama', text: 'Ollama v0.3.1 active on NVIDIA GeForce RTX 4080 Super (16GB VRAM). Model loaded: DeepSeek-R1-14B-Q4_K_M. Ask me anything.' },
  ]);

  const handleGenerateAiImage = () => {
    if (!promptText.trim()) return;
    setGenerating(true);
    setTimeout(() => {
      const newImg = `https://picsum.photos/seed/${encodeURIComponent(promptText + Date.now())}/800/600`;
      setGeneratedImages((prev) => [newImg, ...prev]);
      setGenerating(false);
    }, 1800);
  };

  const handleSendChatMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const userMsg = chatInput;
    setChatMessages((prev) => [...prev, { sender: 'user', text: userMsg }]);
    setChatInput('');

    setTimeout(() => {
      setChatMessages((prev) => [
        ...prev,
        {
          sender: 'ollama',
          text: `[DeepSeek-R1 on RTX 4080]: Processed prompt "${userMsg}" in 0.18s using CUDA acceleration. Token throughput: 84.2 t/s.`,
        },
      ]);
    }, 800);
  };

  return (
    <div className={`fixed inset-0 z-50 bg-black flex flex-col font-sans select-none overflow-hidden ${isFullScreen || isZenMode ? 'p-0' : 'p-2 md:p-4'}`}>
      {/* Outer Window Container */}
      <div className={`flex-1 flex flex-col bg-zinc-950 border overflow-hidden relative shadow-2xl ${
        isZenMode ? 'border-none rounded-none' : 'border-cyan-500/40 rounded-xl'
      }`}>
        
        {/* Low-Key Top Header (Hides in Zen mode or Fullscreen) */}
        {!isFullScreen && !isZenMode && (
          <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-cyan-500/20 text-xs font-mono">
            <div className="flex items-center gap-3">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping" />
              <span className="font-bold text-cyan-300">
                {vm.name} // IN-BROWSER STREAM ({vm.os.toUpperCase()})
              </span>
              <span className="text-zinc-500">|</span>
              <span className="text-amber-400 flex items-center gap-1">
                <Cpu className="w-3.5 h-3.5" /> {vm.gpuSpec} PASSTHROUGH
              </span>
              <span className="text-zinc-500">|</span>
              <span className="text-emerald-400 flex items-center gap-1">
                <Globe className="w-3.5 h-3.5" /> PROXIFLY: {vm.proxiflyIp} ({vm.proxiflyLocation})
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsZenMode(true)}
                className="px-2.5 py-1 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded text-[11px] transition-colors flex items-center gap-1 border border-amber-500/30 font-bold"
              >
                <EyeOff className="w-3.5 h-3.5" /> Pure Zen Mode
              </button>
              <button
                onClick={() => setIsFullScreen(true)}
                className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded text-[11px] transition-colors flex items-center gap-1"
              >
                <Maximize2 className="w-3.5 h-3.5" /> Fullscreen
              </button>
              <button
                onClick={onCloseDesktop}
                className="p-1 bg-red-600/30 hover:bg-red-600 text-red-300 hover:text-white rounded transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* ZEN MODE FLOATING STATS HUD (Shown in Zen Mode or toggleable) */}
        {isZenMode && (
          <div className="absolute top-3 right-3 z-50 flex items-center gap-3 bg-zinc-950/80 backdrop-blur-md border border-cyan-500/40 px-3 py-1.5 rounded-full text-[11px] font-mono text-zinc-200 shadow-2xl hover:bg-zinc-950 transition-all">
            <span className="flex items-center gap-1 text-emerald-400 font-bold">
              <Activity className="w-3.5 h-3.5 animate-pulse" /> 60 FPS
            </span>
            <span className="text-zinc-700">|</span>
            <span className="text-cyan-400 flex items-center gap-1">
              <Wifi className="w-3.5 h-3.5" /> {vm.stats.pingMs} ms
            </span>
            <span className="text-zinc-700">|</span>
            <span className="text-amber-400 flex items-center gap-1">
              <Cpu className="w-3.5 h-3.5" /> GPU {vm.stats.gpuLoad}%
            </span>
            <span className="text-zinc-700">|</span>
            <button
              onClick={() => setShowMonitorModal(true)}
              className="text-purple-300 hover:text-white underline flex items-center gap-1"
            >
              <LineChart className="w-3.5 h-3.5" /> Stats
            </button>
            <span className="text-zinc-700">|</span>
            <button
              onClick={() => setIsZenMode(false)}
              className="px-2 py-0.5 bg-amber-500/20 hover:bg-amber-500/40 text-amber-300 rounded-full text-[10px] font-bold border border-amber-500/40 transition-colors"
            >
              Exit Zen Mode
            </button>
          </div>
        )}

        {/* Remote Desktop Canvas Viewport */}
        <div className="flex-1 bg-zinc-900/90 relative overflow-hidden flex flex-col items-center justify-center">
          
          {/* Desktop Wallpaper / Grid Background */}
          <div className="absolute inset-0 bg-[radial-gradient(#152e3c_1px,transparent_1px)] [background-size:24px_24px] opacity-40 pointer-events-none" />
          
          {/* Floating Application Windows inside Desktop Stream */}
          
          {/* 1. ComfyUI AI Image Generation Suite */}
          {activeWindow === 'comfyui' && (
            <div className="w-full max-w-3xl bg-zinc-950/95 border border-purple-500/40 rounded-xl shadow-2xl p-5 font-mono z-20 space-y-4 my-auto">
              <div className="flex justify-between items-center border-b border-purple-500/20 pb-3">
                <div className="flex items-center gap-2 text-purple-400 font-bold text-sm">
                  <Sparkles className="w-4 h-4" /> ComfyUI + Stable Diffusion Flux (RTX 4080 Hardware Accel)
                </div>
                <button
                  onClick={() => setActiveWindow('none')}
                  className="text-zinc-500 hover:text-white"
                >
                  &times;
                </button>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">PROMPT NODE (FLUX.1 / SDXL):</label>
                <textarea
                  value={promptText}
                  onChange={(e) => setPromptText(e.target.value)}
                  rows={2}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-cyan-300 outline-none focus:border-purple-500 font-mono"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="text-[11px] text-zinc-400">
                  GPU VRAM: <span className="text-emerald-400">8.4 / 16 GB</span> | Sampler: <span className="text-purple-300">Euler A (25 Steps)</span>
                </div>
                <button
                  onClick={handleGenerateAiImage}
                  disabled={generating}
                  className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold rounded-lg text-xs flex items-center gap-2 shadow-lg shadow-purple-600/30 transition-all"
                >
                  {generating ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      CUDA SAMPLING...
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4" /> QUEUE PROMPT (GPU RUN)
                    </>
                  )}
                </button>
              </div>

              {/* Generated Images Output Stream */}
              {generatedImages.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 pt-3 border-t border-zinc-800">
                  {generatedImages.map((imgUrl, i) => (
                    <div key={i} className="aspect-video bg-black rounded-lg overflow-hidden border border-purple-500/30 group relative">
                      <img src={imgUrl} alt="AI Gen" className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-[10px] text-purple-300 font-bold p-2 text-center">
                        Generated in 1.4s on RTX 4080 Super
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 2. Ollama LLM Terminal App */}
          {activeWindow === 'ollama' && (
            <div className="w-full max-w-2xl bg-zinc-950/95 border border-emerald-500/40 rounded-xl shadow-2xl p-5 font-mono z-20 space-y-4 my-auto">
              <div className="flex justify-between items-center border-b border-emerald-500/20 pb-3">
                <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                  <Bot className="w-4 h-4" /> Ollama Local AI Chat (DeepSeek-R1 14B on GPU)
                </div>
                <button onClick={() => setActiveWindow('none')} className="text-zinc-500 hover:text-white">&times;</button>
              </div>

              <div className="h-64 overflow-y-auto space-y-3 p-3 bg-zinc-900/80 rounded-lg border border-zinc-800 text-xs">
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`p-2.5 rounded-lg ${msg.sender === 'user' ? 'bg-cyan-950/80 text-cyan-200 text-right ml-12' : 'bg-emerald-950/80 text-emerald-200 mr-12'}`}>
                    <div className="text-[10px] text-zinc-500 mb-0.5">{msg.sender === 'user' ? 'You' : 'Ollama DeepSeek-R1'}</div>
                    {msg.text}
                  </div>
                ))}
              </div>

              <form onSubmit={handleSendChatMessage} className="flex gap-2">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Ask local model anything..."
                  className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-emerald-500"
                />
                <button type="submit" className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-black font-bold rounded-lg text-xs">
                  SEND
                </button>
              </form>
            </div>
          )}

          {/* 3. Simulated Terminal App */}
          {activeWindow === 'terminal' && (
            <div className="w-full max-w-xl bg-black border border-cyan-500/40 rounded-xl shadow-2xl p-4 font-mono z-20 text-xs space-y-3 my-auto">
              <div className="flex justify-between text-cyan-400 border-b border-zinc-800 pb-2">
                <span>remote-shell@vortex-gpu-vm:~$</span>
                <button onClick={() => setActiveWindow('none')} className="text-zinc-500 hover:text-white">&times;</button>
              </div>
              <div className="space-y-1 text-zinc-300">
                <div className="text-emerald-400">Linux 6.8.0-40-generic x86_64</div>
                <div>System uptime: {Math.floor(vm.uptimeSeconds / 60)} minutes</div>
                <div>GPU Device: {vm.gpuSpec}</div>
                <div>Proxifly Outbound IP: <span className="text-cyan-400">{vm.proxiflyIp}</span></div>
                <div>Auto-power off status: Active (Triggers if idle for 10 min)</div>
              </div>
            </div>
          )}

        </div>

        {/* LOW-KEY MINIMALIST TOOLBAR AT BOTTOM (Hides in Zen mode unless hovered) */}
        {!isZenMode && (
          <div className="px-4 py-2 bg-zinc-950/95 border-t border-cyan-500/30 backdrop-blur-md flex items-center justify-between font-mono text-xs z-30">
            
            {/* App Launcher Shortcuts */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setActiveWindow('comfyui')}
                className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold flex items-center gap-1.5 transition-all ${
                  activeWindow === 'comfyui'
                    ? 'bg-purple-600/30 border-purple-500 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.3)]'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 text-purple-400" /> ComfyUI AI
              </button>

              <button
                onClick={() => setActiveWindow('ollama')}
                className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold flex items-center gap-1.5 transition-all ${
                  activeWindow === 'ollama'
                    ? 'bg-emerald-600/30 border-emerald-500 text-emerald-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                <Bot className="w-3.5 h-3.5 text-emerald-400" /> Ollama LLM
              </button>

              <button
                onClick={() => setActiveWindow('terminal')}
                className={`px-3 py-1.5 rounded-lg border text-[11px] font-bold flex items-center gap-1.5 transition-all ${
                  activeWindow === 'terminal'
                    ? 'bg-cyan-600/30 border-cyan-500 text-cyan-300'
                    : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
                }`}
              >
                <Terminal className="w-3.5 h-3.5 text-cyan-400" /> Terminal
              </button>
            </div>

            {/* Real-time Telemetry Widget */}
            <div
              onClick={() => setShowMonitorModal(true)}
              className="hidden md:flex items-center gap-4 text-[11px] bg-zinc-900/80 hover:bg-zinc-900 px-3 py-1 rounded-lg border border-zinc-800 cursor-pointer transition-colors"
            >
              <span className="flex items-center gap-1 text-emerald-400 font-bold">
                <Activity className="w-3.5 h-3.5" /> 60 FPS
              </span>
              <span className="text-zinc-600">|</span>
              <span className="flex items-center gap-1 text-cyan-400">
                <Wifi className="w-3.5 h-3.5" /> {vm.stats.pingMs} ms
              </span>
              <span className="text-zinc-600">|</span>
              <span className="flex items-center gap-1 text-amber-400">
                <Cpu className="w-3.5 h-3.5" /> GPU: {vm.stats.gpuLoad}% ({vm.stats.tempC}°C)
              </span>
              <span className="text-zinc-600">|</span>
              <span className="flex items-center gap-1 text-purple-400">
                <Globe className="w-3.5 h-3.5" /> IP: {vm.proxiflyIp}
              </span>
            </div>

            {/* Quick Exit / Fullscreen / Zen Toggle */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsZenMode(true)}
                className="px-2.5 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 rounded-lg border border-amber-500/40 text-[11px] font-bold flex items-center gap-1"
                title="Hide All UI & Show Pure Desktop"
              >
                <EyeOff className="w-3.5 h-3.5" /> Pure Zen
              </button>
              <button
                onClick={() => setIsFullScreen(!isFullScreen)}
                className="p-1.5 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 rounded-lg border border-zinc-800"
                title="Toggle Fullscreen"
              >
                {isFullScreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>
              <button
                onClick={onCloseDesktop}
                className="px-3 py-1.5 bg-red-600/20 hover:bg-red-600 text-red-300 hover:text-white border border-red-500/40 rounded-lg text-[11px] font-bold transition-all"
              >
                DISCONNECT
              </button>
            </div>
          </div>
        )}
      </div>

      {/* DETAILED MONITORING METRICS MODAL */}
      {showMonitorModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 font-mono">
          <div className="w-full max-w-xl bg-zinc-950 border border-cyan-500/40 rounded-2xl p-6 space-y-4 shadow-2xl">
            <div className="flex justify-between items-center border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2 text-cyan-300 font-bold text-sm">
                <LineChart className="w-5 h-5 text-emerald-400" /> REAL-TIME VM & NETWORK MONITORING
              </div>
              <button onClick={() => setShowMonitorModal(false)} className="text-zinc-500 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800 space-y-1">
                <div className="text-zinc-400">GPU Core Clock:</div>
                <div className="text-base font-bold text-amber-300">2,610 MHz</div>
              </div>
              <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800 space-y-1">
                <div className="text-zinc-400">GPU Power Draw:</div>
                <div className="text-base font-bold text-emerald-400">195 Watts (320W Limit)</div>
              </div>
              <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800 space-y-1">
                <div className="text-zinc-400">VRAM Usage:</div>
                <div className="text-base font-bold text-purple-300">{vm.stats.vramUsedGb} / 16.0 GB GDDR6X</div>
              </div>
              <div className="p-3 bg-zinc-900 rounded-xl border border-zinc-800 space-y-1">
                <div className="text-zinc-400">Proxifly Outbound Tunnel:</div>
                <div className="text-base font-bold text-cyan-300">{vm.proxiflyIp}</div>
              </div>
            </div>

            <div className="space-y-2 pt-2 border-t border-zinc-800 text-xs">
              <div className="text-zinc-400 font-bold">NETWORK THROUGHPUT GRAPH (LIVE WEBRTC STREAM):</div>
              <div className="h-16 bg-zinc-900 rounded-xl border border-zinc-800 p-2 flex items-end justify-between gap-1">
                {[40, 65, 50, 80, 95, 70, 85, 90, 60, 75, 88, 92, 70, 85, 98, 90].map((val, idx) => (
                  <div
                    key={idx}
                    className="flex-1 bg-cyan-500/60 hover:bg-cyan-400 rounded-t transition-all"
                    style={{ height: `${val}%` }}
                  />
                ))}
              </div>
              <div className="flex justify-between text-[10px] text-zinc-500">
                <span>Inbound Stream: 48 Mbps</span>
                <span>Latency Jitter: &lt; 2 ms</span>
                <span>Enc: H.264 / AV1 HW</span>
              </div>
            </div>

            <button
              onClick={() => setShowMonitorModal(false)}
              className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-bold text-xs rounded-xl transition-colors"
            >
              Close Telemetry Window
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
