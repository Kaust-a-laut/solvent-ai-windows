import React, { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { NotepadDocList } from './NotepadDocList';
import { NotepadCanvas } from './NotepadCanvas';
import { NotepadChat } from './NotepadChat';
import { NotepadToolbar } from './NotepadToolbar';
import { Loader2, NotebookPen } from 'lucide-react';

export const NotepadArea: React.FC = () => {
  const { activeDoc, loading, init, rename } = useAppStore(
    useShallow((s) => ({
      activeDoc: s.notepadActiveDoc,
      loading: s.notepadLoading,
      init: s.notepadInit,
      rename: s.notepadRename,
    }))
  );

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div className="flex-1 flex min-h-0 overflow-hidden bg-[#050508]">
      <NotepadDocList />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="px-5 py-3 border-b border-white/5 flex items-center gap-3 shrink-0">
          <NotebookPen size={14} className="text-jb-purple" />
          {activeDoc ? (
            <input
              key={activeDoc.id}
              defaultValue={activeDoc.title}
              onBlur={(e) => {
                const v = e.target.value.trim() || 'Untitled Canvas';
                if (v !== activeDoc.title) rename(activeDoc.id, v);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              className="flex-1 bg-transparent text-[14px] font-bold tracking-tight text-slate-100 outline-none border-b border-transparent focus:border-jb-accent/40 transition-colors"
            />
          ) : (
            <span className="text-[14px] font-bold text-slate-500">Notepad</span>
          )}
          <span className="text-[9px] uppercase tracking-[0.3em] text-white/30 font-black">Canvas</span>
        </div>

        <ReactFlowProvider key={activeDoc?.id ?? 'empty'}>
          <NotepadToolbar />
          {loading && !activeDoc ? (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : !activeDoc ? (
            <div className="flex-1 flex items-center justify-center text-[11px] text-white/30 uppercase tracking-widest">
              No canvas selected
            </div>
          ) : (
            <NotepadCanvas />
          )}
        </ReactFlowProvider>
      </div>

      <NotepadChat />
    </div>
  );
};
