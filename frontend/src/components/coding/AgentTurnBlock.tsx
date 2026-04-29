import React from 'react';
import { Copy, Check, Undo2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useAppStore } from '../../store/useAppStore';
import type { AgentMessage, ToolEvent } from '../../store/codingSlice';
import { reconstructIterations } from '../../lib/agentIterations';
import { AgentTextBlock } from './AgentTextBlock';
import { AgentActionCard } from './AgentActionCard';

const WRITE_TOOL_NAMES = new Set(['write_file', 'edit_file', 'create_file', 'replace_in_files', 'move_file', 'delete_file']);

interface Props {
  msg: AgentMessage;
  isStreaming: boolean;
  copiedMsgId: string | null;
  onCopy: (msg: AgentMessage) => void;
  /** Called to undo all write tools in a specific iteration. */
  onUndoIteration?: (iteration: { index: number; toolEvents: ToolEvent[] }) => void;
}

function findResultEvent(toolEvents: ToolEvent[], startEvent: ToolEvent): ToolEvent | undefined {
  return toolEvents.find(
    (e) => e.callId === startEvent.callId && (e.type === 'tool_result' || e.type === 'tool_error') && e.tool === startEvent.tool
  );
}

export const AgentTurnBlock: React.FC<Props> = ({ msg, isStreaming, copiedMsgId, onCopy, onUndoIteration }) => {
  const iterations = reconstructIterations(msg);
  const agentPlan = useAppStore((s) => s.agentPlan);

  // Check if an iteration has any write tool events with beforeContent (undoable)
  const hasUndoableWrites = (iter: { toolEvents: ToolEvent[] }) =>
    iter.toolEvents.some(
      (e) => e.type === 'tool_start' && WRITE_TOOL_NAMES.has(e.tool) && e.beforeContent !== undefined
    );

  return (
    <div className="relative rounded-xl bg-white/[0.03] border border-white/[0.05] px-3 py-2 group">
      {agentPlan && agentPlan.steps.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white/[0.03] border-b border-white/[0.06] text-[11px] overflow-x-auto -mx-3 -mt-2 mb-2 rounded-t-xl">
          <span className="text-white/40 font-medium shrink-0">PLAN</span>
          {agentPlan.steps.map((step, i) => (
            <span key={step.id} className={cn(
              'flex items-center gap-1 shrink-0',
              step.status === 'completed' ? 'text-emerald-400/80' :
              step.status === 'in_progress' ? 'text-jb-accent' :
              step.status === 'blocked' ? 'text-rose-400/80' :
              'text-white/25'
            )}>
              {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : step.status === 'blocked' ? '✗' : '○'}
              <span className="max-w-[120px] truncate" title={step.title}>{step.title}</span>
              {i < agentPlan.steps.length - 1 && <span className="text-white/10">→</span>}
            </span>
          ))}
        </div>
      )}
      {!!(msg.content || msg.iterations?.some(i => i.toolEvents.length) || msg.toolEvents?.length) && (
        <button
          type="button"
          onClick={() => onCopy(msg)}
          className={cn(
            'absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity',
            'hover:bg-white/10 text-white/40 hover:text-white/70'
          )}
          title="Copy response"
          aria-label="Copy response"
        >
          {copiedMsgId === msg.id ? <Check size={12} /> : <Copy size={12} />}
        </button>
      )}

      <div className="space-y-3">
        {iterations.map((iter, idx) => (
          <React.Fragment key={iter.index}>
            {(iter.text || (isStreaming && idx === iterations.length - 1)) && (
              <AgentTextBlock
                text={iter.text}
                isStreaming={isStreaming && idx === iterations.length - 1}
              />
            )}

            {iter.toolEvents.length > 0 && (
              <div className="space-y-1">
                {iter.toolEvents
                  .filter((e) => e.type === 'tool_start')
                  .map((startEvent) => {
                    const resultEvent = findResultEvent(iter.toolEvents, startEvent);
                    return (
                      <AgentActionCard
                        key={startEvent.callId}
                        startEvent={startEvent}
                        resultEvent={resultEvent}
                        previousContent={startEvent.beforeContent}
                      />
                    );
                  })}
              </div>
            )}

            {isStreaming && idx === iterations.length - 1 && iter.toolEvents.length > 0 && !iter.text && (
              <div className="flex items-center gap-2 pt-2">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className="w-1.5 h-1.5 rounded-full bg-jb-accent/40 animate-bounce"
                      style={{ animationDelay: `${i * 0.15}s` }}
                    />
                  ))}
                </div>
                <span className="text-[10px] font-semibold text-white/30">thinking...</span>
              </div>
            )}

            {idx < iterations.length - 1 && (
              <div className="flex items-center justify-center gap-2 py-0.5">
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/[0.03] border border-white/[0.05] text-[9px] font-medium text-white/30 lowercase tracking-wide">
                  <span className="w-1 h-1 rounded-full bg-white/20" />
                  iteration {iter.index + 1}
                  {onUndoIteration && hasUndoableWrites(iter) && (
                    <button
                      type="button"
                      onClick={() => onUndoIteration(iter)}
                      className="ml-1 flex items-center gap-0.5 text-white/30 hover:text-rose-400 transition-colors"
                      title="Undo all file writes in this iteration"
                    >
                      <Undo2 size={9} />
                      undo
                    </button>
                  )}
                </span>
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
