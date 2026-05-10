import React, { useState } from 'react';
import { NodeProps, NodeResizer } from '@xyflow/react';
import { useAppStore } from '../../../store/useAppStore';
import { cn } from '../../../lib/utils';

interface GroupNodeData {
  text?: string;
  color?: string;
}

const ACCENT: Record<string, string> = {
  amber: 'border-amber-400/40 bg-amber-400/[0.03]',
  cyan: 'border-cyan-400/40 bg-cyan-400/[0.03]',
  purple: 'border-jb-purple/40 bg-jb-purple/[0.03]',
  emerald: 'border-emerald-400/40 bg-emerald-400/[0.03]',
  default: 'border-white/15 bg-white/[0.02]',
};

export const GroupNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d = data as GroupNodeData;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.text ?? '');
  const updateActive = useAppStore((s) => s.notepadUpdateActive);

  const commit = () => {
    updateActive((doc) => ({
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, text: draft } } : n)),
    }));
    setEditing(false);
  };

  return (
    <div
      className={cn(
        'rounded-3xl border-2 border-dashed w-full h-full relative',
        ACCENT[d.color || 'default'] ?? ACCENT.default,
        selected && 'ring-1 ring-jb-accent/40'
      )}
    >
      <NodeResizer minWidth={240} minHeight={160} isVisible={!!selected} lineClassName="!border-jb-accent/40" handleClassName="!w-2 !h-2 !bg-jb-accent" />
      <div
        className="absolute -top-3 left-4 bg-[#050508] px-2 py-0.5 rounded-md border border-white/10 cursor-text"
        onDoubleClick={() => setEditing(true)}
      >
        {editing ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(d.text ?? ''); setEditing(false); } }}
            autoFocus
            className="nodrag bg-transparent text-[10px] uppercase tracking-widest font-black text-slate-300 outline-none w-32"
            placeholder="Group label"
          />
        ) : (
          <span className="text-[10px] uppercase tracking-widest font-black text-slate-300">
            {draft || 'Group'}
          </span>
        )}
      </div>
    </div>
  );
};
