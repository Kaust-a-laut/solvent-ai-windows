import React from 'react';
import type { AgentMessage } from '../../store/codingSlice';

interface Props {
  msg: AgentMessage;
}

export const AgentUserEntry: React.FC<Props> = ({ msg }) => {
  const isBuildCheck = msg.content.startsWith('[build_check');
  if (isBuildCheck) return null;

  return (
    <div className="flex flex-col items-end max-w-[80%] ml-auto">
      {msg.fileContext && (
        <span className="text-[10px] text-white/40 mb-1 px-2">
          with context: {msg.fileContext}
        </span>
      )}
      <div className="rounded-2xl px-4 py-2 bg-jb-accent/10 border border-jb-accent/20 text-[12px] text-slate-200">
        {msg.content}
      </div>
    </div>
  );
};
