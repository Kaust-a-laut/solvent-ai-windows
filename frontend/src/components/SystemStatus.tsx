import React, { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { socket } from '../lib/socket';
import { cn } from '../lib/utils';

export const SystemStatus = ({ collapsed = false }: { collapsed?: boolean }) => {
  const { isProcessingByMode, currentMode } = useAppStore();
  const isProcessing = isProcessingByMode[currentMode] ?? false;
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

  // Status pip colors: green = healthy, amber = idle/waiting, red = offline/error.
  const linkPip = isSocketConnected
    ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]'
    : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)] animate-pulse';
  const lpuPip = isProcessing
    ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.7)]'
    : 'bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.6)]';
  const memoryPip = 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.6)]';

  const linkValueColor = isSocketConnected ? 'text-emerald-300' : 'text-rose-300';
  const lpuValueColor = isProcessing ? 'text-emerald-300' : 'text-amber-300';

  // Collapsed layout: three pips with hover tooltips.
  if (collapsed) {
    return (
      <div className="flex items-center gap-2.5 justify-center px-0 py-3 rounded-xl transition-all">
        <div className="relative group flex items-center justify-center">
          <div className={cn('w-2 h-2 rounded-full', linkPip)} />
          <div className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[11px] font-bold text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            Link: {isSocketConnected ? 'Online' : 'Offline'}
          </div>
        </div>

        <div className="relative group flex items-center justify-center">
          <div className={cn('w-2 h-2 rounded-full', lpuPip)} />
          <div className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[11px] font-bold text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            LPU: {isProcessing ? 'Thinking' : 'Idle'}
          </div>
        </div>

        <div className="relative group flex items-center justify-center">
          <div className={cn('w-2 h-2 rounded-full', memoryPip)} />
          <div className="absolute left-full ml-4 px-2 py-1 bg-black border border-white/10 rounded text-[11px] font-bold text-white whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
            Memory: Active
          </div>
        </div>
      </div>
    );
  }

  // Expanded layout: each pip gets an inline label and color-coded value.
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2.5 rounded-xl bg-white/[0.04] border border-white/[0.12]">
      <div className="flex items-center gap-2.5">
        <div className={cn('w-2 h-2 rounded-full shrink-0', linkPip)} />
        <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider flex-1">Link</span>
        <span className={cn('text-[10px] font-bold uppercase tracking-wider', linkValueColor)}>{isSocketConnected ? 'Online' : 'Offline'}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <div className={cn('w-2 h-2 rounded-full shrink-0', lpuPip)} />
        <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider flex-1">LPU</span>
        <span className={cn('text-[10px] font-bold uppercase tracking-wider', lpuValueColor)}>{isProcessing ? 'Thinking' : 'Idle'}</span>
      </div>
      <div className="flex items-center gap-2.5">
        <div className={cn('w-2 h-2 rounded-full shrink-0', memoryPip)} />
        <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider flex-1">Memory</span>
        <span className="text-[10px] font-bold text-emerald-300 uppercase tracking-wider">Active</span>
      </div>
    </div>
  );
};
