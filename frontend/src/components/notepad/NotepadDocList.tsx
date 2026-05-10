import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { Plus, FileText, Trash2, Pencil, Check, X as Cross, Search } from 'lucide-react';
import { cn } from '../../lib/utils';

const fmtRelative = (ts: number): string => {
  const diff = Date.now() - ts;
  const m = 60 * 1000;
  const h = 60 * m;
  const d = 24 * h;
  if (diff < m) return 'just now';
  if (diff < h) return `${Math.floor(diff / m)}m`;
  if (diff < d) return `${Math.floor(diff / h)}h`;
  return `${Math.floor(diff / d)}d`;
};

export const NotepadDocList: React.FC = () => {
  const { docs, activeId, create, open, rename, del } = useAppStore(
    useShallow((s) => ({
      docs: s.notepadDocs,
      activeId: s.notepadActiveDocId,
      create: s.notepadCreate,
      open: s.notepadOpen,
      rename: s.notepadRename,
      del: s.notepadDelete,
    }))
  );
  const [filter, setFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const filtered = docs.filter((d) => d.title.toLowerCase().includes(filter.toLowerCase()));

  const startRename = (id: string, currentTitle: string) => {
    setEditingId(id);
    setDraftTitle(currentTitle);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const title = draftTitle.trim() || 'Untitled Canvas';
    await rename(editingId, title);
    setEditingId(null);
  };

  const handleDelete = async (id: string, title: string) => {
    if (docs.length <= 1) return;
    if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
    await del(id);
  };

  return (
    <div className="w-64 shrink-0 flex flex-col border-r border-white/5 bg-black/30 min-h-0">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between shrink-0">
        <span className="text-[10px] uppercase tracking-[0.3em] font-black text-slate-300">Canvases</span>
        <button
          onClick={() => create()}
          className="text-slate-300 hover:text-white p-1 rounded hover:bg-white/5 transition-colors"
          title="New canvas"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-2 bg-black/40 border border-white/[0.06] rounded-lg px-2 py-1.5">
          <Search size={12} className="text-white/30" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="flex-1 bg-transparent outline-none text-[11px] text-slate-300 placeholder:text-white/20"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto fluid-scrollbar p-2 space-y-0.5">
        {filtered.length === 0 && (
          <div className="text-[10px] text-white/30 px-3 py-6 text-center">No canvases match.</div>
        )}
        {filtered.map((doc) => {
          const isActive = doc.id === activeId;
          const isEditing = doc.id === editingId;
          return (
            <div
              key={doc.id}
              className={cn(
                'group rounded-lg border transition-colors px-2 py-2 cursor-pointer relative',
                isActive
                  ? 'border-jb-accent/40 bg-jb-accent/[0.06]'
                  : 'border-transparent hover:border-white/10 hover:bg-white/[0.02]'
              )}
              onClick={() => !isEditing && open(doc.id)}
            >
              <div className="flex items-start gap-2">
                <FileText size={12} className={cn('mt-0.5 shrink-0', isActive ? 'text-jb-accent' : 'text-white/40')} />
                <div className="flex-1 min-w-0">
                  {isEditing ? (
                    <input
                      value={draftTitle}
                      onChange={(e) => setDraftTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      onBlur={commitRename}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      className="w-full bg-black/40 border border-white/10 rounded px-1.5 py-0.5 text-[12px] text-slate-100 outline-none focus:border-jb-accent/50"
                    />
                  ) : (
                    <div className="text-[12px] font-semibold text-slate-200 truncate">{doc.title}</div>
                  )}
                  <div className="text-[9px] text-white/30 tabular-nums mt-0.5">Updated {fmtRelative(doc.updatedAt)}</div>
                </div>
                {!isEditing && (
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => { e.stopPropagation(); startRename(doc.id, doc.title); }}
                      className="p-1 text-white/30 hover:text-white"
                      title="Rename"
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(doc.id, doc.title); }}
                      disabled={docs.length <= 1}
                      className="p-1 text-white/30 hover:text-rose-400 disabled:opacity-30 disabled:hover:text-white/30"
                      title="Delete"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                )}
                {isEditing && (
                  <div className="flex items-center gap-0.5">
                    <button onClick={(e) => { e.stopPropagation(); commitRename(); }} className="p-1 text-emerald-400">
                      <Check size={10} />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); setEditingId(null); }} className="p-1 text-white/40">
                      <Cross size={10} />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
