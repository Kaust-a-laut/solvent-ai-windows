export {};

declare global {
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
      reportActivity: (activity: any) => void;
      logAction: (action: any) => void;
      setMissionGoal: (goal: string) => void;
      getMissionContext: () => Promise<any>;
      onSupervisorNudge: (callback: (nudge: any) => void) => () => void;
      onSupervisorData: (callback: (data: any) => void) => () => void;
      onSystemTelemetry: (callback: (stats: any) => void) => () => void;
      // Window Sync
      setMode: (mode: string) => void;
      onModeChanged: (callback: (mode: string) => void) => () => void;
      getSessionSecret: () => Promise<string>;
      model: {
        execute: (tier: string, messages: any[]) => Promise<any>;
        getPreference: (tier: string) => Promise<any>;
        setPreference: (tier: string, prefs: any) => Promise<void>;
        getUsage: () => Promise<any>;
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
