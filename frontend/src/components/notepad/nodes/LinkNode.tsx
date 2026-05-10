import React, { useState, useEffect, useRef } from 'react';
import { Handle, Position, NodeProps, NodeResizer } from '@xyflow/react';
import { useAppStore } from '../../../store/useAppStore';
import { ChatService } from '../../../services/ChatService';
import { cn } from '../../../lib/utils';
import { Link as LinkIcon, ExternalLink, Pencil, Loader2, AlertCircle } from 'lucide-react';

interface LinkNodeData {
  url?: string;
  title?: string;
  text?: string;
  og?: NotepadLinkPreview;
}

const safeHostname = (raw: string | undefined): string => {
  if (!raw) return '';
  try { return new URL(raw).hostname; } catch { return raw; }
};

const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000; // refetch after a week

export const LinkNode: React.FC<NodeProps> = ({ id, data, selected }) => {
  const d = data as LinkNodeData;
  const [editing, setEditing] = useState(!d.url);
  const [urlDraft, setUrlDraft] = useState(d.url ?? '');
  const [titleDraft, setTitleDraft] = useState(d.title ?? '');
  const [fetching, setFetching] = useState(false);
  const inflight = useRef<string | null>(null);
  const updateActive = useAppStore((s) => s.notepadUpdateActive);

  const persistOg = (og: NotepadLinkPreview | undefined) => {
    updateActive(
      (doc) => ({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, og } } : n)),
      }),
      { transient: true } // don't burn an undo step on background metadata
    );
  };

  // Fetch OG preview when URL is committed (and on first mount if URL is set but stale).
  useEffect(() => {
    if (!d.url) return;
    const cached = d.og;
    const fresh = cached && Date.now() - cached.fetchedAt < PREVIEW_TTL_MS && !cached.error;
    if (fresh) return;
    if (inflight.current === d.url) return;

    inflight.current = d.url;
    setFetching(true);
    ChatService.fetchLinkPreview(d.url)
      .then((preview) => {
        persistOg({ ...preview, fetchedAt: Date.now() });
      })
      .catch((err) => {
        persistOg({ fetchedAt: Date.now(), error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        setFetching(false);
        inflight.current = null;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.url]);

  const commit = () => {
    updateActive((doc) => ({
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, url: urlDraft.trim(), title: titleDraft.trim(), og: undefined } }
          : n
      ),
    }));
    setEditing(false);
  };

  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (d.url) window.open(d.url, '_blank', 'noopener,noreferrer');
  };

  const og = d.og;
  const displayTitle = d.title || og?.title || safeHostname(d.url) || 'Untitled link';
  const hasError = og?.error && !og.title;

  return (
    <div
      className={cn(
        'rounded-2xl border border-jb-accent/30 bg-jb-accent/[0.04] backdrop-blur-md shadow-xl w-full h-full overflow-hidden flex flex-col',
        selected && 'ring-1 ring-jb-accent/50'
      )}
      onDoubleClick={() => !editing && setEditing(true)}
    >
      <NodeResizer minWidth={220} minHeight={120} isVisible={!!selected} lineClassName="!border-jb-accent/40" handleClassName="!w-2 !h-2 !bg-jb-accent" />

      <Handle type="target" position={Position.Top} className="!w-2 !h-2 !bg-white/30 !border-0" />
      <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-white/30 !border-0" />
      <Handle type="source" position={Position.Bottom} className="!w-2 !h-2 !bg-jb-accent !border-0" />
      <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-jb-accent !border-0" />

      {editing ? (
        <div className="nodrag p-3 flex flex-col gap-2 h-full">
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="Title (optional — fetched from page if empty)"
            className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[12px] text-slate-200 outline-none focus:border-jb-accent/50"
          />
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            placeholder="https://…"
            autoFocus
            className="w-full bg-black/40 border border-white/10 rounded px-2 py-1 text-[11px] font-mono text-slate-300 outline-none focus:border-jb-accent/50"
          />
          <div className="flex justify-end gap-2 mt-auto">
            <button onClick={() => setEditing(false)} className="text-[10px] text-slate-500 hover:text-white/70 px-2 py-1">Cancel</button>
            <button onClick={commit} className="text-[10px] text-jb-accent hover:text-white px-2 py-1 rounded bg-jb-accent/10 hover:bg-jb-accent/20">Save</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col h-full">
          {og?.image && !hasError && (
            <div className="shrink-0 h-24 bg-black/60 overflow-hidden border-b border-white/5 relative">
              <img
                src={og.image}
                alt=""
                className="w-full h-full object-cover"
                draggable={false}
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            </div>
          )}

          <div className="flex-1 min-h-0 p-3 flex flex-col gap-1.5 overflow-hidden">
            <div className="flex items-center gap-2 text-jb-accent shrink-0">
              {og?.favicon ? (
                <img
                  src={og.favicon}
                  alt=""
                  className="w-3 h-3 rounded-sm shrink-0"
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <LinkIcon size={12} className="shrink-0" />
              )}
              <span className="text-[10px] uppercase tracking-widest font-bold truncate">
                {og?.siteName || safeHostname(d.url) || 'Link'}
              </span>
              {fetching && <Loader2 size={10} className="animate-spin text-white/40 shrink-0" />}
              {hasError && <AlertCircle size={10} className="text-amber-400 shrink-0" />}
              <button
                onClick={() => setEditing(true)}
                className="ml-auto text-white/30 hover:text-white/70"
                title="Edit"
              >
                <Pencil size={11} />
              </button>
            </div>

            <div className="text-[12px] font-semibold text-slate-200 line-clamp-2 leading-snug shrink-0">
              {displayTitle}
            </div>

            {og?.description && !hasError && (
              <div className="text-[10px] text-slate-400 line-clamp-3 leading-[1.5] flex-1 min-h-0 overflow-hidden">
                {og.description}
              </div>
            )}

            {d.url && (
              <button
                onClick={open}
                className="mt-auto flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-jb-accent transition-colors truncate shrink-0"
                title={d.url}
              >
                <ExternalLink size={10} className="shrink-0" />
                <span className="truncate font-mono">{safeHostname(d.url)}</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
