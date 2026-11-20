import React from 'react';
import { Square, Trash2, ChevronDown, Brain } from 'lucide-react';
import { cn } from '../../lib/utils';
import { AGENT_MODEL_OPTIONS } from '../ModelSelector';

interface Props {
  isGenerating: boolean;
  currentAction: string;
  iteration: number;
  model: string;
  onStop: () => void;
  onClear: () => void;
  onModelChange: (model: string, provider: string) => void;
  /** Session token usage for display in the status bar. */
  tokenUsage?: { promptTokens: number; completionTokens: number; cachedTokens: number };
  /** Toggle memory panel */
  onToggleMemory?: () => void;
}

export const AgentStatusBar: React.FC<Props> = ({
  isGenerating,
  currentAction,
  iteration,
  model,
  onStop,
  onClear,
  onModelChange,
  tokenUsage,
  onToggleMemory,
}) => {
  const [showModelMenu, setShowModelMenu] = React.useState(false);
  const selectedModel =
    AGENT_MODEL_OPTIONS.find(m => m.model === model) ?? AGENT_MODEL_OPTIONS[0];

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.16] bg-white/[0.04] shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)]">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-black uppercase tracking-[0.2em] text-white/60">Agent</span>
        <span className="text-[11px] text-white/20">·</span>

        <div className="relative">
          <button
            type="button"
            onClick={() => setShowModelMenu(v => !v)}
            className="flex items-center gap-1 text-[11px] text-white/60 hover:text-white/80 transition-colors"
            aria-label="Select model"
          >
            <span className="truncate max-w-[140px]">
              {selectedModel?.displayName ?? model ?? 'auto'}
            </span>
            <ChevronDown size={10} />
          </button>

          {showModelMenu && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setShowModelMenu(false)}
                aria-hidden="true"
              />
              <div className="absolute top-full left-0 mt-1 w-72 rounded-xl border border-white/[0.07] bg-[#0a0a14] overflow-hidden z-50 shadow-xl max-h-[70vh] overflow-y-auto scrollbar-thin">
                {(['full-agentic', 'code-only'] as const).map(tier => {
                  const group = AGENT_MODEL_OPTIONS.filter(m => m.tier === tier);
                  if (group.length === 0) return null;
                  return (
                    <div key={tier}>
                      <div className="px-3 pt-2.5 pb-1 flex items-center gap-2">
                        <span className="text-[9px] font-black uppercase tracking-[0.15em] text-white/55">
                          {tier === 'full-agentic' ? 'Full Agentic' : 'Efficient'}
                        </span>
                        <div className="flex-1 h-px bg-white/[0.06]" />
                      </div>
                      {group.map(m => {
                        const Icon = m.icon;
                        const isActive = model === m.model;
                        const sub = m.sublabel.toLowerCase();
                        const hasVision = sub.includes('vision');
                        const hasCode = sub.includes('code');
                        const isGeneral = !hasVision && !hasCode;
                        return (
                          <button
                            key={m.model}
                            type="button"
                            onClick={() => {
                              onModelChange(m.model, m.provider);
                              setShowModelMenu(false);
                            }}
                            className={cn(
                              'w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-all',
                              m.bgColor.replace('/10', '/[0.06]'),
                              'hover:brightness-150',
                              isActive && 'ring-1 ring-inset ring-white/15',
                            )}
                          >
                            <Icon size={11} className={m.color} aria-hidden="true" />
                            <div className="flex-1 flex flex-col min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-[11px] font-semibold leading-tight truncate text-white/85">
                                  {m.displayName}
                                </span>
                                {hasVision && (
                                  <span className="shrink-0 text-[8px] font-bold px-1 py-px rounded bg-blue-500/15 text-blue-400 leading-tight">
                                    VISION
                                  </span>
                                )}
                                {hasCode && (
                                  <span className="shrink-0 text-[8px] font-bold px-1 py-px rounded bg-orange-500/15 text-orange-400 leading-tight">
                                    CODE
                                  </span>
                                )}
                                {isGeneral && (
                                  <span className="shrink-0 text-[8px] font-bold px-1 py-px rounded bg-rose-500/15 text-rose-400 leading-tight">
                                    GENERAL
                                  </span>
                                )}
                                {tier === 'full-agentic' && (
                                  <span className="shrink-0 text-[8px] font-bold px-1 py-px rounded bg-emerald-500/15 text-emerald-400 leading-tight">
                                    TOOLS
                                  </span>
                                )}
                              </div>
                              <span className="text-[10px] text-white/55 leading-tight truncate">
                                {m.sublabel}
                              </span>
                            </div>
                            {isActive && (
                              <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {isGenerating && iteration > 0 && (
          <span className="text-[10px] text-white/30 font-mono">
            Iter {iteration}
          </span>
        )}
        {!isGenerating && tokenUsage && tokenUsage.promptTokens > 0 && (
          <span className="text-[9px] text-white/20 font-mono" title={`${tokenUsage.promptTokens} prompt + ${tokenUsage.completionTokens} completion tokens`}>
            {(tokenUsage.promptTokens + tokenUsage.completionTokens).toLocaleString()} tok
            {tokenUsage.cachedTokens > 0 && ` (${tokenUsage.cachedTokens.toLocaleString()} cached)`}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {currentAction && (
          <span className="text-[11px] text-white/40 truncate max-w-[200px]">
            {currentAction}
          </span>
        )}

        {onToggleMemory && (
          <button
            type="button"
            onClick={onToggleMemory}
            className="p-1 rounded hover:bg-violet-500/10 text-violet-400/50 hover:text-violet-400 transition-colors"
            title="Agent Memory"
            aria-label="Toggle memory panel"
          >
            <Brain size={13} />
          </button>
        )}

        {isGenerating ? (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1 px-2 py-1 rounded bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 transition-colors text-[11px]"
          >
            <Square size={10} fill="currentColor" />
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={onClear}
            className="flex items-center gap-1 px-2 py-1 rounded bg-white/[0.05] text-white/40 hover:bg-white/[0.08] hover:text-white/60 transition-colors text-[11px]"
            title="Clear chat"
            aria-label="Clear chat"
          >
            <Trash2 size={10} />
            Clear
          </button>
        )}
      </div>
    </div>
  );
};
