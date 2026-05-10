import React, { useMemo } from 'react';
import { PenLine, ExternalLink } from 'lucide-react';
import { motion } from 'framer-motion';
import { VIEW_TRANSITION } from './types';
import { useAppStore } from '../../store/useAppStore';

export interface PipNotesViewProps {
  notepadContent: string;
  onContentChange: (v: string) => void;
}

export const PipNotesView: React.FC<PipNotesViewProps> = ({ notepadContent, onContentChange }) => {
  const wordCount = useMemo(() => {
    const trimmed = notepadContent.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }, [notepadContent]);

  const openInNotepad = async () => {
    const store = useAppStore.getState();
    if (notepadContent.trim()) {
      const doc = await store.notepadCreate(`Scratch — ${new Date().toLocaleString()}`);
      if (doc) {
        store.notepadUpdateActive((d) => ({
          ...d,
          nodes: [
            ...d.nodes,
            {
              id: `n_${Date.now().toString(36)}`,
              type: 'text',
              position: { x: 80, y: 80 },
              data: { text: notepadContent },
              width: 360,
              height: 240,
            },
          ],
        }));
      }
    }
    store.setCurrentMode('notepad');
    store.setIsCommandCenterOpen(false);
  };

  return (
    <motion.div
      key="notes"
      {...VIEW_TRANSITION}
      className="flex-1 flex flex-col gap-2 p-3 min-h-0"
    >
      <div className="flex items-center justify-between px-0.5 shrink-0">
        <span className="cc-section-heading">Notes</span>
        <div className="flex items-center gap-3">
          <button
            onClick={openInNotepad}
            className="flex items-center gap-1 text-[9px] font-medium uppercase tracking-wider text-slate-500 hover:text-jb-purple transition-colors"
            title="Open scratch text as a node in the Notepad canvas"
          >
            <ExternalLink size={9} />
            Open in Notepad
          </button>
          {notepadContent && (
            <button
              onClick={() => { onContentChange(''); window.electron?.saveNotepad(''); }}
              className="text-[9px] font-medium uppercase tracking-wider text-slate-600 hover:text-rose-400 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 relative min-h-0">
        <textarea
          value={notepadContent}
          onChange={(e) => { onContentChange(e.target.value); window.electron?.saveNotepad(e.target.value); }}
          className="w-full h-full bg-black/30 border border-white/[0.04] focus:border-white/[0.08] rounded-xl p-3 text-[12px] font-sans leading-[1.7] outline-none resize-none text-slate-300 placeholder:text-white/10 transition-colors fluid-scrollbar"
          placeholder="Mission context, directives, or scratch notes..."
          spellCheck={false}
        />
        {!notepadContent && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <PenLine size={32} className="text-white/[0.04]" />
          </div>
        )}
      </div>
      <div className="flex justify-end px-1 shrink-0">
        <span className="text-[9px] text-white/15 tabular-nums">
          {wordCount > 0 ? `${wordCount} word${wordCount !== 1 ? 's' : ''}` : ''}
        </span>
      </div>
    </motion.div>
  );
};
