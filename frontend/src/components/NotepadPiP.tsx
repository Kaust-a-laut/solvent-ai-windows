import React, { useEffect, useState, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
  X, ExternalLink,
  Settings, Brain, Sparkles,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { motion, AnimatePresence } from 'framer-motion';
import { fetchWithRetry, getTraceHealth, type TraceHealth } from '../lib/api-client';
import { API_BASE_URL } from '../lib/config';
import { socket } from '../lib/socket';

import { LocalOverseerDecision, LocalActiveMission } from './pip/types';
import { PipTabBar, PipView } from './pip/PipTabBar';
import { PipDashView } from './pip/PipDashView';
import { PipNotesView } from './pip/PipNotesView';
import { PipOverseerView } from './pip/PipOverseerView';
import { PipMissionsView } from './pip/PipMissionsView';
import { PipWaterfallView } from './pip/PipWaterfallView';
import { PipCodeView } from './pip/PipCodeView';
import { PipIntelView } from './pip/PipIntelView';

const VIEW_LABELS: Record<PipView, string> = {
  dash: 'Home',
  overseer: 'Overseer',
  missions: 'Missions',
  waterfall: 'Flow',
  code: 'Code',
  intel: 'Intel',
  notes: 'Notes',
};

export const NotepadPiP = ({ onClose, onDetach }: { onClose?: () => void; onDetach?: () => void } = {}) => {
  const {
    notepadContent, setNotepadContent, supervisorInsight, setSupervisorInsight,
    thinkingModeEnabled, setThinkingModeEnabled, auraMode, setAuraMode,
    globalProvider, setGlobalProvider, setCurrentMode, activities,
    messages, waterfall, waterfallAbortController,
    terminalLines, clearTerminalLines, agentMessages,
    pendingDiff, clearPendingDiff,
    openFiles, activeFile,
    fileTreeVisible, setFileTreeVisible,
    chatPanelVisible, setChatPanelVisible,
    terminalVisible, setTerminalVisible,
    intelAmbientContext, intelPanelContent,
  } = useAppStore();

  const [view, setView] = useState<PipView>('dash');
  const [showSettings, setShowSettings] = useState(false);

  const [overseerDecisions, setOverseerDecisions] = useState<LocalOverseerDecision[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isThinking, setIsThinking] = useState(false);

  const [activeMissions, setActiveMissions] = useState<LocalActiveMission[]>([]);
  const [missionGoal, setMissionGoal] = useState('');
  const [missionTemplate, setMissionTemplate] = useState('consultation');
  const [launchingMission, setLaunchingMission] = useState(false);
  const [expandedMission, setExpandedMission] = useState<string | null>(null);

  const [traceHealth, setTraceHealth] = useState<TraceHealth | null>(null);
  useEffect(() => {
    let active = true;
    const poll = () => getTraceHealth().then(h => { if (active) setTraceHealth(h); }).catch(() => {});
    poll();
    const interval = setInterval(poll, 30_000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  useEffect(() => {
    const handleOverseerDecision = (d: Record<string, unknown>) => {
      const decision: LocalOverseerDecision = {
        id: (d.id as string) || `od_${Date.now()}`,
        decision: (d.decision as string) || (d.message as string) || JSON.stringify(d),
        intervention: d.intervention as LocalOverseerDecision['intervention'],
        timestamp: (d.timestamp as number) || Date.now(),
        trigger: d.trigger as string | undefined,
      };
      setOverseerDecisions(prev => [decision, ...prev].slice(0, 20));
      if (view !== 'overseer') setUnreadCount(c => c + 1);
    };

    const handleNudge = ({ message }: { message: string }) => {
      setSupervisorInsight(message);
    };

    const handleMissionProgress = ({ jobId, progress }: { jobId: string; progress: number }) => {
      setActiveMissions(prev => prev.map(m =>
        m.jobId === jobId ? { ...m, progress, status: 'active' } : m
      ));
    };

    const handleMissionComplete = ({ jobId, result }: { jobId: string; result: unknown }) => {
      setActiveMissions(prev => prev.map(m =>
        m.jobId === jobId ? { ...m, status: 'complete', progress: 100, result } : m
      ));
    };

    const handleMissionFailed = ({ jobId, error }: { jobId: string; error: string }) => {
      setActiveMissions(prev => prev.map(m =>
        m.jobId === jobId ? { ...m, status: 'failed', error } : m
      ));
    };

    socket.on('OVERSEER_DECISION', handleOverseerDecision);
    socket.on('supervisor-nudge', handleNudge);
    socket.on('MISSION_PROGRESS', handleMissionProgress);
    socket.on('MISSION_COMPLETE', handleMissionComplete);
    socket.on('MISSION_FAILED', handleMissionFailed);

    return () => {
      socket.off('OVERSEER_DECISION', handleOverseerDecision);
      socket.off('supervisor-nudge', handleNudge);
      socket.off('MISSION_PROGRESS', handleMissionProgress);
      socket.off('MISSION_COMPLETE', handleMissionComplete);
      socket.off('MISSION_FAILED', handleMissionFailed);
    };
  }, [view, setSupervisorInsight]);

  useEffect(() => {
    if (view === 'overseer') setUnreadCount(0);
  }, [view]);

  const triggerOverseer = useCallback(async (focus?: string) => {
    setIsThinking(true);
    try {
      let enrichedNotepad = notepadContent;
      if (intelAmbientContext && intelPanelContent.type !== 'idle') {
        if (intelPanelContent.type === 'reader' && intelPanelContent.pageContent) {
          enrichedNotepad += `\n\n--- Intel Context ---\n${intelPanelContent.pageContent.title}: ${intelPanelContent.pageContent.content.slice(0, 1000)}`;
        } else if (intelPanelContent.type === 'search' && intelPanelContent.searchResults?.synthesis) {
          enrichedNotepad += `\n\n--- Intel Context ---\nSearch "${intelPanelContent.query}": ${intelPanelContent.searchResults.synthesis.answer.slice(0, 500)}`;
        }
      }
      await fetchWithRetry(`${API_BASE_URL}/overseer/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          focus: focus || 'manual_check',
          notepadContent: enrichedNotepad,
          recentMessages: messages.slice(-8),
        }),
        retries: 1,
      });
    } catch { /* non-fatal */ }
    finally { setIsThinking(false); }
  }, [notepadContent, messages, intelAmbientContext, intelPanelContent]);

  const launchMission = useCallback(async () => {
    if (!missionGoal.trim()) return;
    setLaunchingMission(true);
    try {
      const data = await fetchWithRetry<{ jobId?: string }>(`${API_BASE_URL}/collaborate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: missionGoal, missionType: missionTemplate, async: true }),
      });
      const jobId = data.jobId;
      if (jobId) {
        setActiveMissions(prev => [{
          jobId,
          goal: missionGoal,
          missionType: missionTemplate,
          status: 'queued' as const,
          progress: 0,
        }, ...prev].slice(0, 10));
        setMissionGoal('');
      }
    } catch { /* non-fatal */ }
    finally { setLaunchingMission(false); }
  }, [missionGoal, missionTemplate]);

  const launchInMainApp = (mode: string) => setCurrentMode(mode);
  const activeMissionCount = activeMissions.filter(m => m.status === 'queued' || m.status === 'active').length;

  return (
    <div className="h-full w-full flex flex-col bg-[#050508] text-slate-300 border border-white/[0.06] overflow-hidden font-sans">
      {/* Zone A: Header */}
      <div
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        className="drag-handle flex items-center justify-between px-3 py-2 bg-[#0a0a0f] border-b border-white/[0.06] cursor-move shrink-0"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-4 h-4 rounded-sm bg-gradient-to-br from-jb-accent to-jb-purple shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-[0.25em] text-white/50">Solvent</span>
          {view !== 'dash' && (
            <>
              <span className="text-[10px] text-white/10">/</span>
              <span className="text-[10px] font-medium text-white/30">{VIEW_LABELS[view]}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={cn(
              "p-1.5 rounded-md transition-all hover:bg-white/[0.06]",
              showSettings ? "text-white bg-white/[0.08]" : "text-slate-500 hover:text-white"
            )}
            title="Settings"
          >
            <Settings size={13} />
          </button>
          {onDetach && (
            <button
              onClick={onDetach}
              className="p-1.5 rounded-md text-slate-500 hover:text-jb-orange hover:bg-white/[0.06] transition-all"
              title="Detach to floating window"
            >
              <ExternalLink size={13} />
            </button>
          )}
          <button
            onClick={() => onClose ? onClose() : window.close()}
            className="p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-white/[0.06] transition-all"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Zone B: Content */}
      <div className="flex-1 overflow-hidden flex flex-col relative min-h-0">
        {/* Settings Overlay */}
        <AnimatePresence>
          {showSettings && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="absolute inset-0 bg-black/40 backdrop-blur-sm z-[99]"
                onClick={() => setShowSettings(false)}
              />
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
                className="absolute top-3 left-3 right-3 z-[100] rounded-xl border border-white/[0.08] shadow-[0_8px_32px_rgba(0,0,0,0.5)] p-3 flex flex-col gap-2 bg-[#0a0a0f]/95 backdrop-blur-2xl"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="cc-section-heading">Settings</span>
                  <button onClick={() => setShowSettings(false)} className="text-slate-500 hover:text-white transition-colors">
                    <X size={12} />
                  </button>
                </div>
                <div className="space-y-1.5">
                  <button
                    onClick={() => setThinkingModeEnabled(!thinkingModeEnabled)}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all",
                      thinkingModeEnabled ? "bg-jb-purple/15 text-jb-purple" : "bg-white/[0.03] text-slate-400 hover:text-white"
                    )}
                  >
                    <div className="flex items-center gap-2"><Brain size={13} /><span>Deep Thinking</span></div>
                    <div className={cn("w-2 h-2 rounded-full transition-all", thinkingModeEnabled ? "bg-jb-purple shadow-[0_0_8px_rgba(157,91,210,0.8)]" : "bg-slate-700")} />
                  </button>
                  <button
                    onClick={() => setAuraMode(auraMode === 'off' ? 'organic' : 'off')}
                    className={cn(
                      "w-full flex items-center justify-between px-3 py-2 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-all",
                      auraMode !== 'off' ? "bg-jb-orange/15 text-jb-orange" : "bg-white/[0.03] text-slate-400 hover:text-white"
                    )}
                  >
                    <div className="flex items-center gap-2"><Sparkles size={13} /><span>Visual Effects</span></div>
                    <div className={cn("w-2 h-2 rounded-full transition-all", auraMode !== 'off' ? "bg-jb-orange shadow-[0_0_8px_rgba(251,146,60,0.8)]" : "bg-slate-700")} />
                  </button>
                  <div className="pt-2 mt-1 border-t border-white/[0.04] flex flex-col gap-1.5">
                    <span className="cc-section-heading ml-0.5">AI Provider</span>
                    <div className="flex gap-1">
                      {(['cloud', 'local', 'auto'] as const).map(p => (
                        <button
                          key={p}
                          onClick={() => setGlobalProvider(p)}
                          className={cn(
                            "flex-1 py-2 rounded-lg text-[10px] font-semibold uppercase tracking-wider transition-all border",
                            globalProvider === p
                              ? "bg-white text-black border-white"
                              : "bg-white/[0.02] text-slate-400 border-white/[0.04] hover:border-white/[0.12]"
                          )}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        <AnimatePresence mode="wait">
          {view === 'dash' && (
            <PipDashView
              waterfall={waterfall}
              waterfallAbortController={waterfallAbortController}
              activities={activities}
              supervisorInsight={supervisorInsight}
              overseerDecisions={overseerDecisions}
              isThinking={isThinking}
              onOpenView={setView}
              onTriggerOverseer={triggerOverseer}
              globalProvider={globalProvider}
              thinkingModeEnabled={thinkingModeEnabled}
              activeMissionCount={activeMissionCount}
              traceHealth={traceHealth}
            />
          )}

          {view === 'waterfall' && <PipWaterfallView />}

          {view === 'notes' && (
            <PipNotesView
              notepadContent={notepadContent}
              onContentChange={setNotepadContent}
            />
          )}

          {view === 'overseer' && (
            <PipOverseerView
              decisions={overseerDecisions}
              isThinking={isThinking}
              supervisorInsight={supervisorInsight}
              onTrigger={triggerOverseer}
              onClearDecisions={() => { setOverseerDecisions([]); setUnreadCount(0); }}
            />
          )}

          {view === 'code' && (
            <PipCodeView
              terminalLines={terminalLines}
              pendingDiff={pendingDiff}
              openFiles={openFiles}
              activeFile={activeFile}
              fileTreeVisible={fileTreeVisible}
              chatPanelVisible={chatPanelVisible}
              terminalVisible={terminalVisible}
              agentMessages={agentMessages}
              onSetFileTreeVisible={setFileTreeVisible}
              onSetChatPanelVisible={setChatPanelVisible}
              onSetTerminalVisible={setTerminalVisible}
              onClearDiff={clearPendingDiff}
              onClearTerminal={clearTerminalLines}
              onLaunchMain={launchInMainApp}
            />
          )}

          {view === 'missions' && (
            <PipMissionsView
              activeMissions={activeMissions}
              activeMissionCount={activeMissionCount}
              missionGoal={missionGoal}
              missionTemplate={missionTemplate}
              launchingMission={launchingMission}
              expandedMission={expandedMission}
              onGoalChange={setMissionGoal}
              onTemplateChange={setMissionTemplate}
              onLaunch={launchMission}
              onToggleExpand={setExpandedMission}
            />
          )}

          {view === 'intel' && <PipIntelView />}
        </AnimatePresence>
      </div>

      {/* Zone C: Tab Bar */}
      <PipTabBar
        activeView={view}
        onChangeView={setView}
        unreadOverseer={unreadCount}
        activeMissions={activeMissionCount}
      />
    </div>
  );
};
