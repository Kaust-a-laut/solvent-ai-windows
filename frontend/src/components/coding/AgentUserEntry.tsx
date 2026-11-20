import React, { useState, useRef, useEffect } from 'react';
import { Pencil, Check, X } from 'lucide-react';
import type { AgentMessage } from '../../store/codingSlice';

interface Props {
  msg: AgentMessage;
  /** Called when user saves an edit — truncates history after this message and re-sends. */
  onEditAndRerun?: (messageId: string, newContent: string) => void;
}

export const AgentUserEntry: React.FC<Props> = ({ msg, onEditAndRerun }) => {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(msg.content);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  // After the hooks — an early return above them violates the Rules of Hooks
  // (hook order must be identical on every render).
  if (msg.content.startsWith('[build_check')) return null;

  const handleStartEdit = () => {
    setEditText(msg.content);
    setEditing(true);
  };

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== msg.content && onEditAndRerun) {
      onEditAndRerun(msg.id, trimmed);
    }
    setEditing(false);
  };

  const handleCancelEdit = () => {
    setEditing(false);
    setEditText(msg.content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSaveEdit();
    } else if (e.key === 'Escape') {
      handleCancelEdit();
    }
  };

  return (
    <div className="flex flex-col items-end max-w-[80%] ml-auto group">
      {msg.fileContext && (
        <span className="text-[10px] text-white/40 mb-1 px-2">
          with context: {msg.fileContext}
        </span>
      )}
      <div className="relative rounded-2xl px-4 py-2 bg-jb-accent/10 border border-jb-accent/20 text-[12px] text-slate-200">
        {editing ? (
          <div className="flex flex-col gap-2">
            <textarea
              ref={editRef}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={3}
              className="bg-white/[0.05] border border-white/[0.08] rounded-lg px-3 py-1.5 text-[12px] text-slate-200 outline-none resize-y min-h-[60px] max-h-[200px]"
            />
            <div className="flex items-center gap-1.5 justify-end">
              <button
                type="button"
                onClick={handleCancelEdit}
                className="p-1 rounded hover:bg-white/[0.06] text-white/40 hover:text-white/60 transition-colors"
                title="Cancel (Esc)"
              >
                <X size={12} />
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                className="p-1 rounded hover:bg-jb-accent/20 text-jb-accent hover:text-jb-accent/80 transition-colors"
                title="Save & re-run (Enter)"
              >
                <Check size={12} />
              </button>
            </div>
          </div>
        ) : (
          <>
            <span className="whitespace-pre-wrap">{msg.content}</span>
            {onEditAndRerun && (
              <button
                type="button"
                onClick={handleStartEdit}
                className="absolute -top-1 -right-1 p-1 rounded bg-jb-panel border border-white/[0.06] text-white/20 hover:text-white/60 opacity-0 group-hover:opacity-100 transition-all"
                title="Edit and re-run"
              >
                <Pencil size={10} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
