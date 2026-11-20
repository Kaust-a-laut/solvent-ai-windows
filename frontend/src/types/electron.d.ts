export {};

declare global {
  interface SupervisorActivity {
    [key: string]: unknown;
  }

  interface SupervisorNudge {
    type: string;
    message: string;
  }

  interface MissionContext {
    mission_id: number;
    goal: string;
    actions: SupervisorActivity[];
    status: string;
  }

  interface SystemTelemetry {
    cpu?: number;
    mem?: number;
    net?: number;
    disk?: number;
  }

  interface Window {
    electron?: {
      platform: string;
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      saveNotepad: (content: string) => void;
      getNotepad: () => Promise<string>;
      syncNotepadToDisk: (content: string) => void;
      onNotepadUpdated: (callback: (content: string) => void) => () => void;
      // Supervisor
      reportActivity: (activity: SupervisorActivity) => void;
      logAction: (action: SupervisorActivity) => void;
      setMissionGoal: (goal: string) => void;
      getMissionContext: () => Promise<MissionContext>;
      onSupervisorNudge: (callback: (nudge: SupervisorNudge) => void) => () => void;
      onSupervisorData: (callback: (data: SupervisorActivity) => void) => () => void;
      onSystemTelemetry: (callback: (stats: SystemTelemetry) => void) => () => void;
      // Window Sync
      setMode: (mode: string) => void;
      onModeChanged: (callback: (mode: string) => void) => () => void;
      // null in dev — the renderer falls back to the backend's /dev-secret
      getSessionSecret: () => Promise<string | null>;
      // Performance tier detection
      getDeviceCapability?: () => Promise<{ ramGB: number; cpuCores: number; hasDiscreteGPU: boolean }>;
      setTelemetryInterval?: (ms: number) => void;
      model: {
        execute: (tier: string, messages: Array<{ role: string; content: string }>) => Promise<unknown>;
        getPreference: (tier: string) => Promise<unknown>;
        setPreference: (tier: string, prefs: Record<string, unknown>) => Promise<void>;
        getUsage: () => Promise<unknown>;
        resetUsage: () => Promise<void>;
        onStatusChange: (callback: (status: { status: string, model: string }) => void) => () => void;
      };
      // Notepad Canvas (multi-doc)
      notepad?: {
        list: () => Promise<Array<{ id: string; title: string; createdAt: number; updatedAt: number }>>;
        create: (title: string) => Promise<NotepadCanvasDoc>;
        load: (id: string) => Promise<NotepadCanvasDoc | null>;
        save: (id: string, doc: NotepadCanvasDoc) => Promise<{ ok: boolean; updatedAt: number }>;
        rename: (id: string, title: string) => Promise<{ ok: boolean }>;
        delete: (id: string) => Promise<{ ok: boolean }>;
        saveImage: (docId: string, base64: string, ext: string) => Promise<{ url: string; path: string }>;
      };
    };
  }

  interface NotepadLinkPreview {
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
    favicon?: string;
    fetchedAt: number;
    error?: string;
  }

  interface NotepadCanvasNode {
    id: string;
    type: 'text' | 'image' | 'link' | 'group';
    position: { x: number; y: number };
    data: {
      text?: string;
      src?: string;
      url?: string;
      title?: string;
      color?: string;
      og?: NotepadLinkPreview;
    };
    width?: number;
    height?: number;
    style?: Record<string, string | number>;
  }

  interface NotepadCanvasEdge {
    id: string;
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
    label?: string;
  }

  interface NotepadChatTurn {
    role: 'user' | 'assistant';
    content: string;
    ts: number;
  }

  interface NotepadCanvasDoc {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    nodes: NotepadCanvasNode[];
    edges: NotepadCanvasEdge[];
    viewport: { x: number; y: number; zoom: number };
    chatThread: NotepadChatTurn[];
  }
}
