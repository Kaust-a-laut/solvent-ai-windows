import React from 'react';
import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { StickyNote, Image as ImageIcon, Link as LinkIcon, BoxSelect, Maximize2, Save, Loader2, Undo2, Redo2 } from 'lucide-react';
import { cn } from '../../lib/utils';

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

interface ToolbarProps {
  // toolbar is always rendered inside ReactFlowProvider; flag kept for clarity but no longer used
  withFlowContext?: boolean;
}

const ToolbarButton: React.FC<{ icon: React.ElementType; label: string; onClick: () => void; accent?: string }> = ({
  icon: Icon, label, onClick, accent
}) => (
  <button
    onClick={onClick}
    className={cn(
      'flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.05] hover:border-white/15 transition-colors text-[11px] text-slate-300 hover:text-white',
      accent
    )}
  >
    <Icon size={13} />
    <span className="font-medium">{label}</span>
  </button>
);

export const NotepadToolbar: React.FC<ToolbarProps> = () => {
  const { activeDoc, updateActive, dirty, save, undo, redo, canUndo, canRedo } = useAppStore(
    useShallow((s) => ({
      activeDoc: s.notepadActiveDoc,
      updateActive: s.notepadUpdateActive,
      dirty: s.notepadDirty,
      save: s.notepadSave,
      undo: s.notepadUndo,
      redo: s.notepadRedo,
      canUndo: s.notepadHistoryPast.length > 0,
      canRedo: s.notepadHistoryFuture.length > 0,
    }))
  );

  const flow = useReactFlow();

  const dropPos = () => ({ x: 80 + Math.random() * 200, y: 80 + Math.random() * 200 });

  const addText = () => {
    updateActive((doc) => ({
      ...doc,
      nodes: [
        ...doc.nodes,
        { id: newId('n'), type: 'text', position: dropPos(), data: { text: '' }, width: 260, height: 140 },
      ],
    }));
  };

  const addLink = () => {
    updateActive((doc) => ({
      ...doc,
      nodes: [
        ...doc.nodes,
        { id: newId('n'), type: 'link', position: dropPos(), data: { url: '', title: '' }, width: 280, height: 280 },
      ],
    }));
  };

  const addGroup = () => {
    updateActive((doc) => ({
      ...doc,
      nodes: [
        ...doc.nodes,
        { id: newId('n'), type: 'group', position: dropPos(), data: { text: 'Group' }, width: 360, height: 240 },
      ],
    }));
  };

  const triggerImageImport = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result as string;
        const ext = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        let src = base64;
        try {
          const api = window.electron?.notepad;
          const docId = useAppStore.getState().notepadActiveDocId;
          if (api && docId) {
            const saved = await api.saveImage(docId, base64, ext);
            src = saved.url;
          }
        } catch (e) {
          console.error('[notepad] image save failed', e);
        }
        updateActive((doc) => ({
          ...doc,
          nodes: [
            ...doc.nodes,
            { id: newId('n'), type: 'image', position: dropPos(), data: { src, text: file.name }, width: 280, height: 220 },
          ],
        }));
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5 bg-black/30 shrink-0">
      <span className="text-[10px] uppercase tracking-[0.3em] font-black text-slate-500 mr-2">Add</span>
      <ToolbarButton icon={StickyNote} label="Note" onClick={addText} />
      <ToolbarButton icon={ImageIcon} label="Image" onClick={triggerImageImport} />
      <ToolbarButton icon={LinkIcon} label="Link" onClick={addLink} />
      <ToolbarButton icon={BoxSelect} label="Group" onClick={addGroup} />

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={undo}
          disabled={!canUndo}
          title="Undo (Ctrl/Cmd+Z)"
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors',
            canUndo
              ? 'border-white/[0.06] bg-white/[0.02] text-slate-300 hover:bg-white/[0.05] hover:border-white/15 hover:text-white'
              : 'border-white/[0.04] bg-white/[0.01] text-white/20 cursor-not-allowed'
          )}
        >
          <Undo2 size={13} />
        </button>
        <button
          onClick={redo}
          disabled={!canRedo}
          title="Redo (Ctrl/Cmd+Shift+Z)"
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] transition-colors',
            canRedo
              ? 'border-white/[0.06] bg-white/[0.02] text-slate-300 hover:bg-white/[0.05] hover:border-white/15 hover:text-white'
              : 'border-white/[0.04] bg-white/[0.01] text-white/20 cursor-not-allowed'
          )}
        >
          <Redo2 size={13} />
        </button>
        <div className="h-5 w-px bg-white/10 mx-1" />
        <ToolbarButton icon={Maximize2} label="Fit view" onClick={() => flow.fitView({ duration: 400, padding: 0.2 })} />
        <button
          onClick={() => save()}
          disabled={!dirty}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors border',
            dirty
              ? 'bg-jb-accent/10 hover:bg-jb-accent/20 border-jb-accent/40 text-jb-accent'
              : 'bg-white/[0.02] border-white/[0.04] text-white/30'
          )}
        >
          <Save size={12} />
          {dirty ? 'Save' : 'Saved'}
        </button>
        <span className="text-[10px] text-white/30 tabular-nums">
          {activeDoc ? `${activeDoc.nodes.length} nodes • ${activeDoc.edges.length} edges` : ''}
        </span>
      </div>
    </div>
  );
};
