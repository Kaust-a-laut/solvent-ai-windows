import { StateCreator } from 'zustand';
import { AppState, Message } from './types';
import { api } from '../lib/api';
import { generateUUID } from '../lib/crypto';

export interface ChatSlice {
  sessions: Record<string, Message[]>;
  messages: Message[]; // Current active messages
  codingMessages: Message[]; // Legacy/Specific for coding if needed
  // Keyed by mode (mirrors `sessions`) so an in-flight request in one mode
  // doesn't show "thinking"/block input in an unrelated mode.
  isProcessingByMode: Record<string, boolean>;
  lastGeneratedImage: string | null;
  currentSessionId: string | null;
  pendingPrompt: string | null;
  addMessage: (message: Message, target?: string) => void;
  setMessages: (messages: Message[], target?: string) => void;
  setIsProcessing: (isProcessing: boolean, mode?: string) => void;
  setLastGeneratedImage: (url: string | null) => void;
  setPendingPrompt: (prompt: string | null) => void;
  persistSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  listSessions: (mode?: string) => Promise<unknown[]>;
  deleteSession: (sessionId: string) => Promise<void>;
  forkFromMessage: (messageId: string) => string;
  setCurrentSessionId: (id: string | null) => void;
}

// A long-running or reloaded-and-reused session would otherwise grow this
// array unboundedly — mirrors the capped-array pattern already used for
// agentMessages/terminalLines/previewConsoleBuffer in codingSlice.ts.
const MAX_SESSION_MESSAGES = 500;

export const createChatSlice: StateCreator<AppState, [], [], ChatSlice> = (set, get) => ({
  sessions: {},
  messages: [],
  codingMessages: [],
  isProcessingByMode: {},
  lastGeneratedImage: null,
  currentSessionId: null,
  pendingPrompt: null,

  setPendingPrompt: (prompt) => set({ pendingPrompt: prompt }),

  addMessage: (message, target) => set((state) => {
    const activeMode = target || state.currentMode;
    const currentMessages = state.sessions[activeMode] || [];
    const withCreatedAt = message.createdAt !== undefined ? message : { ...message, createdAt: Date.now() };
    const msgWithId = withCreatedAt.id ? withCreatedAt : { ...withCreatedAt, id: generateUUID() };
    const newMessages = [...currentMessages, msgWithId].slice(-MAX_SESSION_MESSAGES);

    return {
      sessions: { ...state.sessions, [activeMode]: newMessages },
      messages: activeMode === state.currentMode ? newMessages : state.messages
    };
  }),

  setMessages: (messages, target) => set((state) => {
    const activeMode = target || state.currentMode;
    return {
      sessions: { ...state.sessions, [activeMode]: messages },
      messages: activeMode === state.currentMode ? messages : state.messages
    };
  }),

  setIsProcessing: (isProcessing, mode) => set((state) => ({
    isProcessingByMode: { ...state.isProcessingByMode, [mode ?? state.currentMode]: isProcessing }
  })),
  setLastGeneratedImage: (url) => set({ lastGeneratedImage: url }),

  setCurrentSessionId: (id) => set({ currentSessionId: id }),

  persistSession: async () => {
    const state = get();
    const messages = state.sessions[state.currentMode] || [];
    const sessionId = state.currentSessionId || generateUUID();

    if (messages.length === 0) return;

    try {
      await api.post('/sessions', {
        id: sessionId,
        mode: state.currentMode,
        messages,
        updatedAt: Date.now(),
        parentSessionId: state.currentSessionId ? undefined : sessionId,
      });
      set({ currentSessionId: sessionId });
    } catch (error) {
      console.error('[chatSlice] Failed to persist session:', error);
    }
  },

  loadSession: async (sessionId: string) => {
    try {
      const response = await api.get<{ id: string; title: string; mode: string; messages: Message[] }>(`/sessions/${sessionId}`);
      const session = response.data;
      
      const messages = session.messages.map((m: Message) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        model: m.model,
        image: m.image,
        thinking: m.thinking,
        isGeneratedImage: m.isGeneratedImage,
        imageUrl: m.imageUrl,
        createdAt: m.createdAt
      }));
      
      set({
        sessions: { ...get().sessions, [sessionId]: messages },
        messages,
        currentSessionId: sessionId
      });
    } catch (error) {
      console.error('[chatSlice] Failed to load session:', error);
      throw error;
    }
  },

  listSessions: async (mode?: string) => {
    try {
      const url = mode ? `/sessions?mode=${encodeURIComponent(mode)}` : '/sessions';
      const response = await api.get<{ sessions: unknown[] }>(url);
      return response.data.sessions;
    } catch (error) {
      console.error('[chatSlice] Failed to list sessions:', error);
      return [];
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await api.delete(`/sessions/${sessionId}`);
      const state = get();
      const newSessions = { ...state.sessions };
      delete newSessions[sessionId];
      set({ sessions: newSessions });
    } catch (error) {
      console.error('[chatSlice] Failed to delete session:', error);
      throw error;
    }
  },

  forkFromMessage: (messageId: string) => {
    const state = get();
    const messages = state.sessions[state.currentMode] || [];
    const messageIndex = messages.findIndex(m => m.id === messageId);

    if (messageIndex === -1) {
      console.error('[chatSlice] Message not found for forking:', messageId);
      return generateUUID();
    }

    // Copy messages up to and including the fork point
    const forkedMessages = messages.slice(0, messageIndex + 1);
    const newSessionId = generateUUID();
    
    set({
      sessions: { ...state.sessions, [newSessionId]: forkedMessages },
      messages: forkedMessages,
      currentSessionId: newSessionId
    });
    
    // Persist the forked session with parent references
    api.post('/sessions', {
      id: newSessionId,
      mode: state.currentMode,
      messages: forkedMessages,
      parentMessageId: messageId,
      parentSessionId: state.currentSessionId || undefined
    }).catch(err => console.error('[chatSlice] Failed to persist fork:', err));
    
    return newSessionId;
  },
});