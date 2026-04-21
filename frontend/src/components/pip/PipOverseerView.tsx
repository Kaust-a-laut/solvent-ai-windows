import React from 'react';
import { Shield, Loader2, Trash2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { motion } from 'framer-motion';
import { PipChatWidget } from './PipChatWidget';
import { LocalOverseerDecision, formatRelativeTime, VIEW_TRANSITION } from './types';

const INTERVENTION_BORDER: Record<string, string> = {
  warning: 'cc-card-accent-amber',
  suggestion: 'cc-card-accent-accent',
  action: 'cc-card-accent-emerald',
};

export interface PipOverseerViewProps {
  decisions: LocalOverseerDecision[];
  isThinking: boolean;
  supervisorInsight: string | null;
  onTrigger: (focus?: string) => void;
  onClearDecisions: () => void;
}

export const PipOverseerView: React.FC<PipOverseerViewProps> = ({
  decisions,
  isThinking,
  supervisorInsight,
  onTrigger,
  onClearDecisions,
}) => (
  <motion.div
    key="overseer"
    {...VIEW_TRANSITION}
    className="flex-1 flex flex-col p-3 gap-2 overflow-hidden"
  >
    {/* Supervisor Insight Banner */}
    <div className="cc-card cc-card-accent-emerald px-3 py-2.5 relative overflow-hidden shrink-0">
      <div className="absolute -top-6 -left-6 w-20 h-20 bg-emerald-500/[0.03] blur-2xl rounded-full pointer-events-none" />
      <div className="flex items-center justify-between relative">
        <div className="flex items-center gap-2">
          <Shield size={13} className="text-emerald-400/70" />
          <span className="text-[12px] font-bold text-white">Overseer</span>
          {isThinking && <Loader2 size={9} className="animate-spin text-emerald-400" />}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onTrigger('manual_check')}
            disabled={isThinking}
            className="px-2 py-1 rounded-md text-[9px] font-semibold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all disabled:opacity-40"
          >
            {isThinking ? '...' : 'Think'}
          </button>
          <button
            onClick={() => onTrigger('nudge_me')}
            disabled={isThinking}
            className="px-2 py-1 rounded-md text-[9px] font-semibold uppercase tracking-wider bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-all disabled:opacity-40"
          >
            Nudge
          </button>
          <button
            onClick={onClearDecisions}
            className="p-1 rounded-md text-slate-500 hover:text-rose-400 transition-all"
          >
            <Trash2 size={10} />
          </button>
        </div>
      </div>
      <p className="text-[10px] text-slate-400 leading-relaxed mt-1.5 relative">
        {supervisorInsight || "Watching your session. Hit Think for a proactive insight, or Nudge for guidance."}
      </p>
    </div>

    {/* Decisions Feed */}
    <div className="flex-[1] flex flex-col overflow-hidden min-h-0">
      <div className="cc-section-heading mb-1.5 flex items-center gap-1.5 shrink-0">
        <div className="w-1 h-1 rounded-full bg-emerald-500/50 animate-pulse" />
        <span>Decision Feed</span>
        <span className="text-white/20">({decisions.length})</span>
      </div>

      {decisions.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center opacity-15 gap-2">
          <Shield size={28} strokeWidth={1} />
          <span className="text-[10px] font-medium uppercase tracking-wider">No decisions yet</span>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto fluid-scrollbar space-y-1.5">
          {decisions.map((d) => {
            const intType = d.intervention?.type || 'suggestion';
            return (
              <div key={d.id} className={cn(
                "cc-card px-3 py-2.5 space-y-1.5",
                d.intervention?.needed && INTERVENTION_BORDER[intType]
              )}>
                <div className="flex items-center justify-between gap-2">
                  {d.intervention?.needed && (
                    <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">
                      {intType}
                    </span>
                  )}
                  <span className="text-[9px] text-white/20 font-mono ml-auto tabular-nums">
                    {formatRelativeTime(d.timestamp)}
                  </span>
                </div>
                <p className="text-[10px] text-slate-300 leading-relaxed line-clamp-4">
                  {d.decision}
                </p>
                {d.intervention?.message && d.intervention.message !== d.decision && (
                  <p className="text-[10px] text-slate-400 leading-relaxed border-t border-white/[0.04] pt-1.5">
                    {d.intervention.message}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>

    {/* Chat with Overseer */}
    <div className="border-t border-white/[0.04] shrink-0 h-[180px]">
      <PipChatWidget />
    </div>
  </motion.div>
);
