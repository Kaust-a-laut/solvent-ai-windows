import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Server, Loader2, Square, AlertCircle, X } from 'lucide-react';
import {
  getNativeBackendStatus,
  startNativeBackend,
  stopNativeBackend,
  type SidecarStatus,
} from '../../lib/api-client';
import type { ProjectInfo } from '../../store/codingSlice';

interface Props {
  currentProject: ProjectInfo | null;
}

const POLL_MS = 3000;

function buildProjectPath(project: Props['currentProject']): string | null {
  if (!project) return null;
  // Scratchpad projects live under projects/<name>. Folder-type projects provide
  // an absolute path, which the backend rejects (spawn is scoped to PROJECT_ROOT) —
  // the folder must already be inside the workspace to spawn from.
  if (project.type === 'scratchpad') return `projects/${project.name}`;
  return project.path ?? null;
}

export const NativeBackendChip: React.FC<Props> = ({ currentProject }) => {
  const [status, setStatus] = useState<SidecarStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getNativeBackendStatus();
      setStatus(s);
    } catch {
      /* ignore — next poll retries */
    }
  }, []);

  useEffect(() => {
    refresh();
    intervalRef.current = setInterval(refresh, POLL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  const handleStart = async () => {
    const projectPath = buildProjectPath(currentProject);
    if (!projectPath) {
      setError('No project selected');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await startNativeBackend(projectPath);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Start failed');
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    setError(null);
    try {
      await stopNativeBackend();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stop failed');
    } finally {
      setBusy(false);
    }
  };

  const running = status?.running ?? false;
  const ready = status?.ready ?? false;

  const baseBtnCls =
    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-colors';

  return (
    <div className="relative">
      {!running && (
        <button
          type="button"
          onClick={handleStart}
          disabled={busy || !currentProject}
          className={`${baseBtnCls} border border-white/10 text-white/50 hover:text-white/80 hover:bg-white/5 disabled:opacity-40`}
          title={
            currentProject
              ? 'Spawn the copy project\'s backend as a native child process on the host'
              : 'Open a project first'
          }
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Server size={12} />}
          <span>Native</span>
        </button>
      )}

      {running && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={`${baseBtnCls} border ${
            ready
              ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
              : 'border-amber-500/30 bg-amber-500/5 text-amber-400'
          }`}
          title={
            ready
              ? `Ready on :${status?.port}. Click for logs.`
              : 'Starting — waiting for readiness signal'
          }
        >
          {ready ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
          ) : (
            <Loader2 size={12} className="animate-spin" />
          )}
          <span>Native :{status?.port}</span>
        </button>
      )}

      {expanded && status && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[360px] max-h-[320px] overflow-hidden rounded-lg border border-white/10 bg-[#0d0d18] shadow-2xl flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
            <div className="flex flex-col">
              <span className="text-[10px] text-white/40 font-mono">
                pid={status.pid} port={status.port}
              </span>
              <span className="text-[10px] text-white/30 truncate max-w-[220px]" title={status.projectPath ?? ''}>
                {status.projectPath ?? ''}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleStop}
                disabled={busy}
                className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold text-rose-400 hover:bg-rose-500/10 transition-colors disabled:opacity-40"
              >
                {busy ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} fill="currentColor" />}
                Stop
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                aria-label="Close panel"
                title="Close (sidecar keeps running)"
                className="p-1 rounded text-white/40 hover:text-white/80 hover:bg-white/5 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto px-3 py-2 font-mono text-[10px] leading-relaxed space-y-0.5">
            {status.lastLogs.length === 0 ? (
              <div className="text-white/30">No log output yet…</div>
            ) : (
              status.lastLogs.map((l, i) => (
                <div
                  key={`${l.ts}-${i}`}
                  className={
                    l.stream === 'stderr'
                      ? 'text-rose-300/80'
                      : l.stream === 'system'
                      ? 'text-sky-300/80'
                      : 'text-white/70'
                  }
                >
                  {l.line}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="absolute right-0 top-full mt-1 z-50 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-rose-500/30 bg-[#0d0d18] text-[10px] text-rose-300 shadow-lg max-w-[320px]">
          <AlertCircle size={10} className="shrink-0" />
          <span className="truncate">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="ml-1 text-white/40 hover:text-white/70"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};

export default NativeBackendChip;
