import React, { useState } from 'react';
import { Handle, Position, NodeProps, NodeResizer } from '@xyflow/react';
import { useAppStore } from '../../../store/useAppStore';
import { cn } from '../../../lib/utils';
import { ImageIcon, Pencil } from 'lucide-react';

interface ImageNodeData {
  src?: string;
  text?: string;
}

export const ImageNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d = data as ImageNodeData;
  const [captionEditing, setCaptionEditing] = useState(false);
  const [captionDraft, setCaptionDraft] = useState(d.text ?? '');
  const updateActive = useAppStore((s) => s.notepadUpdateActive);

  const commit = () => {
    updateActive((doc) => ({
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, text: captionDraft } } : n)),
    }));
    setCaptionEditing(false);
  };

  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-black/50 shadow-xl overflow-hidden w-full h-full flex flex-col',
        selected && 'ring-1 ring-jb-accent/50'
      )}
    >
      <NodeResizer minWidth={140} minHeight={120} isVisible={!!selected} keepAspectRatio={false} lineClassName="!border-jb-accent/40" handleClassName="!w-2 !h-2 !bg-jb-accent" />

      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-white/30 !border-0" />
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-white/30 !border-0" />
      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-jb-accent !border-0" />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-jb-accent !border-0" />

      <div className="flex-1 min-h-0 bg-black/60 flex items-center justify-center overflow-hidden">
        {d.src ? (
          <img src={d.src} alt={d.text || 'pinned image'} className="w-full h-full object-contain" draggable={false} />
        ) : (
          <div className="flex flex-col items-center gap-2 text-white/30">
            <ImageIcon size={28} />
            <span className="text-[10px] uppercase tracking-widest">No image</span>
          </div>
        )}
      </div>

      <div className="shrink-0 px-2 py-1.5 border-t border-white/5 bg-black/60 flex items-center gap-2">
        {captionEditing ? (
          <input
            value={captionDraft}
            onChange={(e) => setCaptionDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setCaptionDraft(d.text ?? ''); setCaptionEditing(false); }
            }}
            autoFocus
            className="nodrag flex-1 bg-transparent text-[10px] text-slate-300 outline-none placeholder:text-white/20"
            placeholder="Add caption…"
          />
        ) : (
          <>
            <span className="flex-1 text-[10px] text-slate-400 truncate">{d.text || 'Untitled image'}</span>
            <button
              onClick={() => setCaptionEditing(true)}
              className="text-white/30 hover:text-white/70 transition-colors"
              title="Edit caption"
            >
              <Pencil size={11} />
            </button>
          </>
        )}
      </div>
    </div>
  );
};
