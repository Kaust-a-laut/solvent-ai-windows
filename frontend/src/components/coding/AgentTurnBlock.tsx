import React from 'react';
import { Copy, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AgentMessage, ToolEvent } from '../../store/codingSlice';
import { reconstructIterations } from '../../lib/agentIterations';
import { AgentTextBlock } from './AgentTextBlock';
import { AgentActionCard } from './AgentActionCard';

interface Props {
  msg: AgentMessage;
  isStreaming: boolean;
  copiedMsgId: string | null;
  onCopy: (msg: AgentMessage) => void;
}

function findResultEvent(toolEvents: ToolEvent[], startEvent: ToolEvent): ToolEvent | undefined {
  return toolEvents.find(
    (e) => e.callId === startEvent.callId && (e.type === 'tool_result' || e.type === 'tool_error') && e.tool === startEvent.tool
  );
}

export const AgentTurnBlock: React.FC<Props> = ({ msg, isStreaming, copiedMsgId, onCopy }) => {
  const iterations = reconstructIterations(msg);

  return (
    <div className="relative rounded-xl bg-white/[0.03] border border-white/[0.05] px-3 py-2 group">
      {(msg.content || msg.iterations?.some(i => i.toolEvents.length) || msg.toolEvents?.length) && (
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
            {iter.text && (
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
              <div className="flex items-center gap-2 py-1">
                <div className="flex-1 h-px bg-white/[0.06]" />
                <span className="text-[9px] font-bold uppercase tracking-wider text-white/20">
                  iteration {iter.index + 1}
                </span>
                <div className="flex-1 h-px bg-white/[0.06]" />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};
