import React from 'react';
import {
  Users, Play, Loader2, CheckCircle2, XCircle,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { motion } from 'framer-motion';
import { LocalActiveMission, MISSION_TEMPLATES, phaseLabel, VIEW_TRANSITION } from './types';

export interface PipMissionsViewProps {
  activeMissions: LocalActiveMission[];
  activeMissionCount: number;
  missionGoal: string;
  missionTemplate: string;
  launchingMission: boolean;
  expandedMission: string | null;
  onGoalChange: (v: string) => void;
  onTemplateChange: (v: string) => void;
  onLaunch: () => void;
  onToggleExpand: (id: string | null) => void;
}

export const PipMissionsView: React.FC<PipMissionsViewProps> = ({
  activeMissions,
  activeMissionCount,
  missionGoal,
  missionTemplate,
  launchingMission,
  expandedMission,
  onGoalChange,
  onTemplateChange,
  onLaunch,
  onToggleExpand,
}) => {
  const tmpl = MISSION_TEMPLATES.find(t => t.id === missionTemplate) ?? MISSION_TEMPLATES[0]!;

  return (
    <motion.div
      key="missions"
      {...VIEW_TRANSITION}
      className="flex-1 flex flex-col p-3 gap-2 overflow-hidden"
    >
      {/* Mission Launcher */}
      <div className="cc-card cc-card-accent-purple px-3 py-2.5 space-y-2 shrink-0">
        <div className="flex items-center gap-2">
          <Users size={13} className={tmpl.iconCls} />
          <span className="text-[12px] font-bold text-white">Launch Mission</span>
        </div>
        <textarea
          value={missionGoal}
          onChange={(e) => onGoalChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onLaunch(); }}
          placeholder="Define the mission goal..."
          className="w-full bg-black/30 border border-white/[0.04] focus:border-white/[0.08] rounded-lg px-3 py-2 text-[11px] font-sans outline-none resize-none text-slate-300 placeholder:text-white/15 h-12 transition-colors"
        />
        <div className="flex items-center gap-2">
          <div className="flex gap-1 flex-1">
            {MISSION_TEMPLATES.map(t => (
              <button
                key={t.id}
                onClick={() => onTemplateChange(t.id)}
                className={cn(
                  'px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wider border transition-all',
                  missionTemplate === t.id ? t.activeCls : 'bg-white/[0.02] border-white/[0.04] text-slate-500 hover:text-white',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            onClick={onLaunch}
            disabled={!missionGoal.trim() || launchingMission}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 disabled:opacity-50 text-white text-[10px] font-bold rounded-full transition-all',
              tmpl.id === 'consultation' ? 'bg-jb-purple hover:bg-jb-purple/80' : 'bg-jb-accent hover:bg-jb-accent/80',
            )}
          >
            {launchingMission ? <Loader2 size={10} className="animate-spin" /> : <Play size={10} fill="currentColor" />}
            {launchingMission ? 'Launching...' : 'Launch'}
          </button>
        </div>
      </div>

      {/* Active Missions List */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        <div className="cc-section-heading mb-1.5 flex items-center gap-1.5 shrink-0">
          <div className={cn("w-1 h-1 rounded-full", activeMissionCount > 0 ? "bg-indigo-500 animate-pulse" : "bg-white/10")} />
          <span>Missions</span>
          <span className="text-white/20">({activeMissions.length})</span>
        </div>

        {activeMissions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center opacity-15 gap-2">
            <Users size={28} strokeWidth={1} />
            <span className="text-[10px] font-medium uppercase tracking-wider">Launch your first mission above</span>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto fluid-scrollbar space-y-1.5">
            {activeMissions.map((m) => (
              <div
                key={m.jobId}
                className={cn(
                  "cc-card overflow-hidden cursor-pointer",
                  m.status === 'complete' && 'cc-card-accent-emerald',
                  m.status === 'failed' && 'cc-card-accent-rose',
                  (m.status === 'active' || m.status === 'queued') && 'cc-card-accent-accent',
                )}
                onClick={() => onToggleExpand(expandedMission === m.jobId ? null : m.jobId)}
              >
                <div className="px-3 py-2.5 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] text-slate-300 font-medium line-clamp-1 flex-1">{m.goal}</p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className={cn(
                        "text-[9px] font-semibold uppercase tracking-wider",
                        m.status === 'complete' ? "text-emerald-400" :
                        m.status === 'failed' ? "text-rose-400" :
                        m.status === 'active' ? "text-indigo-400" :
                        "text-slate-500"
                      )}>{m.status}</span>
                      {(m.status === 'queued' || m.status === 'active') && (
                        <Loader2 size={9} className="animate-spin text-indigo-400" />
                      )}
                      {m.status === 'complete' && <CheckCircle2 size={9} className="text-emerald-400" />}
                      {m.status === 'failed' && <XCircle size={9} className="text-rose-400" />}
                    </div>
                  </div>

                  {(m.status === 'queued' || m.status === 'active') && (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[9px] font-medium uppercase tracking-wider text-slate-500">
                          {phaseLabel(m.progress, m.status)}
                        </span>
                        <span className="text-[9px] text-white/20 tabular-nums">{m.progress}%</span>
                      </div>
                      <div className="h-1 bg-white/[0.04] rounded-full overflow-hidden">
                        <motion.div
                          className="h-full rounded-full bg-gradient-to-r from-jb-purple to-jb-accent"
                          initial={{ width: 0 }}
                          animate={{ width: `${m.progress}%` }}
                          transition={{ duration: 0.5, ease: 'easeOut' }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {expandedMission === m.jobId && typeof m.result === 'object' && m.result !== null && 'expertOpinions' in m.result && (() => {
                  const resultData = m.result as { expertOpinions?: { role?: string; content?: string; name?: string; opinion?: string }[]; synthesis?: string };
                  return (
                    <div className="border-t border-white/[0.04] px-3 py-2.5 space-y-2">
                      {resultData.expertOpinions && (
                        <div className="space-y-1.5">
                          <span className="cc-section-heading block">Expert Analysis</span>
                          {resultData.expertOpinions.map((op, i: number) => {
                            const accents = ['cc-card-accent-purple', 'cc-card-accent-accent', 'cc-card-accent-amber'];
                            const colors  = ['text-jb-purple', 'text-jb-accent', 'text-jb-orange'];
                            return (
                              <div key={i} className={cn('cc-card px-2.5 py-2', accents[i % 3])}>
                                <span className={cn('text-[9px] font-semibold uppercase tracking-wider block mb-0.5', colors[i % 3])}>
                                  {op.role}
                                </span>
                                <p className="text-[10px] text-slate-400 leading-relaxed">{op.opinion}</p>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {resultData.synthesis && (
                        <div className="cc-card px-3 py-2.5">
                          <span className="cc-section-heading block mb-1">Synthesis</span>
                          <p className="text-[10px] text-slate-400 leading-relaxed">{resultData.synthesis}</p>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {expandedMission === m.jobId && m.error && (
                  <div className="border-t border-white/[0.04] px-3 py-2.5">
                    <p className="text-[10px] text-rose-400">{m.error}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
};
