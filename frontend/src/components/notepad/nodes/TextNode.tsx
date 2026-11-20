import React, { useState, useEffect, useRef } from 'react';
import { Handle, Position, NodeProps, NodeResizer } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '../../../store/useAppStore';
import { cn } from '../../../lib/utils';

interface TextNodeData {
  text?: string;
  color?: string;
}

const ACCENT_BORDER: Record<string, string> = {
  amber: 'border-amber-400/30 bg-amber-400/[0.04]',
  cyan: 'border-cyan-400/30 bg-cyan-400/[0.04]',
  purple: 'border-jb-purple/30 bg-jb-purple/[0.04]',
  emerald: 'border-emerald-400/30 bg-emerald-400/[0.04]',
  default: 'border-white/10 bg-black/40',
};

export const TextNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d = data as TextNodeData;
  const [editing, setEditing] = useState(!d.text);
  const [draft, setDraft] = useState(d.text ?? '');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const updateActive = useAppStore((s) => s.notepadUpdateActive);

  // Sync draft when the node text changes externally (render-adjust idiom —
  // an effect would paint one frame with the stale draft first).
  const [lastText, setLastText] = useState(d.text);
  if (d.text !== lastText) {
    setLastText(d.text);
    setDraft(d.text ?? '');
  }

  useEffect(() => {
    if (editing) {
      requestAnimationFrame(() => taRef.current?.focus());
    }
  }, [editing]);

  const commit = () => {
    updateActive((doc) => ({
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, text: draft } } : n)),
    }));
    setEditing(false);
  };

  const accent = ACCENT_BORDER[d.color || 'default'] ?? ACCENT_BORDER.default;

  return (
    <div
      className={cn(
        'rounded-2xl border backdrop-blur-md shadow-xl transition-all min-w-[200px] min-h-[80px] w-full h-full overflow-hidden',
        accent,
        selected && 'ring-1 ring-jb-accent/50'
      )}
      onDoubleClick={() => !editing && setEditing(true)}
    >
      <NodeResizer minWidth={180} minHeight={80} isVisible={!!selected} lineClassName="!border-jb-accent/40" handleClassName="!w-2 !h-2 !bg-jb-accent" />

      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-white/30 !border-0" />
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-white/30 !border-0" />
      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-jb-accent !border-0" />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-jb-accent !border-0" />

      {editing ? (
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { setDraft(d.text ?? ''); setEditing(false); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(); }
          }}
          spellCheck={false}
          placeholder="Write markdown… (⌘/Ctrl+Enter to save, Esc to cancel)"
          className="nodrag nowheel w-full h-full bg-transparent p-3 text-[12px] leading-[1.6] text-slate-200 outline-none resize-none placeholder:text-white/20"
        />
      ) : (
        <div className="prose prose-invert prose-sm max-w-none p-3 text-[12px] leading-[1.6] text-slate-300 nowheel overflow-auto h-full">
          {draft.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
          ) : (
            <span className="text-white/30 italic">Empty note — double-click to edit</span>
          )}
        </div>
      )}
    </div>
  );
};
