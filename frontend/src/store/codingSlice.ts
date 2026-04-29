import { StateCreator } from 'zustand';
import { AppState } from './types';
import { BASE_URL } from '../lib/config';
import { getSecret } from '../lib/api-client';
import { useAppStore } from './useAppStore';

// --- Project Management Types ---

export interface ProjectInfo {
  name: string;
  path: string;
  type: 'scratchpad' | 'folder';
  createdAt: number;
  lastOpenedAt: number;
}

const PROJECT_HISTORY_KEY = 'solvent-project-history';
const PROJECT_STATE_KEY = 'solvent-project-open-state';
const MAX_HISTORY = 10;

/** Persists which files were open for a project (paths only — content lives on the backend). */
export function persistProjectOpenState(
  projectKey: string,
  openFilePaths: string[],
  activeFile: string | null
): void {
  if (typeof window === 'undefined') return;
  try {
    const all = JSON.parse(localStorage.getItem(PROJECT_STATE_KEY) || '{}');
    all[projectKey] = { openFilePaths, activeFile, savedAt: Date.now() };
    localStorage.setItem(PROJECT_STATE_KEY, JSON.stringify(all));
  } catch {}
}

/** Returns the last-saved open file list for a project, or null if none. */
export function restoreProjectOpenState(
  projectKey: string
): { openFilePaths: string[]; activeFile: string | null } | null {
  if (typeof window === 'undefined') return null;
  try {
    const all = JSON.parse(localStorage.getItem(PROJECT_STATE_KEY) || '{}');
    return (all[projectKey] as { openFilePaths: string[]; activeFile: string | null }) ?? null;
  } catch { return null; }
}

const savedHistory = typeof window !== 'undefined'
  ? (() => {
      try {
        return JSON.parse(localStorage.getItem(PROJECT_HISTORY_KEY) || '[]');
      } catch {
        return [];
      }
    })()
  : [];

function persistHistory(history: ProjectInfo[]): void {
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(PROJECT_HISTORY_KEY, JSON.stringify(history));
    } catch {}
  }
}

// --- Agent Chat Persistence ---

const AGENT_CHAT_KEY = 'solvent-agent-chat';
const MAX_PERSISTED_MESSAGES = 50;

function truncateEventResult(e: ToolEvent): ToolEvent {
  if (typeof e.result === 'string' && e.result.length > 500) {
    return { ...e, result: e.result.slice(0, 500) + '… [truncated]' };
  }
  return e;
}

/** Persists the last N agent messages for a project to localStorage. */
export function persistAgentMessages(projectKey: string, messages: AgentMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    const toSave = messages
      .filter(m => !m.isStreaming)
      .slice(-MAX_PERSISTED_MESSAGES)
      .map(m => {
        // Iterations are authoritative — persist them. toolEvents is no longer written.
        const iterations = m.iterations?.map(it => ({
          ...it,
          toolEvents: it.toolEvents.map(truncateEventResult),
        }));
        // Legacy messages without iterations: keep truncated toolEvents as-is.
        const legacyToolEvents = !iterations && m.toolEvents
          ? m.toolEvents.map(truncateEventResult)
          : undefined;
        return {
          ...m,
          iterations,
          toolEvents: legacyToolEvents,
        };
      });
    const all = JSON.parse(localStorage.getItem(AGENT_CHAT_KEY) || '{}');
    all[projectKey] = { messages: toSave, savedAt: Date.now() };
    localStorage.setItem(AGENT_CHAT_KEY, JSON.stringify(all));
  } catch {}
}

/** Returns persisted agent messages for a project, or null if none. */
export function restoreAgentMessages(projectKey: string): AgentMessage[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const all = JSON.parse(localStorage.getItem(AGENT_CHAT_KEY) || '{}');
    return (all[projectKey]?.messages as AgentMessage[]) ?? null;
  } catch {
    return null;
  }
}

// --- File Tree Node (shared between CodingSlice and FileTreePanel) ---

export interface FileNode {
  name: string;
  type: 'file' | 'directory';
  path: string;
  children?: FileNode[];
}

// --- Tool Event Types (mirror backend AgentEvent types) ---

export interface ToolEvent {
  type: 'tool_start' | 'tool_result' | 'tool_error';
  tool: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  iteration: number;
  callId: string;
  /** Snapshot of the file content before a write-tool ran, captured at tool_start. */
  beforeContent?: string;
}

export interface AgentIteration {
  index: number;
  text: string;             // accumulated text_delta content for this model response
  toolEvents: ToolEvent[];  // tool calls executed during this iteration
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  fileContext?: string;
  codeBlocks?: CodeSuggestion[];     // kept for persistence compat, no longer rendered
  toolEvents?: ToolEvent[];          // LEGACY — only populated on messages persisted before iterations became authoritative
  isStreaming?: boolean;
  iterations?: AgentIteration[];     // source of truth for rendering and persistence
}

export interface CodeSuggestion {
  id: string;
  language: string;
  code: string;
  applied: boolean;
  rejected: boolean;
}

export interface PendingDiff {
  original: string;
  modified: string;
  filePath: string;
  description: string;
}

export interface StagedDiff {
  filePath: string;
  original: string;
  modified: string;
  description: string;
  callId: string;
  status: 'pending' | 'approved' | 'rejected';
}

// --- Preview Runtime State Types (Phase 2) ---

export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

export interface ElementInfo {
  tag: string;
  id?: string;
  classes: string[];
  text: string;
  dataAttrs: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

export interface AgentPlanStep {
  id: string;
  title: string;
  status: string;
  notes?: string;
}

export interface AgentPlan {
  steps: AgentPlanStep[];
}

export interface CodingSlice {
  pendingDiff: PendingDiff | null;
  stagedDiffs: StagedDiff[];
  agentMessages: AgentMessage[];
  panelWidths: { fileTree: number; chat: number };
  fileTreeVisible: boolean;
  chatPanelVisible: boolean;
  terminalVisible: boolean;
  currentProject: ProjectInfo | null;
  projectHistory: ProjectInfo[];

  // Agent plan strip
  agentPlan: AgentPlan | null;
  setAgentPlan: (plan: AgentPlan | null) => void;

  // Terminal lines (shared across CodingArea + agent)
  terminalLines: string[];
  addTerminalLine: (line: string) => void;
  clearTerminalLines: () => void;

  // File tree state (persisted across remounts)
  fileTreeNodes: FileNode[];
  fileTreeExpanded: Record<string, boolean>;
  fileTreeLoading: boolean;
  setFileTreeNodes: (nodes: FileNode[]) => void;
  setFileTreeExpanded: (expanded: Record<string, boolean>) => void;
  setFileTreeLoading: (loading: boolean) => void;
  toggleFileTreeFolder: (path: string) => void;

  // File tree refresh trigger (incremented to signal a refresh)
  fileTreeRefreshTrigger: number;
  triggerFileTreeRefresh: () => void;

  // Sandbox run trigger (incremented by agent ide_run_in_sandbox → CodingArea handleRun)
  sandboxRunTrigger: number;
  requestSandboxRun: () => void;

  // Preview URL (the WebContainer server-ready URL) — shared so AgentChatPanel can read it
  previewUrl: string | null;
  setPreviewUrl: (url: string | null) => void;
  // Latest HTML snapshot of the preview, manually captured by user
  previewSnapshot: string | null;
  setPreviewSnapshot: (snapshot: string | null) => void;

  // Preview runtime state (Phase 2)
  previewConsoleBuffer: ConsoleEntry[];      // ring buffer, max 200
  previewBodyHash: string | null;
  previewBodyHTML: string | null;
  previewDomChanged: boolean;
  previewSelectedElement: ElementInfo | null;
  previewScreenshotUrl: string | null;

  appendConsoleEntry: (entry: ConsoleEntry) => void;
  updatePreviewDom: (data: { hash: string; bodyHTML: string }) => void;
  setSelectedElement: (element: ElementInfo | null) => void;
  setPreviewScreenshotUrl: (url: string | null) => void;
  resetDomChanged: () => void;

  // Preferred code-tier model for delegation
  preferredCodeModel: string | null;
  setPreferredCodeModel: (model: string) => void;

  // Agent busy state — shared so PreviewPanel can show/hide the fix chip
  agentBusy: boolean;
  setAgentBusy: (busy: boolean) => void;
  // Queued agent prompt (e.g. from PreviewPanel's "Ask agent to fix" chip)
  queuedAgentPrompt: string | null;
  setQueuedAgentPrompt: (prompt: string | null) => void;

  // Session token usage tracking (accumulated across agent turns)
  sessionPromptTokens: number;
  sessionCompletionTokens: number;
  sessionCachedTokens: number;
  accumulateTokenUsage: (usage: { promptTokens: number; completionTokens: number; cachedTokens?: number }) => void;
  resetTokenUsage: () => void;

  // Memory panel visibility
  memoryVisible: boolean;
  setMemoryVisible: (visible: boolean) => void;

  // Project file-tree index map (fetched on project open)
  projectMap: string | null;
  setProjectMap: (map: string | null) => void;

  setPendingDiff: (diff: PendingDiff) => void;
  clearPendingDiff: () => void;
  addStagedDiff: (diff: { filePath: string; original: string; modified: string; description: string; callId: string }) => void;
  setStagedDiffStatus: (callId: string, status: 'approved' | 'rejected') => void;
  applyAllStagedDiffs: () => Promise<void>;
  clearStagedDiffs: () => void;
  addAgentMessage: (msg: AgentMessage) => void;
  updateAgentMessage: (
    id: string,
    updates: Partial<AgentMessage> | ((prev: AgentMessage) => Partial<AgentMessage>)
  ) => void;
  clearAgentMessages: () => void;
  /** Truncate messages after the given message ID (for edit-and-rerun). */
  truncateAfterMessage: (messageId: string) => void;
  /** Update a user message's content (for edit-and-rerun). */
  updateUserMessageContent: (id: string, content: string) => void;
  setPanelWidths: (widths: { fileTree: number; chat: number }) => void;
  setFileTreeVisible: (v: boolean) => void;
  setChatPanelVisible: (v: boolean) => void;
  setTerminalVisible: (v: boolean) => void;
  createNewProject: (name: string) => void;
  openProject: (name: string) => void;
  openFolder: (path: string) => void;
  closeProject: () => void;
}

const MAX_TERMINAL_LINES = 1000;
const MAX_AGENT_MESSAGES = 100;
/** Strip ANSI escape codes (color/bold/cursor) from terminal output. */
export function stripAnsi(input: string): string {
  return input.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

export const createCodingSlice: StateCreator<AppState, [], [], CodingSlice> = (set) => {
  const MAX_CONSOLE_BUFFER = 200;

  return ({
  pendingDiff: null,
  stagedDiffs: [],
  agentMessages: [],
  panelWidths: { fileTree: 240, chat: 360 },
  fileTreeVisible: true,
  chatPanelVisible: true,
  terminalVisible: false,
  currentProject: null,
  projectHistory: savedHistory,

  agentPlan: null,
  setAgentPlan: (agentPlan) => set({ agentPlan }),

  terminalLines: ['[SYSTEM]: Agentic IDE Core Initialized.'],
  addTerminalLine: (line) => set((state) => {
    const cleaned = stripAnsi(line);
    const lines = [...state.terminalLines, cleaned];
    if (lines.length > MAX_TERMINAL_LINES) {
      return { terminalLines: lines.slice(-MAX_TERMINAL_LINES) };
    }
    return { terminalLines: lines };
  }),
  clearTerminalLines: () => set({ terminalLines: [] }),

  fileTreeNodes: [],
  fileTreeExpanded: {},
  fileTreeLoading: false,
  setFileTreeNodes: (fileTreeNodes) => set({ fileTreeNodes }),
  setFileTreeExpanded: (fileTreeExpanded) => set({ fileTreeExpanded }),
  setFileTreeLoading: (fileTreeLoading) => set({ fileTreeLoading }),
  toggleFileTreeFolder: (path) => set((state) => ({
    fileTreeExpanded: { ...state.fileTreeExpanded, [path]: !state.fileTreeExpanded[path] },
  })),

  fileTreeRefreshTrigger: 0,
  triggerFileTreeRefresh: () => set((state) => ({ fileTreeRefreshTrigger: state.fileTreeRefreshTrigger + 1 })),

  sandboxRunTrigger: 0,
  requestSandboxRun: () => set((state) => ({ sandboxRunTrigger: state.sandboxRunTrigger + 1 })),

  previewUrl: null,
  setPreviewUrl: (previewUrl) => set({ previewUrl }),
  previewSnapshot: null,
  setPreviewSnapshot: (previewSnapshot) => set({ previewSnapshot }),

  previewConsoleBuffer: [],
  previewBodyHash: null,
  previewBodyHTML: null,
  previewDomChanged: false,
  previewSelectedElement: null,
  previewScreenshotUrl: null,

  setPendingDiff: (diff) => set((state) => {
    // Also stage it for the new multi-file tray
    const staged: StagedDiff = {
      ...diff,
      callId: `pending-${Date.now()}`,
      status: 'pending',
    };
    return {
      pendingDiff: diff,
      stagedDiffs: [...state.stagedDiffs.filter(d => d.filePath !== diff.filePath), staged],
    };
  }),
  clearPendingDiff: () => set({ pendingDiff: null }),
  addStagedDiff: (diff) => set((state) => ({
    stagedDiffs: [...state.stagedDiffs.filter(d => d.filePath !== diff.filePath), { ...diff, status: 'pending' }],
  })),
  setStagedDiffStatus: (callId, status) => set((state) => ({
    stagedDiffs: state.stagedDiffs.map(d => d.callId === callId ? { ...d, status } : d),
  })),
  applyAllStagedDiffs: async () => {
    const state = useAppStore.getState();
    const approved = state.stagedDiffs.filter(d => d.status === 'approved' || d.status === 'pending');
    for (const diff of approved) {
      try {
        // Write to backend
        const secret = await getSecret();
        await fetch(`${BASE_URL}/api/files/write`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Solvent-Secret': secret },
          body: JSON.stringify({ path: diff.filePath, content: diff.modified, project: state.currentProject?.path }),
        });
        // Update openFiles
        const currentFiles = useAppStore.getState().openFiles;
        useAppStore.getState().setOpenFiles(
          currentFiles.map(f => f.path === diff.filePath ? { ...f, content: diff.modified } : f)
        );
      } catch {
        // Silently fail — the diff stays in the list
      }
    }
    set({ stagedDiffs: [], pendingDiff: null });
  },
  clearStagedDiffs: () => set({ stagedDiffs: [], pendingDiff: null }),
  addAgentMessage: (msg) => set((state) => {
    const messages = [...state.agentMessages, msg];
    // Cap in-memory messages — oldest are dropped (persistence already caps at 50).
    if (messages.length > MAX_AGENT_MESSAGES) {
      return { agentMessages: messages.slice(-MAX_AGENT_MESSAGES) };
    }
    return { agentMessages: messages };
  }),
  updateAgentMessage: (id, updates) =>
    set((state) => ({
      agentMessages: state.agentMessages.map((m) =>
        m.id === id
          ? { ...m, ...(typeof updates === 'function' ? updates(m) : updates) }
          : m
      ),
    })),
  clearAgentMessages: () => set({ agentMessages: [], agentPlan: null }),
  truncateAfterMessage: (messageId) => set((state) => {
    const idx = state.agentMessages.findIndex(m => m.id === messageId);
    if (idx === -1) return state;
    return { agentMessages: state.agentMessages.slice(0, idx + 1) };
  }),
  updateUserMessageContent: (id, content) => set((state) => ({
    agentMessages: state.agentMessages.map(m =>
      m.id === id ? { ...m, content } : m
    ),
  })),
  setPanelWidths: (panelWidths) => set({ panelWidths }),
  setFileTreeVisible: (fileTreeVisible) => set({ fileTreeVisible }),
  setChatPanelVisible: (chatPanelVisible) => set({ chatPanelVisible }),
  setTerminalVisible: (terminalVisible) => set({ terminalVisible }),

  appendConsoleEntry: (entry) => set((state) => {
    const buffer = [...state.previewConsoleBuffer, entry];
    return { previewConsoleBuffer: buffer.slice(-MAX_CONSOLE_BUFFER) };
  }),
  updatePreviewDom: (data) => set({
    previewBodyHash: data.hash,
    previewBodyHTML: data.bodyHTML.slice(0, 50000),
    previewDomChanged: true,
  }),
  setSelectedElement: (element) => set({ previewSelectedElement: element }),
  setPreviewScreenshotUrl: (url) => set({ previewScreenshotUrl: url }),
  resetDomChanged: () => set({ previewDomChanged: false }),

  preferredCodeModel: null,
  setPreferredCodeModel: (preferredCodeModel) => set({ preferredCodeModel }),

  agentBusy: false,
  setAgentBusy: (agentBusy) => set({ agentBusy }),

  queuedAgentPrompt: null,
  setQueuedAgentPrompt: (queuedAgentPrompt) => set({ queuedAgentPrompt }),

  sessionPromptTokens: 0,
  sessionCompletionTokens: 0,
  sessionCachedTokens: 0,
  accumulateTokenUsage: (usage) => set((state) => ({
    sessionPromptTokens: state.sessionPromptTokens + usage.promptTokens,
    sessionCompletionTokens: state.sessionCompletionTokens + usage.completionTokens,
    sessionCachedTokens: state.sessionCachedTokens + (usage.cachedTokens ?? 0),
  })),
  resetTokenUsage: () => set({ sessionPromptTokens: 0, sessionCompletionTokens: 0, sessionCachedTokens: 0 }),

  memoryVisible: false,
  setMemoryVisible: (memoryVisible) => set({ memoryVisible }),

  projectMap: null,
  setProjectMap: (map) => set({ projectMap: map }),

  createNewProject: (name) => {
    const now = Date.now();
    const newProject: ProjectInfo = {
      name,
      path: `projects/${name}`,
      type: 'scratchpad',
      createdAt: now,
      lastOpenedAt: now,
    };
    set((state) => {
      const filtered = state.projectHistory.filter((p) => p.name !== name);
      const updated = [newProject, ...filtered].slice(0, MAX_HISTORY);
      persistHistory(updated);
      return { currentProject: newProject, projectHistory: updated };
    });
  },

  openProject: (name) => {
    set((state) => {
      const now = Date.now();
      const existing = state.projectHistory.find((p) => p.name === name);
      let project: ProjectInfo;
      if (existing) {
        project = { ...existing, lastOpenedAt: now };
        const filtered = state.projectHistory.filter((p) => p.name !== name);
        const updated = [project, ...filtered].slice(0, MAX_HISTORY);
        persistHistory(updated);
        return { currentProject: project, projectHistory: updated };
      } else {
        project = {
          name,
          path: `projects/${name}`,
          type: 'scratchpad',
          createdAt: now,
          lastOpenedAt: now,
        };
        const updated = [project, ...state.projectHistory].slice(0, MAX_HISTORY);
        persistHistory(updated);
        return { currentProject: project, projectHistory: updated };
      }
    });
  },

  openFolder: (path) => {
    const now = Date.now();
    const pathParts = path.split('/');
    const name = pathParts[pathParts.length - 1] || path;
    const newProject: ProjectInfo = {
      name,
      path,
      type: 'folder',
      createdAt: now,
      lastOpenedAt: now,
    };
    set((state) => {
      const filtered = state.projectHistory.filter((p) => p.path !== path);
      const updated = [newProject, ...filtered].slice(0, MAX_HISTORY);
      persistHistory(updated);
      return { currentProject: newProject, projectHistory: updated };
    });
  },

  closeProject: () => {
    set({ currentProject: null, openFiles: [], activeFile: null, fileTreeNodes: [], fileTreeExpanded: {} });
  },
  });
};
