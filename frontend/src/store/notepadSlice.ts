import { StateCreator } from 'zustand';
import type { AppState } from './types';

export interface NotepadDocMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

const HISTORY_CAP = 50;

const NEW_DOC_FALLBACK = (): NotepadCanvasDoc => ({
  id: `nb_local_${Date.now().toString(36)}`,
  title: 'Untitled Canvas',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  chatThread: [],
});

const cloneDoc = (doc: NotepadCanvasDoc): NotepadCanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((n) => ({ ...n, data: { ...n.data }, position: { ...n.position } })),
  edges: doc.edges.map((e) => ({ ...e })),
  viewport: { ...doc.viewport },
  chatThread: doc.chatThread.map((t) => ({ ...t })),
});

export interface NotepadUpdateOptions {
  transient?: boolean; // skip history push (for continuous drag/resize)
  skipChat?: boolean;  // when true, the change is only chat-related; skip history (chat doesn't need undo)
}

export interface NotepadSlice {
  notepadDocs: NotepadDocMeta[];
  notepadActiveDocId: string | null;
  notepadActiveDoc: NotepadCanvasDoc | null;
  notepadDirty: boolean;
  notepadLoading: boolean;
  notepadAiBusy: boolean;
  notepadAiAbort: AbortController | null;
  notepadHistoryPast: NotepadCanvasDoc[];
  notepadHistoryFuture: NotepadCanvasDoc[];

  notepadInit: () => Promise<void>;
  notepadCreate: (title?: string) => Promise<NotepadCanvasDoc | null>;
  notepadOpen: (id: string) => Promise<void>;
  notepadRename: (id: string, title: string) => Promise<void>;
  notepadDelete: (id: string) => Promise<void>;
  notepadUpdateActive: (
    mutator: (d: NotepadCanvasDoc) => NotepadCanvasDoc,
    options?: NotepadUpdateOptions
  ) => void;
  notepadUndo: () => void;
  notepadRedo: () => void;
  notepadSave: () => Promise<void>;
  notepadAppendChatTurn: (turn: NotepadChatTurn) => void;
  notepadUpdateLastChatTurn: (mutator: (turn: NotepadChatTurn) => NotepadChatTurn) => void;
  notepadSetAiBusy: (busy: boolean, controller?: AbortController | null) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const createNotepadSlice: StateCreator<AppState, [], [], NotepadSlice> = (set, get) => ({
  notepadDocs: [],
  notepadActiveDocId: null,
  notepadActiveDoc: null,
  notepadDirty: false,
  notepadLoading: false,
  notepadAiBusy: false,
  notepadAiAbort: null,
  notepadHistoryPast: [],
  notepadHistoryFuture: [],

  notepadInit: async () => {
    const api = window.electron?.notepad;
    if (!api) {
      const doc = NEW_DOC_FALLBACK();
      set({
        notepadDocs: [{ id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt }],
        notepadActiveDocId: doc.id,
        notepadActiveDoc: doc,
        notepadHistoryPast: [],
        notepadHistoryFuture: [],
      });
      return;
    }
    set({ notepadLoading: true });
    try {
      let docs = await api.list();
      if (!docs || docs.length === 0) {
        const fresh = await api.create('First Canvas');
        docs = [{ id: fresh.id, title: fresh.title, createdAt: fresh.createdAt, updatedAt: fresh.updatedAt }];
        set({
          notepadDocs: docs, notepadActiveDocId: fresh.id, notepadActiveDoc: fresh,
          notepadDirty: false, notepadHistoryPast: [], notepadHistoryFuture: [],
        });
      } else {
        const first = docs[0];
        const targetId = get().notepadActiveDocId ?? (first ? first.id : null);
        if (!targetId) {
          set({
            notepadDocs: docs, notepadActiveDocId: null, notepadActiveDoc: null,
            notepadDirty: false, notepadHistoryPast: [], notepadHistoryFuture: [],
          });
        } else {
          const doc = await api.load(targetId);
          set({
            notepadDocs: docs, notepadActiveDocId: targetId, notepadActiveDoc: doc,
            notepadDirty: false, notepadHistoryPast: [], notepadHistoryFuture: [],
          });
        }
      }
    } finally {
      set({ notepadLoading: false });
    }
  },

  notepadCreate: async (title) => {
    const api = window.electron?.notepad;
    const safeTitle = title?.trim() || 'Untitled Canvas';
    if (!api) {
      const doc = { ...NEW_DOC_FALLBACK(), title: safeTitle };
      set((s) => ({
        notepadDocs: [{ id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt }, ...s.notepadDocs],
        notepadActiveDocId: doc.id,
        notepadActiveDoc: doc,
        notepadDirty: false,
        notepadHistoryPast: [],
        notepadHistoryFuture: [],
      }));
      return doc;
    }
    const doc = await api.create(safeTitle);
    set((s) => ({
      notepadDocs: [{ id: doc.id, title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt }, ...s.notepadDocs],
      notepadActiveDocId: doc.id,
      notepadActiveDoc: doc,
      notepadDirty: false,
      notepadHistoryPast: [],
      notepadHistoryFuture: [],
    }));
    return doc;
  },

  notepadOpen: async (id) => {
    if (get().notepadDirty) {
      try { await get().notepadSave(); } catch (e) { console.error('[notepad] save before open failed', e); }
    }
    const api = window.electron?.notepad;
    if (!api) return;
    set({ notepadLoading: true });
    try {
      const doc = await api.load(id);
      set({
        notepadActiveDocId: id, notepadActiveDoc: doc, notepadDirty: false,
        notepadHistoryPast: [], notepadHistoryFuture: [],
      });
    } finally {
      set({ notepadLoading: false });
    }
  },

  notepadRename: async (id, title) => {
    const api = window.electron?.notepad;
    if (api) await api.rename(id, title);
    set((s) => ({
      notepadDocs: s.notepadDocs.map((d) => (d.id === id ? { ...d, title, updatedAt: Date.now() } : d)),
      notepadActiveDoc:
        s.notepadActiveDoc && s.notepadActiveDoc.id === id ? { ...s.notepadActiveDoc, title } : s.notepadActiveDoc,
    }));
  },

  notepadDelete: async (id) => {
    const api = window.electron?.notepad;
    if (api) await api.delete(id);
    const remaining = get().notepadDocs.filter((d) => d.id !== id);
    let nextActiveId = get().notepadActiveDocId;
    let nextActive = get().notepadActiveDoc;
    let resetHistory = false;
    if (nextActiveId === id) {
      nextActiveId = remaining[0]?.id ?? null;
      nextActive = null;
      resetHistory = true;
      if (nextActiveId && api) {
        nextActive = await api.load(nextActiveId);
      }
    }
    set({
      notepadDocs: remaining,
      notepadActiveDocId: nextActiveId,
      notepadActiveDoc: nextActive,
      notepadDirty: false,
      ...(resetHistory ? { notepadHistoryPast: [], notepadHistoryFuture: [] } : {}),
    });
  },

  notepadUpdateActive: (mutator, options) => {
    const current = get().notepadActiveDoc;
    if (!current) return;
    const next = mutator(current);
    if (next === current) return;

    set((s) => {
      if (options?.transient || options?.skipChat) {
        return { notepadActiveDoc: next, notepadDirty: true };
      }
      const past = [...s.notepadHistoryPast, cloneDoc(current)];
      while (past.length > HISTORY_CAP) past.shift();
      return {
        notepadActiveDoc: next,
        notepadDirty: true,
        notepadHistoryPast: past,
        notepadHistoryFuture: [],
      };
    });

    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      get().notepadSave().catch((e) => console.error('[notepad] autosave failed', e));
    }, 600);
  },

  notepadUndo: () => {
    const { notepadHistoryPast, notepadActiveDoc } = get();
    if (notepadHistoryPast.length === 0 || !notepadActiveDoc) return;
    const previous = notepadHistoryPast[notepadHistoryPast.length - 1]!;
    const newPast = notepadHistoryPast.slice(0, -1);
    set((s) => ({
      notepadActiveDoc: previous,
      notepadHistoryPast: newPast,
      notepadHistoryFuture: [...s.notepadHistoryFuture, cloneDoc(notepadActiveDoc)],
      notepadDirty: true,
    }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      get().notepadSave().catch((e) => console.error('[notepad] undo-save failed', e));
    }, 600);
  },

  notepadRedo: () => {
    const { notepadHistoryFuture, notepadActiveDoc } = get();
    if (notepadHistoryFuture.length === 0 || !notepadActiveDoc) return;
    const next = notepadHistoryFuture[notepadHistoryFuture.length - 1]!;
    const newFuture = notepadHistoryFuture.slice(0, -1);
    set((s) => ({
      notepadActiveDoc: next,
      notepadHistoryFuture: newFuture,
      notepadHistoryPast: [...s.notepadHistoryPast, cloneDoc(notepadActiveDoc)],
      notepadDirty: true,
    }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      get().notepadSave().catch((e) => console.error('[notepad] redo-save failed', e));
    }, 600);
  },

  notepadSave: async () => {
    const doc = get().notepadActiveDoc;
    if (!doc) return;
    const api = window.electron?.notepad;
    if (api) {
      await api.save(doc.id, doc);
    }
    set((s) => ({
      notepadDirty: false,
      notepadDocs: s.notepadDocs.map((d) => (d.id === doc.id ? { ...d, title: doc.title, updatedAt: Date.now() } : d)),
    }));
  },

  notepadAppendChatTurn: (turn) => {
    const doc = get().notepadActiveDoc;
    if (!doc) return;
    const next = { ...doc, chatThread: [...doc.chatThread, turn] };
    set({ notepadActiveDoc: next, notepadDirty: true });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      get().notepadSave().catch((e) => console.error('[notepad] chat save failed', e));
    }, 400);
  },

  notepadUpdateLastChatTurn: (mutator) => {
    const doc = get().notepadActiveDoc;
    if (!doc || doc.chatThread.length === 0) return;
    const lastIdx = doc.chatThread.length - 1;
    const lastTurn = doc.chatThread[lastIdx]!;
    const updated = mutator(lastTurn);
    const nextThread = [...doc.chatThread.slice(0, lastIdx), updated];
    set({ notepadActiveDoc: { ...doc, chatThread: nextThread }, notepadDirty: true });
  },

  notepadSetAiBusy: (busy, controller) => set({ notepadAiBusy: busy, notepadAiAbort: controller ?? null }),
});
