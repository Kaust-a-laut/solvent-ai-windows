import React, { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { socket } from '../lib/socket';
import { cn } from '../lib/utils';

export const SystemStatus = ({ collapsed = false }: { collapsed?: boolean }) => {
  const { isProcessing } = useAppStore();
  const [isSocketConnected, setIsSocketConnected] = useState(socket.connected);

  useEffect(() => {
    const handleConnect = () => setIsSocketConnected(true);
    const handleDisconnect = () => setIsSocketConnected(false);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
    };
  }, []);

  // Collapsed layout: three dots in a row with hover tooltips (unchanged)
  if (collapsed) {
    return (
      <div className="flex items-center gap-2 justify-center px-0 py-3 rounded-xl transition-all">
        <div className="relative group flex items-center justify-center">
          <div className={cn(
            "w-1.5 h-1.5 rounded-full",
            isSocketConnected ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" : "bg-rose-500 animate-pulse"
          )} />
          <div className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[11px] font-bold text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            Link: {isSocketConnected ? 'Online' : 'Offline'}
          </div>
        </div>

        <div className="relative group flex items-center justify-center">
          <div className={cn(
            "w-1.5 h-1.5 rounded-full",
            isProcessing ? "bg-jb-accent animate-pulse shadow-[0_0_8px_rgba(60,113,247,0.6)]" : "bg-slate-700"
          )} />
          <div className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[11px] font-bold text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            LPU: {isProcessing ? 'Thinking' : 'Idle'}
          </div>
        </div>

        <div className="relative group flex items-center justify-center">
          <div className="w-1.5 h-1.5 rounded-full bg-jb-purple/40 border border-jb-purple/20" />
          <div className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[11px] font-bold text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            Memory: Active
          </div>
        </div>
      </div>
    );
  }

  // Expanded layout: each dot gets an inline label so the meaning is readable at a glance.
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-xl bg-white/[0.02] border border-white/5">
      <div className="flex items-center gap-2">
        <div className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          isSocketConnected ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]" : "bg-rose-500 animate-pulse"
        )} />
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex-1">Link</span>
        <span className="text-[10px] text-white/40">{isSocketConnected ? 'Online' : 'Offline'}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className={cn(
          "w-1.5 h-1.5 rounded-full shrink-0",
          isProcessing ? "bg-jb-accent animate-pulse shadow-[0_0_6px_rgba(60,113,247,0.5)]" : "bg-slate-700"
        )} />
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex-1">LPU</span>
        <span className="text-[10px] text-white/40">{isProcessing ? 'Thinking' : 'Idle'}</span>
      </div>
      <div className="flex items-center gap-2">
        <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-jb-purple/50 border border-jb-purple/30" />
        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider flex-1">Memory</span>
        <span className="text-[10px] text-white/40">Active</span>
      </div>
    </div>
  );
};
