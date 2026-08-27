import React from 'react';
import {
  Cpu,
  Clock,
  Bitcoin,
  Shield,
  UserCheck,
  Globe,
  Zap,
  Terminal,
  Activity,
  LogOut,
} from 'lucide-react';
import { UserSession } from '../types';

interface NavbarProps {
  user: UserSession;
  onOpenBtcPay: () => void;
  onLogout: () => void;
  vmState: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  user,
  onOpenBtcPay,
  onLogout,
  vmState,
}) => {
  const hours = Math.floor(user.balanceMinutes / 60);
  const mins = user.balanceMinutes % 60;

  return (
    <header className="sticky top-0 z-40 bg-zinc-950/90 border-b border-cyan-500/30 backdrop-blur-md px-4 py-3 font-mono text-xs">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
        
        {/* Brand & GPU Badge */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-black font-extrabold shadow-lg shadow-cyan-500/30">
            <Cpu className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-black tracking-wider text-white">
                VORTEX<span className="text-cyan-400">_GPU</span>
              </h1>
              <span className="text-[10px] bg-cyan-950 text-cyan-300 px-2 py-0.5 rounded border border-cyan-500/30 font-bold">
                RTX 4080 / 4070
              </span>
            </div>
            <div className="text-[10px] text-zinc-400 flex items-center gap-2">
              <span className="text-emerald-400 flex items-center gap-0.5">
                <Shield className="w-3 h-3" /> NO KYC
              </span>
              <span>•</span>
              <span className="text-amber-400 flex items-center gap-0.5">
                <Globe className="w-3 h-3" /> PROXIFLY BACKEND
              </span>
            </div>
          </div>
        </div>

        {/* Center Live Balance Counter ($1/hr) */}
        <div className="flex items-center gap-3 bg-zinc-900/90 px-4 py-2 rounded-xl border border-amber-500/30 shadow-inner">
          <Clock className="w-4 h-4 text-amber-400 animate-pulse" />
          <div>
            <div className="text-[10px] text-zinc-400 uppercase tracking-widest">Time Remaining ($1/hr):</div>
            <div className="text-sm font-bold text-amber-300">
              {String(hours).padStart(2, '0')}h {String(mins).padStart(2, '0')}m
            </div>
          </div>

          <button
            onClick={onOpenBtcPay}
            className="ml-2 px-3 py-1.5 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold rounded-lg text-[11px] flex items-center gap-1 shadow-md shadow-amber-500/20 transition-all"
          >
            <Bitcoin className="w-3.5 h-3.5" /> + TOP UP
          </button>
        </div>

        {/* User Identity */}
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-cyan-300 font-bold flex items-center gap-1 justify-end">
              <UserCheck className="w-3.5 h-3.5" /> @{user.username}
            </div>
            <div className="text-[10px] text-zinc-500">
              Anonymous Client
            </div>
          </div>

          <button
            onClick={onLogout}
            className="p-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white rounded-xl border border-zinc-800 transition-colors"
            title="Sign Out / Reset Session"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
