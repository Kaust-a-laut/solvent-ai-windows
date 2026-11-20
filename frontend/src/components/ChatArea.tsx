import React, { Suspense, useEffect, lazy, useState, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { useDevice } from '../hooks/useDevice';
import AuraBackground from './AuraBackground';
import { Navigation } from './Navigation';
import { ChatView } from './ChatView';
import { HomeArea } from './HomeArea';
import { FloatingNotepad } from './FloatingNotepad';
import { Network, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { TitleBar } from './TitleBar';
import { SettingsModal } from './SettingsModal';
import { SupervisorHistory } from './SupervisorHistory';
import { KnowledgeMapMini } from './KnowledgeMapMini';
import { cn } from '../lib/utils';
import { useLiveModels } from '../lib/liveModels';
import { toast } from 'sonner';

import type { ActivityEvent } from '../store/types';

/**
 * Validates the persisted cloud model selection against the live registry
 * once it loads — a model retired while the app was closed gets migrated to
 * the first live model of the same provider instead of silently failing.
 */
const useValidateModelSelection = () => {
  const live = useLiveModels();

  useEffect(() => {
    if (!live) return;
    const { selectedCloudModel, selectedCloudProvider, setSelectedCloudModel } = useAppStore.getState();
    // Only providers whose endpoint list is the complete live catalog —
    // openrouter/dashscope serve a curated subset, so a custom user-typed
    // model there must not be treated as retired (the backend request-time
    // fallback still covers those).
    const authoritative = new Set(['groq', 'fireworks', 'cerebras', 'gemini']);
    if (!authoritative.has(selectedCloudProvider)) return;
    const list = live[selectedCloudProvider];
    if (!list || list.length === 0 || !selectedCloudModel) return; // unverifiable provider
    if (list.includes(selectedCloudModel)) return;

    const replacement = list[0]!;
    setSelectedCloudModel(replacement);
    toast.warning(`${selectedCloudModel} was retired by ${selectedCloudProvider}`, {
      description: `Your selection moved to ${replacement}. Pick a different model in Settings if needed.`,
      duration: 10_000,
    });
  }, [live]);
};

// Lazy load feature areas to slim down the main bundle
const DebateArea = lazy(() => import('./DebateArea').then(m => ({ default: m.DebateArea })));
const CompareArea = lazy(() => import('./CompareArea').then(m => ({ default: m.CompareArea })));
const CollaborateArea = lazy(() => import('./CollaborateArea').then(m => ({ default: m.CollaborateArea })));
const WaterfallArea = lazy(() => import('./WaterfallArea').then(m => ({ default: m.WaterfallArea })));
const CodingArea = lazy(() => import('./CodingArea').then(m => ({ default: m.CodingArea })));
const BrowserArea = lazy(() => import('./BrowserArea').then(m => ({ default: m.BrowserArea })));
const SolventSeeArea = lazy(() => import('./SolventSeeArea').then(m => ({ default: m.SolventSeeArea })));
const ModelPlaygroundArea = lazy(() => import('./ModelPlaygroundArea').then(m => ({ default: m.ModelPlaygroundArea })));
const NotepadArea = lazy(() => import('./notepad/NotepadArea').then(m => ({ default: m.NotepadArea })));

const LoadingFallback = () => (
  <div className="flex-1 flex flex-col items-center justify-center gap-4">
    <Loader2 className="w-8 h-8 text-jb-purple animate-spin" />
    <span className="text-[11px] font-black uppercase tracking-[0.4em] text-slate-300">Initializing Neural Canvas...</span>
  </div>
);

export const ChatArea = () => {
  const { currentMode, setCurrentMode, setDeviceInfo, deviceInfo, setSupervisorInsight, addActivity, graphNodes, isProcessing } = useAppStore(
    useShallow((state) => ({
      currentMode: state.currentMode,
      setCurrentMode: state.setCurrentMode,
      setDeviceInfo: state.setDeviceInfo,
      deviceInfo: state.deviceInfo,
      setSupervisorInsight: state.setSupervisorInsight,
      supervisorInsight: state.supervisorInsight,
      addActivity: state.addActivity,
      graphNodes: state.graphNodes,
      isProcessing: state.isProcessingByMode[state.currentMode] ?? false,
    }))
  );
  const device = useDevice();
  useValidateModelSelection();
  // Graph pulse effect - track when new nodes are added
  const prevNodeCount = useRef(graphNodes.length);
  const [graphPulse, setGraphPulse] = useState(false);
  const [newNodeCount, setNewNodeCount] = useState(0);
  const graphPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supervisorInsightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (graphNodes.length > prevNodeCount.current) {
      const diff = graphNodes.length - prevNodeCount.current;
      setNewNodeCount(diff);
      setGraphPulse(true);

      // Add activity for new nodes
      addActivity({
        id: `graph-update-${Date.now()}`,
        type: 'graph',
        message: `Knowledge graph expanded: +${diff} node${diff > 1 ? 's' : ''}`,
        timestamp: new Date().toISOString(),
        source: 'system'
      });

      // Reset any pending pulse-clear so a second update within the window
      // doesn't get its count wiped by the first timeout firing late.
      if (graphPulseTimerRef.current) clearTimeout(graphPulseTimerRef.current);
      graphPulseTimerRef.current = setTimeout(() => {
        setGraphPulse(false);
        setNewNodeCount(0);
      }, 2000);
    }
    prevNodeCount.current = graphNodes.length;
  }, [graphNodes.length, addActivity]);

  // Clear any in-flight pulse/insight timers on unmount.
  useEffect(() => {
    return () => {
      if (graphPulseTimerRef.current) clearTimeout(graphPulseTimerRef.current);
      if (supervisorInsightTimerRef.current) clearTimeout(supervisorInsightTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (window.electron?.onModeChanged) {
      return window.electron.onModeChanged((mode: string) => {
        setCurrentMode(mode);
      });
    }
  }, [setCurrentMode]);

  useEffect(() => {
    if (
      device.isMobile !== deviceInfo.isMobile ||
      device.isTablet !== deviceInfo.isTablet ||
      device.windowSize.width !== deviceInfo.windowSize.width ||
      device.windowSize.height !== deviceInfo.windowSize.height
    ) {
      setDeviceInfo(device);
    }
  }, [device, setDeviceInfo, deviceInfo]);

  useEffect(() => {
    if (window.electron?.onSupervisorNudge) {
      const cleanup = window.electron.onSupervisorNudge((nudge: { message: string }) => {
        setSupervisorInsight(nudge.message);
        // Reset any pending clear so a second nudge within the window
        // doesn't get wiped out by the first nudge's stale timeout.
        if (supervisorInsightTimerRef.current) clearTimeout(supervisorInsightTimerRef.current);
        supervisorInsightTimerRef.current = setTimeout(() => setSupervisorInsight(null), 10000);
      });
      return cleanup;
    }
  }, [setSupervisorInsight]);

  useEffect(() => {
    const electron = window.electron as Record<string, unknown> | undefined;
    if (electron && typeof electron.onSupervisorData === 'function') {
      return (electron.onSupervisorData as (cb: (activity: ActivityEvent) => void) => (() => void) | undefined)((activity: ActivityEvent) => {
        addActivity(activity);
      });
    }
  }, [addActivity]);

  const renderContent = () => {
    const areas: Record<string, React.ReactNode> = {
      home: <HomeArea />,
      model_playground: <ModelPlaygroundArea />,
      debate: <DebateArea />,
      compare: <CompareArea />,
      collaborate: <CollaborateArea />,
      waterfall: <WaterfallArea />,
      vision: <SolventSeeArea />,
      coding: <CodingArea />,
      browser: <BrowserArea />,
      notepad: <NotepadArea />,
      chat: <ChatView />
    };

    return areas[currentMode] || <ChatView />;
  };

  return (
    <AuraBackground>
      <div className="flex flex-col flex-1 min-h-0 w-full overflow-clip font-sans">
        <TitleBar />
        <div className="flex flex-1 min-h-0 overflow-clip relative">
          <Navigation />
          <AnimatePresence>
             <SettingsModal />
          </AnimatePresence>

          <div className="flex-1 flex min-h-0 overflow-clip relative">
             <div className={cn(
               "flex-1 flex flex-col border-r border-white/5 relative z-10 min-w-0 min-h-0 overflow-clip transition-all duration-500",
               graphPulse && "ring-2 ring-jb-purple/20 ring-inset",
               isProcessing && "intelligence-active"
             )}>
                {/* Graph Update Pulse Indicator */}
                <AnimatePresence>
                  {graphPulse && (
                    <motion.div
                      initial={{ opacity: 0, y: -20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      className="absolute top-4 right-4 z-50 flex items-center gap-2 px-3 py-2 bg-jb-purple/20 border border-jb-purple/30 rounded-full backdrop-blur-sm shadow-lg"
                    >
                      <div className="relative">
                        <div className="w-2 h-2 rounded-full bg-jb-purple" />
                        <div className="absolute inset-0 w-2 h-2 rounded-full bg-jb-purple animate-ping" />
                      </div>
                      <span className="text-[11px] font-black text-jb-purple uppercase tracking-widest">
                        +{newNodeCount} Node{newNodeCount > 1 ? 's' : ''}
                      </span>
                      <Network size={12} className="text-jb-purple" />
                    </motion.div>
                  )}
                </AnimatePresence>

                <Suspense fallback={<LoadingFallback />}>
                   {renderContent()}
                </Suspense>
                
             </div>
          </div>
        </div>
      </div>
      <FloatingNotepad />

      {/* Persistent Supervisor History Panel */}
      <SupervisorHistory />

      {/* Knowledge Map Mini Preview */}
      <KnowledgeMapMini />
    </AuraBackground>
  );
};