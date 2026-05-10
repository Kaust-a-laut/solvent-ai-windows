import { spawn, ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';
import * as fs from 'fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { logger } from '../utils/logger';
import { PROJECT_ROOT } from '../utils/fileSystem';

const LOG_RING_SIZE = 500;
const READY_PATTERNS: RegExp[] = [
  /\brunning on\s+https?:\/\/[^\s]+/i,          // "Server ... running on http://127.0.0.1:3002"
  /\blistening\s+(on\s+)?(port\s+)?\d+/i,        // "Listening on port 3002" / "Listening on 3002"
  /\bLocal:\s+https?:\/\//i,                     // Vite: "Local: http://localhost:5173"
  /\bready in\b/i,                               // Vite/Next ready-ness
];

export interface SidecarLogLine {
  ts: number;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

export interface SidecarStatus {
  running: boolean;
  ready: boolean;
  port: number | null;
  pid: number | null;
  projectPath: string | null;
  startedAt: number | null;
  uptimeMs: number;
  exitCode: number | null;
  lastLogs: SidecarLogLine[];
}

interface SidecarState {
  child: ChildProcess;
  port: number;
  pid: number;
  projectPath: string;
  startedAt: number;
  ready: boolean;
  exitCode: number | null;
  logs: SidecarLogLine[];
}

/**
 * Manages a single child-process "sidecar" running a copy of Solvent's backend
 * natively on the user's machine. This is the Native Bridge path: we can't
 * boot a full Solvent backend inside WebContainer (native C++ deps, Redis),
 * so we spawn it on the host and let a WebContainer-hosted frontend copy
 * proxy to it.
 *
 * One sidecar at a time (keeps UX simple; most dogfooding needs one copy).
 */
class NativeCopyManager {
  private state: SidecarState | null = null;
  // Per-stream UTF-8 decoders so multibyte codepoints split across chunk
  // boundaries don't surface as U+FFFD in the dev-server log panel.
  // Recreated each start; flushed on exit.
  private stdoutDecoder: StringDecoder | null = null;
  private stderrDecoder: StringDecoder | null = null;

  /**
   * Start a sidecar against `projectPath`. The path must resolve inside
   * PROJECT_ROOT — this prevents an attacker with API access from spawning
   * arbitrary commands in arbitrary directories.
   */
  async start(
    projectPath: string,
    desiredPort = 3002
  ): Promise<{ port: number; pid: number }> {
    if (this.state && this.state.exitCode === null) {
      throw new Error(
        `Sidecar already running (pid=${this.state.pid}, port=${this.state.port}). Stop it before starting a new one.`
      );
    }

    const resolvedRoot = this.resolveProjectPath(projectPath);
    const backendDir = path.join(resolvedRoot, 'backend');

    await this.assertBackendDir(backendDir);

    // Zombie-reclaim: if a previous sidecar died holding this exact port,
    // kill whatever still holds it before findFreePort skips past it. We
    // only do this when the prior state's port matches, so we don't nuke
    // an unrelated user service that happens to be on 3002.
    //
    // Race caveat: there is a small window between the previous sidecar
    // exiting and this start() firing in which an unrelated process could
    // grab the port. We'd then kill that process. In practice the window
    // is sub-second (both events are user-initiated), and anything grabbing
    // 3002 in that window is almost certainly an orphan from the same
    // sidecar tree. Operators spawning arbitrary services on 3002 while
    // dogfooding should avoid the Native Bridge default port.
    if (this.state && this.state.exitCode !== null && this.state.port === desiredPort) {
      const free = await isPortFree(desiredPort);
      if (!free) {
        this.pushLog('system', `Port ${desiredPort} still held after prior exit — reclaiming`);
        await killProcessOnPort(desiredPort);
      }
    }

    const port = await findFreePort(desiredPort);

    const child = spawn('npm', ['run', 'dev'], {
      cwd: backendDir,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'development',
        // Keep the copy from clobbering the main backend's local state paths
        SOLVENT_SIDECAR: '1',
      },
      shell: true,
      windowsHide: true,
    });

    const now = Date.now();
    const state: SidecarState = {
      child,
      port,
      pid: child.pid ?? -1,
      projectPath: resolvedRoot,
      startedAt: now,
      ready: false,
      exitCode: null,
      logs: [],
    };
    this.state = state;

    this.pushLog('system', `Starting sidecar: npm run dev in ${backendDir} (PORT=${port})`);

    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');

    child.stdout?.on('data', (buf: Buffer) => this.handleOutput('stdout', buf));
    child.stderr?.on('data', (buf: Buffer) => this.handleOutput('stderr', buf));

    child.on('exit', (code, signal) => {
      state.exitCode = code;
      // Flush any trailing partial multibyte sequence so the last log line
      // isn't truncated.
      const tailOut = this.stdoutDecoder?.end();
      if (tailOut) this.handleOutputString('stdout', tailOut);
      const tailErr = this.stderrDecoder?.end();
      if (tailErr) this.handleOutputString('stderr', tailErr);
      this.stdoutDecoder = null;
      this.stderrDecoder = null;
      this.pushLog('system', `Sidecar exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
      logger.info(`[NativeCopy] Sidecar exited code=${code} signal=${signal}`);
    });

    child.on('error', (err) => {
      this.pushLog('system', `Sidecar spawn error: ${err.message}`);
      logger.error(`[NativeCopy] Spawn error: ${err.message}`);
    });

    logger.info(`[NativeCopy] Started pid=${state.pid} port=${port} cwd=${backendDir}`);
    return { port, pid: state.pid };
  }

  /**
   * Stop the running sidecar. Always resolves — callers should not need to
   * worry about partial-kill cleanup.
   *
   * Windows vs POSIX matters here. On Windows, the child is spawned with
   * `shell: true`, so state.child is cmd.exe running `npm run dev`. The
   * actual server (node.exe → tsx → server.ts) is two levels down. Calling
   * child.kill() on Windows just calls TerminateProcess on cmd.exe, which
   * exits immediately — the grandchildren are orphaned but keep running
   * and keep holding the port. `taskkill /T /F` walks the tree, which is
   * the only thing that works. Don't bother with the SIGTERM dance.
   *
   * On POSIX, SIGTERM does propagate through process groups when the shell
   * is well-behaved, so a graceful 5s wait is still useful.
   */
  async stop(): Promise<void> {
    const state = this.state;
    if (!state || state.exitCode !== null) {
      logger.info('[NativeCopy] stop() called but no live sidecar');
      return;
    }

    this.pushLog('system', `Stopping sidecar (pid=${state.pid})`);
    logger.info(`[NativeCopy] stop() begin pid=${state.pid} port=${state.port}`);

    try {
      if (process.platform === 'win32') {
        const killRes = await forceKillTree(state.pid);
        this.pushLog('system', `taskkill ${killRes.ok ? 'ok' : 'failed'} (code=${killRes.code}${killRes.err ? `, err=${killRes.err}` : ''})`);
        logger.info(`[NativeCopy] taskkill ok=${killRes.ok} code=${killRes.code} err=${killRes.err ?? ''}`);

        await waitForExit(state.child, 2000);
        logger.info(`[NativeCopy] post-waitForExit childExit=${state.child.exitCode} stateExit=${state.exitCode}`);

        const free = await isPortFree(state.port);
        logger.info(`[NativeCopy] port ${state.port} free=${free}`);
        if (!free) {
          this.pushLog('system', `Port ${state.port} still held after taskkill — reclaiming`);
          const reclaimed = await killProcessOnPort(state.port);
          this.pushLog('system', `Port reclaim ${reclaimed ? 'succeeded' : 'found nothing'}`);
          logger.info(`[NativeCopy] reclaim result=${reclaimed}`);
        }
      } else {
        try {
          state.child.kill('SIGTERM');
        } catch (err) {
          logger.warn(`[NativeCopy] SIGTERM failed: ${(err as Error).message}`);
        }

        const exited = await waitForExit(state.child, 5000);
        if (!exited) {
          this.pushLog('system', 'SIGTERM timeout — force-killing process tree');
          await forceKillTree(state.pid);
        }
      }
    } finally {
      // UI-authoritative state flip. Even if taskkill misbehaves or hangs
      // past its timeout, the UI must see running:false after stop() returns,
      // or the Stop button looks broken. The actual child may still be dying
      // in the background — that's fine; the port reclaim above handles
      // orphan cleanup, and a subsequent start() re-reclaims on collision.
      if (state.exitCode === null) {
        state.exitCode = -1;
        this.pushLog('system', 'Sidecar stopped');
      }
      logger.info(`[NativeCopy] stop() end pid=${state.pid} exitCode=${state.exitCode}`);
    }
  }

  async stopAll(): Promise<void> {
    return this.stop();
  }

  /**
   * Operator-facing escape hatch: if something is wedged on `port`, kill it.
   * Separate from stop() because the caller may not have the pid anymore —
   * this looks up the owner via netstat and force-kills whatever is listening.
   */
  async forceReclaimPort(port: number): Promise<boolean> {
    if (this.state) {
      this.pushLog('system', `Manual port reclaim requested: :${port}`);
    }
    return killProcessOnPort(port);
  }

  status(): SidecarStatus {
    const state = this.state;
    if (!state) {
      return {
        running: false,
        ready: false,
        port: null,
        pid: null,
        projectPath: null,
        startedAt: null,
        uptimeMs: 0,
        exitCode: null,
        lastLogs: [],
      };
    }
    return {
      running: state.exitCode === null,
      ready: state.ready && state.exitCode === null,
      port: state.port,
      pid: state.pid,
      projectPath: state.projectPath,
      startedAt: state.startedAt,
      uptimeMs: Date.now() - state.startedAt,
      exitCode: state.exitCode,
      lastLogs: state.logs.slice(-50),
    };
  }

  /**
   * Return log lines newer than `sinceTs`. For the SSE log stream.
   */
  logsSince(sinceTs: number): SidecarLogLine[] {
    if (!this.state) return [];
    return this.state.logs.filter((l) => l.ts > sinceTs);
  }

  private resolveProjectPath(input: string): string {
    const resolved = path.resolve(PROJECT_ROOT, input);
    const rootSep = PROJECT_ROOT.endsWith(path.sep) ? PROJECT_ROOT : PROJECT_ROOT + path.sep;
    if (resolved !== PROJECT_ROOT && !resolved.startsWith(rootSep)) {
      throw new Error(`Invalid projectPath (escapes workspace): ${input}`);
    }
    // Refuse to spawn a sidecar at the repo root itself — that would be the
    // currently-running Solvent backend, which is a terrible idea.
    if (resolved === PROJECT_ROOT) {
      throw new Error('Sidecar projectPath cannot be the main Solvent repo root');
    }
    return resolved;
  }

  private async assertBackendDir(backendDir: string): Promise<void> {
    try {
      const pkgPath = path.join(backendDir, 'package.json');
      const stat = await fs.stat(pkgPath);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${pkgPath}`);
      }
    } catch (err) {
      throw new Error(
        `Backend directory missing or incomplete at ${backendDir}: ${(err as Error).message}`
      );
    }
  }

  private handleOutput(stream: 'stdout' | 'stderr', buf: Buffer): void {
    // Use a per-stream StringDecoder so multibyte codepoints split across
    // chunk boundaries are buffered instead of becoming U+FFFD.
    const decoder = stream === 'stdout' ? this.stdoutDecoder : this.stderrDecoder;
    const chunk = decoder ? decoder.write(buf) : buf.toString('utf8');
    if (chunk) this.handleOutputString(stream, chunk);
  }

  private handleOutputString(stream: 'stdout' | 'stderr', chunk: string): void {
    // Split on newline but preserve partial trailing line semantics by just
    // filtering empties — dev-server output is line-oriented and this is
    // good enough for log display.
    for (const raw of chunk.split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      this.pushLog(stream, line);
      if (this.state && !this.state.ready && isReadyLine(line)) {
        // Log-pattern match is a candidate, not proof — if Vite/tsx changes
        // their startup output, the pattern could fire before the server
        // actually accepts connections. Confirm with an HTTP probe before
        // flipping ready. If the probe fails we leave ready=false and try
        // again on the next matching log line.
        void this.confirmReadyByProbe();
      }
    }
  }

  private async confirmReadyByProbe(): Promise<void> {
    const state = this.state;
    if (!state || state.ready || state.exitCode !== null) return;
    const port = state.port;
    // Probe a few times with short backoff: the server may accept the TCP
    // connection a tick or two after logging "listening".
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!this.state || this.state !== state || state.exitCode !== null) return;
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
        clearTimeout(t);
        if (res.ok || res.status === 404) {
          // 404 is fine — not every copy backend exposes /health. The fact
          // that we got an HTTP response at all proves the server is up.
          state.ready = true;
          this.pushLog('system', `Sidecar READY on port ${port} (probe=${res.status})`);
          logger.info(`[NativeCopy] Ready confirmed by probe on ${port} status=${res.status}`);
          return;
        }
      } catch {
        /* not up yet — retry */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // Probe never succeeded; will retry on next ready-pattern match.
    logger.info(`[NativeCopy] Ready probe failed for port ${port} — will retry on next log match`);
  }

  private pushLog(stream: 'stdout' | 'stderr' | 'system', line: string): void {
    if (!this.state) return;
    const entry: SidecarLogLine = { ts: Date.now(), stream, line };
    this.state.logs.push(entry);
    if (this.state.logs.length > LOG_RING_SIZE) {
      this.state.logs.splice(0, this.state.logs.length - LOG_RING_SIZE);
    }
  }
}

function isReadyLine(line: string): boolean {
  return READY_PATTERNS.some((re) => re.test(line));
}

function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > start + 50) {
        reject(new Error(`No free port in [${start}, ${start + 50}]`));
        return;
      }
      const srv = net.createServer();
      srv.unref();
      srv.on('error', () => tryPort(p + 1));
      srv.listen(p, '127.0.0.1', () => {
        srv.close(() => resolve(p));
      });
    };
    tryPort(start);
  });
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Find whatever process is LISTENING on `port` and force-kill it. Returns
 * true if at least one process was killed. On Windows this uses `netstat
 * -ano` + `taskkill /T /F`; on POSIX it uses `lsof -ti:PORT | xargs kill -9`.
 *
 * Dangerous if used indiscriminately — callers should only invoke this for
 * ports they know belong to a managed sidecar.
 */
function killProcessOnPort(port: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    return new Promise((resolve) => {
      const killer = spawn('sh', ['-c', `lsof -ti:${port} | xargs -r kill -9`], {
        shell: false,
      });
      const to = setTimeout(() => {
        try { killer.kill('SIGKILL'); } catch { /* noop */ }
        resolve(false);
      }, 3000);
      killer.on('close', (code) => { clearTimeout(to); resolve(code === 0); });
      killer.on('error', () => { clearTimeout(to); resolve(false); });
    });
  }
  return new Promise((resolve) => {
    const finder = spawn('cmd', ['/c', `netstat -ano | findstr LISTENING | findstr :${port}`], {
      shell: false,
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const settle = (v: boolean) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const finderTimeout = setTimeout(() => {
      try { finder.kill(); } catch { /* noop */ }
      settle(false);
    }, 3000);
    finder.stdout?.on('data', (b: Buffer) => {
      output += b.toString('utf8');
    });
    finder.on('close', async () => {
      clearTimeout(finderTimeout);
      if (settled) return;
      const pids = new Set<number>();
      for (const line of output.split(/\r?\n/)) {
        // netstat row format (Windows): "  Proto  Local  Foreign  State  PID"
        // PID is the last whitespace-separated token.
        const m = line.match(/\s(\d+)\s*$/);
        if (m && m[1]) {
          const p = parseInt(m[1], 10);
          if (p > 0 && p !== process.pid) pids.add(p);
        }
      }
      if (pids.size === 0) {
        settle(false);
        return;
      }
      for (const pid of pids) {
        await new Promise<void>((r) => {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
          });
          const to = setTimeout(() => {
            try { killer.kill(); } catch { /* noop */ }
            r();
          }, 3000);
          killer.on('close', () => { clearTimeout(to); r(); });
          killer.on('error', () => { clearTimeout(to); r(); });
        });
      }
      settle(true);
    });
    finder.on('error', () => {
      clearTimeout(finderTimeout);
      settle(false);
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

interface KillTreeResult {
  ok: boolean;
  code: number | null;
  err?: string;
}

/**
 * Windows: a shell-spawned `npm run dev` is a cmd.exe that forked node.exe.
 * SIGTERM on the shell does not always propagate. `taskkill /T /F /PID`
 * walks the process tree and terminates everything.
 *
 * Returns a structured result so stop() can surface a diagnostic in the log
 * panel — "stop appeared to hang" was almost always a silent taskkill error
 * (access denied, pid already gone, etc). Bounded by a 3s timeout so the
 * caller can't be wedged by a stuck subprocess.
 */
function forceKillTree(pid: number): Promise<KillTreeResult> {
  return new Promise((resolve) => {
    if (!pid || pid < 0) {
      resolve({ ok: false, code: null, err: 'invalid-pid' });
      return;
    }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
      });
      let stderr = '';
      killer.stderr?.on('data', (b: Buffer) => {
        stderr += b.toString('utf8');
      });
      let settled = false;
      const settle = (r: KillTreeResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const to = setTimeout(() => {
        try { killer.kill(); } catch { /* noop */ }
        settle({ ok: false, code: null, err: 'timeout' });
      }, 3000);
      killer.on('close', (code) => {
        clearTimeout(to);
        const trimmed = stderr.trim().slice(0, 200);
        settle({ ok: code === 0, code, err: trimmed || undefined });
      });
      killer.on('error', (err) => {
        clearTimeout(to);
        settle({ ok: false, code: null, err: err.message });
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
        resolve({ ok: true, code: 0 });
      } catch (err) {
        resolve({ ok: false, code: null, err: (err as Error).message });
      }
    }
  });
}

export const nativeCopyManager = new NativeCopyManager();
