import { app, BrowserWindow, shell, ipcMain, session, Menu, MenuItem, WebContents } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import { ModelManager } from './ModelManager';
import si from 'systeminformation';

// --- Session secret --------------------------------------------------------
// Priority: explicit env var → persisted per-install secret (packaged builds)
// → null in dev (the renderer falls back to the backend's /dev-secret
// endpoint, which is the source of truth for the backend's own secret).
// Never a hardcoded constant: a fixed fallback is identical across installs
// and bypasses the strength checks the backend enforces on its own config
// path, because Electron injects this via env before the backend starts.
function getOrCreateSessionSecret(): string | null {
  const fromEnv = process.env.BACKEND_INTERNAL_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;

  if (!app.isPackaged) return null;

  const secretFile = path.join(app.getPath('userData'), '.session-secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf-8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* first run — generate below */ }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
  } catch (e) {
    console.error('[Electron] Failed to persist session secret:', e);
  }
  return generated;
}

let SESSION_SECRET: string | null = null;

// --- Navigation policy -------------------------------------------------------
const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

// Exact-origin check (URL-parsed). A substring test like
// url.includes('localhost:5173') is bypassable via e.g.
// https://evil.com/?localhost:5173 — which would then get a window with the
// preload (and get-session-secret) attached.
function isTrustedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') {
      if (!app.isPackaged) return false;
      const distDir = path.resolve(process.resourcesPath, 'frontend', 'dist');
      const targetPath = path.resolve(fileURLToPath(u));
      const normDist = process.platform === 'win32' ? distDir.toLowerCase() : distDir;
      const normTarget = process.platform === 'win32' ? targetPath.toLowerCase() : targetPath;
      const prefix = normDist.endsWith(path.sep) ? normDist : normDist + path.sep;
      return normTarget === normDist || normTarget.startsWith(prefix);
    }
    return DEV_ORIGINS.has(u.origin);
  } catch {
    return false;
  }
}

function broadcastToWindows(channel: string, payload: unknown, excludeSender?: WebContents) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    if (excludeSender && win.webContents === excludeSender) continue;
    win.webContents.send(channel, payload);
  }
}

function writeFileAtomicSync(filePath: string, content: string) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);

// --- Notepad "Agentic Sync" state -------------------------------------------
// Dev: the repo root (where the backend's PROJECT_ROOT also points).
// Packaged: userData — __dirname lives inside resources/ where writes fail.
const NOTES_FILE = app.isPackaged
  ? path.join(app.getPath('userData'), '.solvent_notes.md')
  : path.join(__dirname, '../.solvent_notes.md');
let notepadBuffer = '';

// --- Supervisor "Context Engine" state ---------------------------------------
const MAX_HISTORY_ENTRIES = 500;
let active_mission_context: any = {
  mission_id: Date.now(),
  goal: 'User initiated session',
  actions: [],
  status: 'idle'
};
const globalHistory: any[] = [];

// --- Notepad Canvas (multi-doc, structured) ----------------------------------
const NOTEPAD_DIR = path.join(app.getPath('userData'), 'notepad');
const NOTEPAD_DOCS_DIR = path.join(NOTEPAD_DIR, 'docs');
const NOTEPAD_IMAGES_DIR = path.join(NOTEPAD_DIR, 'images');
const NOTEPAD_INDEX_FILE = path.join(NOTEPAD_DIR, 'index.json');

const ensureNotepadDirs = () => {
  for (const dir of [NOTEPAD_DIR, NOTEPAD_DOCS_DIR, NOTEPAD_IMAGES_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(NOTEPAD_INDEX_FILE)) {
    fs.writeFileSync(NOTEPAD_INDEX_FILE, JSON.stringify({ docs: [] }, null, 2));
  }
};

const readNotepadIndex = (): { docs: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> } => {
  ensureNotepadDirs();
  try {
    return JSON.parse(fs.readFileSync(NOTEPAD_INDEX_FILE, 'utf-8'));
  } catch {
    return { docs: [] };
  }
};

const writeNotepadIndex = (idx: { docs: Array<{ id: string; title: string; createdAt: number; updatedAt: number }> }) => {
  ensureNotepadDirs();
  writeFileAtomicSync(NOTEPAD_INDEX_FILE, JSON.stringify(idx, null, 2));
};

const safeId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

// --- IPC registration ---------------------------------------------------------
// Registered exactly once at startup. Registering inside createWindow() breaks
// on macOS: 'activate' re-runs createWindow and ipcMain.handle throws on
// duplicate registration (and .on handlers/timers would double-fire).
function registerIpcHandlers() {
  // Window Controls
  ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  ipcMain.handle('get-session-secret', () => SESSION_SECRET);

  // --- Device Capability Detection for Performance Tier ---
  ipcMain.handle('get-device-capability', async () => {
    try {
      const mem = await si.mem();
      const cpuCores = os.cpus().length;
      let hasDiscreteGPU = false;
      try {
        const graphics = await si.graphics();
        hasDiscreteGPU = graphics.controllers.some(
          (c) => (c.vram ?? 0) > 512 && !/intel|integrated/i.test(c.vendor || '')
        );
      } catch { /* ignore */ }
      return {
        ramGB: Math.round(mem.total / (1024 * 1024 * 1024)),
        cpuCores,
        hasDiscreteGPU,
      };
    } catch {
      return { ramGB: 16, cpuCores: 8, hasDiscreteGPU: false };
    }
  });

  // --- Supervisor activity feed ---
  const handleActivity = (_event: Electron.IpcMainEvent, activity: any) => {
    const entry = { ...activity, timestamp: Date.now() };
    globalHistory.push(entry);
    active_mission_context.actions.push(entry);

    // Cap unbounded growth across long sessions
    if (globalHistory.length > MAX_HISTORY_ENTRIES) {
      globalHistory.splice(0, globalHistory.length - MAX_HISTORY_ENTRIES);
    }
    if (active_mission_context.actions.length > MAX_HISTORY_ENTRIES) {
      active_mission_context.actions.splice(0, active_mission_context.actions.length - MAX_HISTORY_ENTRIES);
    }

    broadcastToWindows('supervisor-new-data', entry);

    if (active_mission_context.actions.length % 5 === 0) {
      broadcastToWindows('supervisor-nudge', {
        type: 'insight',
        message: 'Supervisor: Analyzing progress... Logic flow looks consistent with mission goal.'
      });
    }
  };
  ipcMain.on('report-activity', handleActivity);
  ipcMain.on('log-action', handleActivity);

  ipcMain.handle('get-mission-context', () => active_mission_context);

  ipcMain.on('set-mission-goal', (_event, goal) => {
    active_mission_context = {
      mission_id: Date.now(),
      goal,
      actions: [],
      status: 'active'
    };
  });

  ipcMain.on('set-app-mode', (_event, mode) => {
    broadcastToWindows('app-mode-changed', mode);
  });

  // --- Model Manager Handlers ---
  ipcMain.handle('model:execute', async (_, tier, messages) => {
    return await ModelManager.execute(tier, messages);
  });
  ipcMain.handle('model:get-preference', (_, tier) => ModelManager.getPreference(tier));
  ipcMain.handle('model:set-preference', (_, tier, prefs) => ModelManager.setPreference(tier, prefs));
  ipcMain.handle('model:get-usage', () => ModelManager.getUsage());
  ipcMain.handle('model:reset-usage', () => ModelManager.resetUsage());

  // --- Notepad (legacy single-string scratchpad) ---
  ipcMain.on('sync-notepad-to-disk', (event, content) => {
    if (typeof content !== 'string' || content === notepadBuffer) return;
    notepadBuffer = content;
    try {
      writeFileAtomicSync(NOTES_FILE, content);
      // Broadcast to ALL other windows for real-time sync
      broadcastToWindows('ai-updated-notepad', content, event.sender);
    } catch (e) {
      console.error('Failed to save notes:', e);
    }
  });

  ipcMain.handle('get-notepad', () => notepadBuffer);

  // --- Notepad Canvas (multi-doc) ---
  ipcMain.handle('notepad:list', () => readNotepadIndex().docs);

  ipcMain.handle('notepad:create', (_event, title: string) => {
    ensureNotepadDirs();
    const id = `nb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const doc = {
      id,
      title: title || 'Untitled Canvas',
      createdAt: now,
      updatedAt: now,
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      chatThread: []
    };
    writeFileAtomicSync(path.join(NOTEPAD_DOCS_DIR, `${id}.json`), JSON.stringify(doc, null, 2));
    const idx = readNotepadIndex();
    idx.docs.unshift({ id, title: doc.title, createdAt: now, updatedAt: now });
    writeNotepadIndex(idx);
    return doc;
  });

  ipcMain.handle('notepad:load', (_event, id: string) => {
    if (!safeId(id)) throw new Error('invalid id');
    const file = path.join(NOTEPAD_DOCS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch (e) {
      console.error(`[Main] Failed to parse notepad doc ${id}:`, e);
      return null;
    }
  });

  ipcMain.handle('notepad:save', (_event, id: string, doc: any) => {
    if (!safeId(id)) throw new Error('invalid id');
    if (!doc || typeof doc !== 'object') throw new Error('invalid doc payload');
    ensureNotepadDirs();
    const now = Date.now();
    const merged = { ...doc, id, updatedAt: now };
    writeFileAtomicSync(path.join(NOTEPAD_DOCS_DIR, `${id}.json`), JSON.stringify(merged, null, 2));
    const idx = readNotepadIndex();
    const existing = idx.docs.find(d => d.id === id);
    if (existing) {
      existing.title = merged.title || existing.title;
      existing.updatedAt = now;
    } else {
      idx.docs.unshift({ id, title: merged.title || 'Untitled Canvas', createdAt: merged.createdAt || now, updatedAt: now });
    }
    writeNotepadIndex(idx);
    return { ok: true, updatedAt: now };
  });

  ipcMain.handle('notepad:rename', (_event, id: string, title: string) => {
    if (!safeId(id)) throw new Error('invalid id');
    const file = path.join(NOTEPAD_DOCS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return { ok: false };
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
      doc.title = title;
      doc.updatedAt = Date.now();
      writeFileAtomicSync(file, JSON.stringify(doc, null, 2));
      const idx = readNotepadIndex();
      const e = idx.docs.find(d => d.id === id);
      if (e) { e.title = title; e.updatedAt = doc.updatedAt; }
      writeNotepadIndex(idx);
      return { ok: true };
    } catch (e) {
      console.error(`[Main] Failed to rename notepad doc ${id}:`, e);
      return { ok: false };
    }
  });

  ipcMain.handle('notepad:delete', (_event, id: string) => {
    if (!safeId(id)) throw new Error('invalid id');
    const file = path.join(NOTEPAD_DOCS_DIR, `${id}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const imgDir = path.join(NOTEPAD_IMAGES_DIR, id);
    if (fs.existsSync(imgDir)) {
      try { fs.rmSync(imgDir, { recursive: true, force: true }); } catch (e) { console.error(e); }
    }
    const idx = readNotepadIndex();
    idx.docs = idx.docs.filter(d => d.id !== id);
    writeNotepadIndex(idx);
    return { ok: true };
  });

  ipcMain.handle('notepad:saveImage', (_event, docId: string, base64: string, ext: string) => {
    if (!safeId(docId)) throw new Error('invalid doc id');
    if (typeof base64 !== 'string') throw new Error('invalid image payload');
    const normalizedExt = String(ext || 'png').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const cleanExt = ALLOWED_IMAGE_EXTS.has(normalizedExt) ? normalizedExt : 'png';
    const docImgDir = path.join(NOTEPAD_IMAGES_DIR, docId);
    if (!fs.existsSync(docImgDir)) fs.mkdirSync(docImgDir, { recursive: true });
    const imgId = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${cleanExt}`;
    const filePath = path.join(docImgDir, imgId);
    const rawBase64 = base64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    const buf = Buffer.from(rawBase64, 'base64');
    fs.writeFileSync(filePath, buf);
    return { url: pathToFileURL(filePath).href, path: filePath };
  });

  ipcMain.on('set-telemetry-interval', (_event, intervalMs: number) => {
    if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs)) return;
    telemetryInterval = Math.max(5000, Math.min(60000, Math.round(intervalMs)));
  });
}

// --- Tier-aware telemetry with staggered system calls -------------------------
let telemetryInterval = 10_000;
let telemetryTick = 0;
let telemetryStarted = false;
let telemetryTimer: ReturnType<typeof setTimeout> | null = null;
let appQuitting = false;

function startTelemetryLoop() {
  if (telemetryStarted) return;
  telemetryStarted = true;

  const runTelemetry = async () => {
    if (appQuitting) return;
    try {
      const windows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
      if (windows.length > 0) {
        telemetryTick++;
        const stats: Record<string, number> = {};

        const cpu = await si.currentLoad();
        const mem = await si.mem();
        stats.cpu = Math.round(cpu.currentLoad);
        stats.mem = mem.total > 0 ? Math.round((mem.active / mem.total) * 100) : 0;

        if (telemetryTick % 2 === 0) {
          const network = await si.networkStats();
          const disk = await si.fsStats();
          stats.net = network[0] ? Math.round((network[0].rx_sec ?? 0) / 1024) : 0;
          stats.disk = disk.wx_sec ? Math.round(disk.wx_sec / 1024) : 0;
        }

        broadcastToWindows('system-telemetry', stats);
      }
    } catch (e) {
      // Log silently — telemetry failures should not crash the main process
      console.error('[Main] System telemetry failed:', e);
    }

    if (!appQuitting) {
      telemetryTimer = setTimeout(runTelemetry, telemetryInterval);
    }
  };

  telemetryTimer = setTimeout(runTelemetry, 3000);
}

// --- Notepad disk sync ---------------------------------------------------------
let notepadSyncStarted = false;
let notesWatcher: fs.FSWatcher | null = null;

function initNotepadSync() {
  if (notepadSyncStarted) return;
  notepadSyncStarted = true;

  try {
    if (fs.existsSync(NOTES_FILE)) {
      notepadBuffer = fs.readFileSync(NOTES_FILE, 'utf-8');
    } else {
      fs.writeFileSync(NOTES_FILE, '');
    }
  } catch (e) {
    console.error('Failed to load notes:', e);
  }

  // Sync external changes. fs.watch throws synchronously if the file is
  // missing (e.g. the write above failed) — never let that take down startup.
  try {
    let fsWait = false;
    notesWatcher = fs.watch(NOTES_FILE, (eventType, filename) => {
      if (filename && eventType === 'change') {
        if (fsWait) return;
        fsWait = true;
        setTimeout(() => { fsWait = false; }, 500);

        try {
          const newContent = fs.readFileSync(NOTES_FILE, 'utf-8');
          if (newContent !== notepadBuffer) {
            notepadBuffer = newContent;
            broadcastToWindows('ai-updated-notepad', notepadBuffer);
          }
        } catch (e) {
          console.error('Failed to sync external note changes:', e);
        }
      }
    });
    notesWatcher.on('error', (err) => {
      console.error('[Main] Notes file watcher error:', err);
    });
  } catch (e) {
    console.error('[Main] Notes file watch unavailable:', e);
  }
}

// --- Backend process (packaged builds) ------------------------------------------
let backendStarted = false;

function startBackendIfPackaged() {
  if (!app.isPackaged || backendStarted) return;
  backendStarted = true;

  const backendPath = path.join(process.resourcesPath, 'backend', 'dist', 'server.js');
  const userDataDir = app.getPath('userData');
  const packagedProjectsDir = path.join(userDataDir, 'projects');
  console.log('[Electron] Starting Backend from:', backendPath);

  // process.execPath + ELECTRON_RUN_AS_NODE: user machines don't necessarily
  // have a system Node on PATH — Electron's own binary doubles as the runtime.
  const backendProcess = spawn(process.execPath, [backendPath], {
    cwd: userDataDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      BACKEND_INTERNAL_SECRET: SESSION_SECRET ?? '',
      SOLVENT_ELECTRON_PACKAGED: '1',
      SOLVENT_DATA_DIR: userDataDir,
      SOLVENT_SQLITE_PATH: path.join(userDataDir, '.solvent_memory.sqlite'),
      PROJECT_ROOT: process.env.PROJECT_ROOT || packagedProjectsDir,
      PORT: '3001'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Always drain stdout as well as stderr — an unread piped stdout deadlocks
  // the backend process once the OS pipe buffer (~64KB) fills up.
  if (backendProcess.stdout) {
    backendProcess.stdout.on('data', (data: Buffer) => {
      console.log(`[Backend] ${data.toString().trimEnd()}`);
    });
  }

  if (backendProcess.stderr) {
    backendProcess.stderr.on('data', (data: Buffer) => {
      console.error(`[Backend] ${data.toString().trimEnd()}`);
    });
  }

  app.on('will-quit', () => {
    backendProcess.kill();
  });
}

// --- Navigation protection for ALL webContents (main + child PiP windows) ----
function attachWebContentsSecurity(contents: WebContents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          alwaysOnTop: true,
          frame: false,
          backgroundColor: '#020617',
          webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            devTools: !app.isPackaged,
          }
        }
      };
    }
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return;
    event.preventDefault();
    if (url.startsWith('https:') || url.startsWith('http:')) {
      shell.openExternal(url);
    }
  });
}

// --- Window creation --------------------------------------------------------------
async function createWindow() {
  await session.defaultSession.clearCache();

  const mainWindow = new BrowserWindow({
    width: 1300,
    height: 900,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#050508',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // --- Context Menu (Right Click) ---
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    menu.append(new MenuItem({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }));
    menu.append(new MenuItem({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy }));
    menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
    if (!app.isPackaged) {
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ label: 'Inspect Element', click: () => mainWindow.webContents.inspectElement(params.x, params.y) }));
    }

    menu.popup();
  });

  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }

  const loadWithRetry = (window: BrowserWindow, url: string) => {
    if (window.isDestroyed() || appQuitting) return;
    window.loadURL(url).catch((e) => {
      if (window.isDestroyed() || appQuitting) return;
      console.log(`Connection failed (${e.code}), retrying in 1s...`);
      setTimeout(() => loadWithRetry(window, url), 1000);
    });
  };

  if (app.isPackaged) {
    const frontendPath = path.join(process.resourcesPath, 'frontend', 'dist', 'index.html');
    mainWindow.loadFile(frontendPath).catch(e => console.error('Failed to load frontend:', e));
  } else {
    loadWithRetry(mainWindow, 'http://localhost:5173');
  }

  mainWindow.once('ready-to-show', () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.maximize();
    mainWindow.show();
  });
}

app.on('web-contents-created', (_event, contents) => {
  attachWebContentsSecurity(contents);
});

app.on('will-quit', () => {
  appQuitting = true;
  if (telemetryTimer) {
    clearTimeout(telemetryTimer);
    telemetryTimer = null;
  }
  if (notesWatcher) {
    notesWatcher.close();
    notesWatcher = null;
  }
});

app.whenReady().then(() => {
  SESSION_SECRET = getOrCreateSessionSecret();
  ModelManager.setSecretProvider(() => SESSION_SECRET);
  registerIpcHandlers();
  initNotepadSync();
  startTelemetryLoop();
  startBackendIfPackaged();
  return createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
