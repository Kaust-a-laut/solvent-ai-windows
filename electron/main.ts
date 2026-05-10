import { app, BrowserWindow, shell, ipcMain, session, Menu, MenuItem } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { ModelManager } from './ModelManager';
import si from 'systeminformation';

// Session-specific secret for Backend-Frontend authentication
const SESSION_SECRET = process.env.BACKEND_INTERNAL_SECRET || 'solvent_default_secure_pass_2026';
process.env.BACKEND_INTERNAL_SECRET = SESSION_SECRET;

// DISABLE GPU for broad compatibility
// app.disableHardwareAcceleration();
// app.commandLine.appendSwitch('disable-gpu');
// app.commandLine.appendSwitch('disable-gpu-compositing');

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
      devTools: true,
      contextIsolation: true,
      nodeIntegration: false,
      // nativeWindowOpen is deprecated, removed.
    },
  });

  // --- Context Menu (Right Click) ---
  mainWindow.webContents.on('context-menu', (event, params) => {
    const menu = new Menu();

    // Basic actions
    menu.append(new MenuItem({ label: 'Cut', role: 'cut', enabled: params.editFlags.canCut }));
    menu.append(new MenuItem({ label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy }));
    menu.append(new MenuItem({ label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Select All', role: 'selectAll' }));
    menu.append(new MenuItem({ type: 'separator' }));
    menu.append(new MenuItem({ label: 'Inspect Element', click: () => mainWindow.webContents.inspectElement(params.x, params.y) }));

    menu.popup();
  });

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
          (c) => c.vram > 512 && !/intel|integrated/i.test(c.vendor || '')
        );
      } catch {}
      return {
        ramGB: Math.round(mem.total / (1024 * 1024 * 1024)),
        cpuCores,
        hasDiscreteGPU,
      };
    } catch {
      return { ramGB: 16, cpuCores: 8, hasDiscreteGPU: false };
    }
  });

  // Modern Window Open Handler
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // External links
    if (url.startsWith('https:') || url.startsWith('http:')) {
      if (!url.includes('localhost:5173')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
    }

    // Child windows (PiP / Supervisor Tab)
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
        }
      }
    };
  });

  // --- Notepad "Agentic Sync" Logic ---
  const NOTES_FILE = path.join(__dirname, '../../.solvent_notes.md');
  let notepadBuffer = "";

  // --- Supervisor "Context Engine" Logic ---
  let active_mission_context: any = {
    mission_id: Date.now(),
    goal: "User initiated session",
    actions: [],
    status: "idle"
  };
  const globalHistory: any[] = [];

  ipcMain.on('report-activity', (event, activity) => {
    const entry = { ...activity, timestamp: Date.now() };
    globalHistory.push(entry);
    active_mission_context.actions.push(entry);
    
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('supervisor-new-data', entry);
    });

    if (active_mission_context.actions.length % 5 === 0) {
       mainWindow.webContents.send('supervisor-nudge', {
          type: 'insight',
          message: "Supervisor: Analyzing progress... Logic flow looks consistent with mission goal."
       });
    }
  });

  ipcMain.on('log-action', (event, action) => {
    ipcMain.emit('report-activity', event, action);
  });

  ipcMain.handle('get-mission-context', () => active_mission_context);

  ipcMain.on('set-mission-goal', (event, goal) => {
     active_mission_context = {
        mission_id: Date.now(),
        goal,
        actions: [],
        status: "active"
     };
  });

  ipcMain.on('set-app-mode', (event, mode) => {
    BrowserWindow.getAllWindows().forEach(win => {
      win.webContents.send('app-mode-changed', mode);
    });
  });

  // --- Model Manager Handlers ---
  ipcMain.handle('model:execute', async (_, tier, messages) => {
    return await ModelManager.execute(tier, messages);
  });
  ipcMain.handle('model:get-preference', (_, tier) => ModelManager.getPreference(tier));
  ipcMain.handle('model:set-preference', (_, tier, prefs) => ModelManager.setPreference(tier, prefs));
  ipcMain.handle('model:get-usage', () => ModelManager.getUsage());
  ipcMain.handle('model:reset-usage', () => ModelManager.resetUsage());

  // Notepad initial load
  try {
    if (fs.existsSync(NOTES_FILE)) {
      notepadBuffer = fs.readFileSync(NOTES_FILE, 'utf-8');
    } else {
      fs.writeFileSync(NOTES_FILE, "");
    }
  } catch (e) {
    console.error("Failed to load notes:", e);
  }

  ipcMain.on('sync-notepad-to-disk', (event, content) => {
    if (content === notepadBuffer) return;
    notepadBuffer = content;
    try {
      fs.writeFileSync(NOTES_FILE, content);
      // Broadcast to ALL other windows for real-time sync
      BrowserWindow.getAllWindows().forEach(win => {
        if (win.webContents !== event.sender) {
          win.webContents.send('ai-updated-notepad', content);
        }
      });
    } catch (e) {
      console.error("Failed to save notes:", e);
    }
  });

  ipcMain.handle('get-notepad', () => notepadBuffer);

  // --- Notepad Canvas (multi-doc, structured) ---
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
    fs.writeFileSync(NOTEPAD_INDEX_FILE, JSON.stringify(idx, null, 2));
  };

  const safeId = (id: string) => /^[a-zA-Z0-9_-]+$/.test(id);

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
    fs.writeFileSync(path.join(NOTEPAD_DOCS_DIR, `${id}.json`), JSON.stringify(doc, null, 2));
    const idx = readNotepadIndex();
    idx.docs.unshift({ id, title: doc.title, createdAt: now, updatedAt: now });
    writeNotepadIndex(idx);
    return doc;
  });

  ipcMain.handle('notepad:load', (_event, id: string) => {
    if (!safeId(id)) throw new Error('invalid id');
    const file = path.join(NOTEPAD_DOCS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  });

  ipcMain.handle('notepad:save', (_event, id: string, doc: any) => {
    if (!safeId(id)) throw new Error('invalid id');
    ensureNotepadDirs();
    const now = Date.now();
    const merged = { ...doc, id, updatedAt: now };
    fs.writeFileSync(path.join(NOTEPAD_DOCS_DIR, `${id}.json`), JSON.stringify(merged, null, 2));
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
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    doc.title = title;
    doc.updatedAt = Date.now();
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const idx = readNotepadIndex();
    const e = idx.docs.find(d => d.id === id);
    if (e) { e.title = title; e.updatedAt = doc.updatedAt; }
    writeNotepadIndex(idx);
    return { ok: true };
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
    const cleanExt = (ext || 'png').replace(/[^a-zA-Z0-9]/g, '').slice(0, 5) || 'png';
    const docImgDir = path.join(NOTEPAD_IMAGES_DIR, docId);
    if (!fs.existsSync(docImgDir)) fs.mkdirSync(docImgDir, { recursive: true });
    const imgId = `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${cleanExt}`;
    const filePath = path.join(docImgDir, imgId);
    const buf = Buffer.from(base64.replace(/^data:image\/[a-z]+;base64,/, ''), 'base64');
    fs.writeFileSync(filePath, buf);
    return { url: `file://${filePath.replace(/\\/g, '/')}`, path: filePath };
  });

  // Tier-aware telemetry with staggered system calls
  let telemetryInterval = 10_000;
  let telemetryTick = 0;

  ipcMain.on('set-telemetry-interval', (_event, intervalMs: number) => {
    telemetryInterval = Math.max(5000, Math.min(60000, intervalMs));
  });

  const runTelemetry = async () => {
    try {
      telemetryTick++;
      let stats: Record<string, number> = {};

      const cpu = await si.currentLoad();
      const mem = await si.mem();
      stats.cpu = Math.round(cpu.currentLoad);
      stats.mem = Math.round((mem.active / mem.total) * 100);

      if (telemetryTick % 2 === 0) {
        const network = await si.networkStats();
        const disk = await si.fsStats();
        stats.net = network[0] ? Math.round(network[0].rx_sec / 1024) : 0;
        stats.disk = disk.wx_sec ? Math.round(disk.wx_sec / 1024) : 0;
      }

      BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('system-telemetry', stats);
      });
    } catch (e) {
      // Log silently — telemetry failures should not crash the main process
      console.error('[Main] System telemetry failed:', e);
    }

    setTimeout(runTelemetry, telemetryInterval);
  };

  setTimeout(runTelemetry, 3000);

  // Sync external changes
  let fsWait = false;
  fs.watch(NOTES_FILE, (eventType, filename) => {
    if (filename && eventType === 'change') {
      if (fsWait) return;
      fsWait = true;
      setTimeout(() => { fsWait = false; }, 500);

      try {
        const newContent = fs.readFileSync(NOTES_FILE, 'utf-8');
        if (newContent !== notepadBuffer) {
          notepadBuffer = newContent;
          BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('ai-updated-notepad', notepadBuffer);
          });
        }
      } catch (e) {
        console.error("Failed to sync external note changes:", e);
      }
    }
  });

  mainWindow.webContents.openDevTools();

  const loadWithRetry = (window: BrowserWindow, url: string) => {
    window.loadURL(url).catch((e) => {
      console.log(`Connection failed (${e.code}), retrying in 1s...`);
      setTimeout(() => loadWithRetry(window, url), 1000);
    });
  };

  if (app.isPackaged) {
    // Production Mode
    const backendPath = path.join(process.resourcesPath, 'backend', 'dist', 'server.js');
    const frontendPath = path.join(process.resourcesPath, 'frontend', 'dist', 'index.html');

    console.log('[Electron] Starting Backend from:', backendPath);
    
    const backendProcess = spawn('node', [backendPath], {
      env: { ...process.env, BACKEND_INTERNAL_SECRET: SESSION_SECRET, PORT: '3001' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (backendProcess.stderr) {
      backendProcess.stderr.on('data', (data: Buffer) => {
        console.error(`[Backend] ${data.toString().trimEnd()}`);
      });
    }

    app.on('will-quit', () => {
      backendProcess.kill();
    });

    mainWindow.loadFile(frontendPath).catch(e => console.error('Failed to load frontend:', e));
  } else {
    // Development Mode
    loadWithRetry(mainWindow, 'http://localhost:5173');
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize();
    mainWindow.show();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});