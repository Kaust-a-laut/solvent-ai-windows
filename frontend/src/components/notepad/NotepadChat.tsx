import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { ChatService, type ChatMessage } from '../../services/ChatService';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Loader2, Sparkles, Trash2, Square } from 'lucide-react';
import { cn } from '../../lib/utils';

const serializeCanvas = (doc: NotepadCanvasDoc | null): string => {
  if (!doc) return '';
  const lines: string[] = [];
  lines.push(`# Canvas: ${doc.title}`);
  lines.push(`Nodes: ${doc.nodes.length} • Edges: ${doc.edges.length}`);
  lines.push('');

  const idIndex = new Map(doc.nodes.map((n, i) => [n.id, i + 1] as const));

  for (const n of doc.nodes) {
    const idx = idIndex.get(n.id);
    if (n.type === 'text') {
      lines.push(`## [${idx}] Note`);
      lines.push(n.data?.text?.trim() || '(empty)');
    } else if (n.type === 'image') {
      lines.push(`## [${idx}] Image`);
      if (n.data?.text) lines.push(`Caption: ${n.data.text}`);
      if (n.data?.src) lines.push(`Path: ${n.data.src}`);
    } else if (n.type === 'link') {
      lines.push(`## [${idx}] Link`);
      if (n.data?.title) lines.push(`Title: ${n.data.title}`);
      if (n.data?.url) lines.push(`URL: ${n.data.url}`);
    } else if (n.type === 'group') {
      lines.push(`## [${idx}] Group: ${n.data?.text || ''}`);
    }
    lines.push('');
  }

  if (doc.edges.length > 0) {
    lines.push('## Connections');
    for (const e of doc.edges) {
      const a = idIndex.get(e.source);
      const b = idIndex.get(e.target);
      if (a && b) lines.push(`- [${a}] → [${b}]${e.label ? ` (${e.label})` : ''}`);
    }
  }

  return lines.join('\n');
};

export const NotepadChat: React.FC = () => {
  const {
    activeDoc, appendChat, updateLastChatTurn, busy, setBusy, abortController,
    selectedCloudModel, selectedLocalModel, selectedCloudProvider, modeConfigs,
    globalProvider, temperature, maxTokens, deviceInfo, apiKeys, thinkingModeEnabled,
    imageProvider, openFiles, activeFile,
  } = useAppStore(
    useShallow((s) => ({
      activeDoc: s.notepadActiveDoc,
      appendChat: s.notepadAppendChatTurn,
      updateLastChatTurn: s.notepadUpdateLastChatTurn,
      busy: s.notepadAiBusy,
      setBusy: s.notepadSetAiBusy,
      abortController: s.notepadAiAbort,
      selectedCloudModel: s.selectedCloudModel,
      selectedLocalModel: s.selectedLocalModel,
      selectedCloudProvider: s.selectedCloudProvider,
      modeConfigs: s.modeConfigs,
      globalProvider: s.globalProvider,
      temperature: s.temperature,
      maxTokens: s.maxTokens,
      deviceInfo: s.deviceInfo,
      apiKeys: s.apiKeys,
      thinkingModeEnabled: s.thinkingModeEnabled,
      imageProvider: s.imageProvider,
      openFiles: s.openFiles,
      activeFile: s.activeFile,
    }))
  );

  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const turns = activeDoc?.chatThread ?? [];

  const canvasContext = useMemo(() => serializeCanvas(activeDoc), [activeDoc]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns.length]);

  const send = async () => {
    const content = draft.trim();
    if (!content || busy || !activeDoc) return;
    setDraft('');

    appendChat({ role: 'user', content, ts: Date.now() });
    appendChat({ role: 'assistant', content: '', ts: Date.now() });

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You are an assistant embedded in a visual canvas notepad. The user pins notes, images, links, and groups onto a board, and you help them search, summarize, or extend the canvas. You see the full canvas content as `notepadContent`. Reference items by their [n] index when answering.',
      },
      ...turns.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
    ];

    const controller = new AbortController();
    setBusy(true, controller);
    try {
      await ChatService.streamMessage(
        {
          messages,
          currentMode: 'notepad',
          modeConfigs,
          selectedLocalModel,
          selectedCloudModel,
          selectedCloudProvider,
          globalProvider,
          temperature,
          maxTokens,
          deviceInfo,
          notepadContent: canvasContext,
          openFiles,
          activeFile,
          apiKeys,
          thinkingModeEnabled,
          imageProvider,
        },
        content,
        {
          onToken: (delta) => {
            updateLastChatTurn((t) => ({ ...t, content: t.content + delta }));
          },
          onError: (msg) => {
            updateLastChatTurn((t) => ({ ...t, content: t.content || `Error: ${msg}` }));
          },
        },
        controller.signal,
      );
      // If the stream produced nothing, surface a fallback.
      updateLastChatTurn((t) => (t.content ? t : { ...t, content: '(no response)' }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const aborted = controller.signal.aborted;
      updateLastChatTurn((t) => ({ ...t, content: t.content || (aborted ? '(stopped)' : `Error: ${msg}`) }));
    } finally {
      setBusy(false, null);
    }
  };

  const stop = () => {
    abortController?.abort();
  };

  const clearThread = () => {
    if (!activeDoc) return;
    if (turns.length === 0) return;
    if (!confirm('Clear chat thread for this canvas?')) return;
    useAppStore.getState().notepadUpdateActive((doc) => ({ ...doc, chatThread: [] }));
  };

  return (
    <div className="w-[360px] shrink-0 flex flex-col border-l border-white/5 bg-black/30 min-h-0">
      <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <Sparkles size={12} className="text-jb-purple" />
          <span className="text-[10px] uppercase tracking-[0.3em] font-black text-slate-300">Canvas AI</span>
        </div>
        <button
          onClick={clearThread}
          disabled={turns.length === 0}
          className="text-white/30 hover:text-rose-400 disabled:opacity-30 transition-colors"
          title="Clear thread"
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto fluid-scrollbar px-3 py-3 space-y-3">
        {turns.length === 0 && (
          <div className="text-[11px] text-white/30 px-3 py-8 text-center">
            Ask about anything on this canvas. Try “summarize”, “what links connect to the design notes?”, or “suggest 3 ideas based on this”.
          </div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={cn(
              'rounded-xl px-3 py-2 text-[12px] leading-[1.55]',
              t.role === 'user'
                ? 'bg-jb-accent/10 border border-jb-accent/20 text-slate-100 ml-6'
                : 'bg-white/[0.03] border border-white/[0.06] text-slate-300 mr-6'
            )}
          >
            <div className="text-[9px] uppercase tracking-widest text-white/40 mb-1">
              {t.role === 'user' ? 'You' : 'AI'}
            </div>
            <div className="prose prose-invert prose-sm max-w-none text-[12px]">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.content}</ReactMarkdown>
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-[11px] text-jb-purple px-3">
            <Loader2 size={12} className="animate-spin" />
            <span>Thinking…</span>
          </div>
        )}
      </div>

      <div className="border-t border-white/5 p-3 shrink-0">
        <div className="flex items-end gap-2 bg-black/40 border border-white/[0.06] rounded-xl px-3 py-2 focus-within:border-jb-accent/40 transition-colors">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder="Search the canvas, ask a question, or extend an idea…"
            rows={2}
            className="flex-1 bg-transparent text-[12px] text-slate-200 outline-none resize-none placeholder:text-white/25"
            disabled={busy}
          />
          {busy ? (
            <button
              onClick={stop}
              className="p-2 rounded-lg bg-rose-500/15 hover:bg-rose-500/30 text-rose-400 transition-colors"
              title="Stop streaming"
            >
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!draft.trim()}
              className="p-2 rounded-lg bg-jb-accent/15 hover:bg-jb-accent/30 text-jb-accent disabled:opacity-30 disabled:hover:bg-jb-accent/15 transition-colors"
              title="Send (Enter)"
            >
              <Send size={14} />
            </button>
          )}
        </div>
        <div className="mt-1.5 text-[9px] text-white/30 px-1">
          Context: {activeDoc ? `${activeDoc.nodes.length} nodes` : 'no canvas loaded'}
        </div>
      </div>
    </div>
  );
};
