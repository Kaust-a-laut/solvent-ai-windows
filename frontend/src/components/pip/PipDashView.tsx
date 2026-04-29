import React from 'react';
import {
  Shield, Database, Loader2, FlaskConical, Activity,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { motion } from 'framer-motion';
import { ActivityEvent } from '../../store/types';
import { LocalOverseerDecision, formatRelativeTime, VIEW_TRANSITION } from './types';
import { PipView } from './PipTabBar';
import type { TraceHealth } from '../../lib/api-client';

type WaterfallState = {
  prompt: string;
  currentStep: 'planner' | 'executor' | 'reviewer' | null;
  steps: {
    planner: { status: string; data?: Record<string, unknown> | null; error?: string | null };
    executor: { status: string; data?: Record<string, unknown> | null; error?: string | null };
    reviewer: { status: string; data?: Record<string, unknown> | null; error?: string | null };
  };
};

export interface PipDashViewProps {
  waterfall: WaterfallState;
  waterfallAbortController: unknown;
  activities: ActivityEvent[];
  supervisorInsight: string | null;
  overseerDecisions: LocalOverseerDecision[];
  isThinking: boolean;
  onOpenView: (v: PipView) => void;
  onTriggerOverseer: (focus?: string) => void;
  globalProvider: string;
  thinkingModeEnabled: boolean;
  activeMissionCount: number;
  traceHealth: TraceHealth | null;
}

const ACTIVITY_COLORS: Record<string, string> = {
  user_message: 'bg-jb-accent/60',
  ai_code_update: 'bg-emerald-400/60',
  waterfall: 'bg-jb-purple/60',
  command: 'bg-jb-orange/60',
};

export const PipDashView: React.FC<PipDashViewProps> = ({
  waterfall,
  waterfallAbortController,
  activities,
  supervisorInsight,
  overseerDecisions,
  isThinking,
  onOpenView,
  onTriggerOverseer,
  globalProvider,
  thinkingModeEnabled,
  activeMissionCount,
  traceHealth,
}) => {
  const STAGE_ORDER = ['planner', 'executor', 'reviewer'] as const;
  const pipelineIdle = !waterfall.currentStep && waterfall.steps.planner.status === 'idle';
  const pipelineComplete = STAGE_ORDER.every((s) => waterfall.steps[s].status === 'completed');
  const reviewerScore = (waterfall.steps.reviewer.data as { score?: number } | null)?.score;
  const currentStage = waterfall.currentStep;

  void waterfallAbortController;

  return (
    <motion.div
      key="dash"
      {...VIEW_TRANSITION}
      className="flex-1 flex flex-col gap-2 p-3 overflow-y-auto fluid-scrollbar min-h-0"
    >
      {/* Status Strip */}
      <div className="flex items-center gap-3 px-1 py-1 shrink-0">
        <div className="flex items-center gap-1.5">
          <div className={cn("w-1.5 h-1.5 rounded-full",
            globalProvider === 'cloud' ? "bg-jb-accent" :
            globalProvider === 'local' ? "bg-emerald-400" : "bg-jb-purple"
          )} />
          <span className="text-[9px] font-medium uppercase tracking-wider text-white/30">{globalProvider}</span>
        </div>
        {thinkingModeEnabled && (
          <span className="text-[9px] font-medium text-jb-purple/50">Deep Think</span>
        )}
        {activeMissionCount > 0 && (
          <span className="text-[9px] font-medium text-indigo-400/60">
            {activeMissionCount} mission{activeMissionCount > 1 ? 's' : ''}
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <div className="w-1 h-1 rounded-full bg-emerald-500/60 animate-pulse" />
          <span className="text-[9px] text-white/20">Live</span>
        </div>
      </div>

      {/* Overseer Card */}
      <div
        onClick={() => onOpenView('overseer')}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && onOpenView('overseer')}
        className="group cc-card cc-card-accent-emerald px-3 py-2.5 cursor-pointer shrink-0 overflow-hidden relative"
      >
        <div className="absolute -top-6 -left-6 w-20 h-20 rounded-full bg-emerald-500/[0.03] blur-2xl pointer-events-none" />
        <div className="flex items-center justify-between gap-2 relative">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Shield size={14} className="text-emerald-400/70 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-bold text-white">Overseer</span>
                {isThinking && <Loader2 size={9} className="animate-spin text-emerald-400" />}
                {overseerDecisions.length > 0 && (
                  <span className="text-[9px] font-semibold text-emerald-400/60">{overseerDecisions.length}</span>
                )}
              </div>
              <p className="text-[10px] text-slate-500 line-clamp-1 mt-0.5">
                {supervisorInsight || 'Monitoring session'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => onTriggerOverseer('manual_check')}
              disabled={isThinking}
              className="px-2 py-1 rounded-md text-[9px] font-semibold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all disabled:opacity-40"
            >
              {isThinking ? '...' : 'Think'}
            </button>
            <button
              onClick={() => onTriggerOverseer('nudge_me')}
              disabled={isThinking}
              className="px-2 py-1 rounded-md text-[9px] font-semibold uppercase tracking-wider bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-all disabled:opacity-40"
            >
              Nudge
            </button>
          </div>
        </div>
      </div>

      {/* Pipeline Status Card */}
      {!pipelineIdle && (
        <div
          role="button"
          tabIndex={0}
          onClick={() => onOpenView('waterfall')}
          onKeyDown={e => e.key === 'Enter' && onOpenView('waterfall')}
          className="group cc-card cc-card-accent-purple px-3 py-2.5 cursor-pointer shrink-0 overflow-hidden relative"
        >
          <div className="absolute -top-6 -left-6 w-20 h-20 rounded-full bg-jb-purple/[0.03] blur-2xl pointer-events-none" />
          <div className="flex items-center gap-2 relative">
            <FlaskConical size={14} className="text-jb-purple/70 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[12px] font-bold text-white">Pipeline</span>
                {pipelineComplete && reviewerScore != null && (
                  <span className={cn(
                    'px-1.5 py-0.5 rounded-full text-[9px] font-semibold tabular-nums',
                    reviewerScore >= 90 ? 'bg-emerald-500/15 text-emerald-400' :
                    reviewerScore >= 80 ? 'bg-sky-500/15 text-sky-400' :
                    reviewerScore >= 70 ? 'bg-amber-500/15 text-amber-400' :
                    'bg-rose-500/15 text-rose-400',
                  )}>
                    {reviewerScore}/100
                  </span>
                )}
                {!pipelineComplete && currentStage && (
                  <Loader2 size={9} className="animate-spin text-jb-purple" />
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {STAGE_ORDER.map((s) => {
                const st = waterfall.steps[s].status;
                return (
                  <div
                    key={s}
                    className={cn(
                      'w-2 h-2 rounded-full transition-all',
                      st === 'completed' ? 'bg-emerald-400' :
                      st === 'processing' ? 'bg-jb-accent animate-pulse' :
                      st === 'error' ? 'bg-rose-400' :
                      st === 'paused' ? 'bg-amber-400' :
                      'bg-white/10',
                    )}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Retrieval Health Card */}
      {traceHealth && traceHealth.traceCount > 0 && (() => {
        const budgetPct = traceHealth.avgBudgetUtilization * 100;
        const corrPct = traceHealth.correctionRate * 100;
        const budgetColor = budgetPct >= 95 ? 'bg-rose-500' : budgetPct >= 85 ? 'bg-amber-500' : 'bg-emerald-500';
        const corrColor = corrPct > 15 ? 'text-rose-400 bg-rose-500/15' : corrPct > 0 ? 'text-amber-400 bg-amber-500/15' : 'text-emerald-400 bg-emerald-500/15';
        return (
          <div
            role="button"
            tabIndex={0}
            onClick={() => onOpenView('intel')}
            onKeyDown={e => e.key === 'Enter' && onOpenView('intel')}
            className="group cc-card cc-card-accent-cyan px-3 py-2 cursor-pointer shrink-0 overflow-hidden relative"
          >
            <div className="flex items-center gap-2.5">
              <Activity size={13} className="text-cyan-400/70 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-bold text-white">Retrieval</span>
                    <span className="text-[9px] text-slate-600 font-mono">{traceHealth.traceCount} traces</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className={cn('text-[9px] font-semibold px-1.5 py-0.5 rounded-full', corrColor)}>
                      {corrPct > 0 ? `${corrPct.toFixed(0)}% corr` : 'clean'}
                    </span>
                    <span className="text-[9px] text-slate-600 font-mono">{traceHealth.avgPipelineMs}ms</span>
                  </div>
                </div>
                <div className="h-1 w-full bg-white/5 rounded-full overflow-hidden">
                  <div className={cn('h-full rounded-full transition-all', budgetColor)} style={{ width: `${Math.min(budgetPct, 100)}%` }} />
                </div>
                <div className="flex justify-between mt-0.5">
                  <span className="text-[8px] text-slate-600">Budget</span>
                  <span className={cn('text-[8px] font-mono', budgetPct >= 95 ? 'text-rose-400' : budgetPct >= 85 ? 'text-amber-400' : 'text-slate-500')}>
                    {budgetPct.toFixed(0)}%
                  </span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Activity Feed */}
      <div className="flex-1 bg-black/30 rounded-xl border border-white/[0.03] p-3 flex flex-col overflow-hidden min-h-0">
        <div className="cc-section-heading mb-2 flex items-center gap-1.5 shrink-0">
          <div className="w-1 h-1 rounded-full bg-emerald-500/60 animate-pulse" />
          <span>Recent Activity</span>
        </div>
        <div className="flex-1 overflow-y-auto fluid-scrollbar min-h-0">
          {activities.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center opacity-15 gap-2">
              <Database size={24} strokeWidth={1} />
              <span className="text-[10px] font-medium uppercase tracking-wider">No activity yet</span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {activities.slice(0, 20).map((act, i: number) => (
                <div key={i} className="flex gap-2.5 py-1.5 group/item">
                  <div className={cn(
                    "w-1.5 h-1.5 rounded-full mt-1.5 shrink-0",
                    ACTIVITY_COLORS[act.type] || 'bg-white/20'
                  )} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-[10px] font-medium text-slate-400 line-clamp-1">
                        {act.content || (act.detail as string) || (act.path as string) || act.message || String(act.type || '').replace('_', ' ')}
                      </span>
                      {act.timestamp && (
                        <span className="text-[9px] text-white/15 shrink-0 tabular-nums">
                          {formatRelativeTime(act.timestamp)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};
