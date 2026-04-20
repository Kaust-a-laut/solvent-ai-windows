import React, { useEffect, useRef } from 'react';
import { Sparkles } from 'lucide-react';
import type { AgentMessage } from '../../store/codingSlice';
import { AgentUserEntry } from './AgentUserEntry';
import { AgentTurnBlock } from './AgentTurnBlock';

interface Props {
  agentMessages: AgentMessage[];
  isGenerating: boolean;
  copiedMsgId: string | null;
  onCopy: (msg: AgentMessage) => void;
}

export const AgentTimeline: React.FC<Props> = ({
  agentMessages,
  isGenerating,
  copiedMsgId,
  onCopy,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [agentMessages]);

  if (agentMessages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-white/30">
        <Sparkles size={48} className="mb-4 opacity-50" />
        <p className="text-[13px]">Ask the agent anything</p>
        <p className="text-[11px] mt-1 opacity-60">Type / for slash commands</p>
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-4 px-3 py-2">
      {agentMessages.map((msg) => {
        if (msg.role === 'user') {
          return <AgentUserEntry key={msg.id} msg={msg} />;
        }
        return (
          <AgentTurnBlock
            key={msg.id}
            msg={msg}
            isStreaming={isGenerating && msg.isStreaming === true}
            copiedMsgId={copiedMsgId}
            onCopy={onCopy}
          />
        );
      })}
    </div>
  );
};
