import React from 'react';
import { motion } from 'framer-motion';
import { Globe, X, RefreshCw, PanelRightClose, Camera, Wrench } from 'lucide-react';
import { API_BASE_URL } from '../../lib/config';
import { useAppStore } from '../../store/useAppStore';

interface PreviewPanelProps {
  iframeUrl: string;
  onClose: () => void;
  editorVisible: boolean;
  onToggleEditor: () => void;
  onSnap?: () => void;
  /** Called when the user clicks "Ask agent to fix" on a console error. */
  onAskAgentFix?: (errorMessage: string) => void;
}

export const PreviewPanel: React.FC<PreviewPanelProps> = ({ iframeUrl, onClose, editorVisible, onToggleEditor, onSnap: _onSnap, onAskAgentFix }) => {
  const iframeRef = React.useRef<HTMLIFrameElement>(null);

  const { previewConsoleBuffer, agentBusy } = useAppStore(
    (s) => ({ previewConsoleBuffer: s.previewConsoleBuffer, agentBusy: s.agentBusy })
  );

  // Latest console error for the fix chip
  const latestError = [...previewConsoleBuffer].reverse().find(e => e.level === 'error');
  const showFixChip = latestError && !agentBusy && !!onAskAgentFix;

  const handleCaptureScreenshot = async () => {
    if (!iframeRef.current?.contentWindow) return;

    const screenshotPromise = new Promise<string>((resolve, reject) => {
      const handler = (e: MessageEvent) => {
        if (e.data?.type === 'solvent:screenshot-ready') {
          window.removeEventListener('message', handler);
          resolve(e.data.dataUrl);
        } else if (e.data?.type === 'solvent:screenshot-error') {
          window.removeEventListener('message', handler);
          reject(new Error(e.data.error));
        }
      };
      window.addEventListener('message', handler);
      setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('Screenshot timed out'));
      }, 10000);
    });

    iframeRef.current.contentWindow.postMessage({ type: 'solvent:capture-screenshot' }, '*');

    try {
      const dataUrl = await screenshotPromise;
      const blob = await (await fetch(dataUrl)).blob();
      const formData = new FormData();
      formData.append('file', blob, 'screenshot.png');

      const res = await fetch(`${API_BASE_URL}/files/upload`, {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      useAppStore.getState().setPreviewScreenshotUrl(data.url);
    } catch {
      // Silently fail — user can retry
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className="flex-1 flex flex-col border-l border-white/[0.04] overflow-clip bg-white"
      style={{ minWidth: 360 }}
    >
      {/* Browser chrome */}
      <div className="h-9 bg-[#0d0d18] flex items-center px-3 gap-2 shrink-0 border-b border-white/[0.04]">
        <button
          type="button"
          onClick={onToggleEditor}
          className="p-1 hover:bg-white/10 rounded text-white/30 hover:text-white/60 transition-colors shrink-0"
          aria-label={editorVisible ? 'Hide editor' : 'Show editor'}
          title={editorVisible ? 'Hide editor (⌘E)' : 'Show editor (⌘E)'}
        >
          <PanelRightClose size={11} style={{ transform: editorVisible ? 'none' : 'scaleX(-1)' }} aria-hidden="true" />
        </button>
        <Globe size={12} className="text-white/30 shrink-0" aria-hidden="true" />
        <span className="text-[11px] font-mono text-white/40 flex-1 truncate min-w-0">{iframeUrl}</span>
        <button
          type="button"
          onClick={() => {
            if (iframeRef.current) {
              // Re-set src to reload — cross-origin iframe prevents contentWindow.location.reload()
              const currentSrc = iframeRef.current.src;
              iframeRef.current.src = '';
              iframeRef.current.src = currentSrc;
            }
          }}
          className="p-1 hover:bg-white/10 rounded text-white/30 hover:text-white/60 transition-colors shrink-0"
          aria-label="Reload preview"
        >
          <RefreshCw size={11} />
        </button>
        <button
          type="button"
          onClick={handleCaptureScreenshot}
          className="p-1 hover:bg-white/10 rounded text-white/30 hover:text-white/60 transition-colors shrink-0"
          aria-label="Capture screenshot"
          title="Capture screenshot"
        >
          <Camera size={11} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="p-1 hover:bg-white/10 rounded text-white/30 hover:text-white/60 transition-colors shrink-0"
          aria-label="Close preview"
        >
          <X size={11} />
        </button>
      </div>

      {/* Proactive fix chip — shows when a console error exists and agent is idle */}
      {showFixChip && (
        <div className="shrink-0 bg-rose-500/8 border-t border-b border-rose-500/15 px-3 py-1.5 flex items-center gap-2">
          <Wrench size={12} className="text-rose-400 shrink-0" />
          <span className="text-[11px] text-rose-300/80 truncate flex-1 min-w-0" title={latestError!.message}>
            {latestError!.message.slice(0, 120)}
          </span>
          <button
            type="button"
            onClick={() => onAskAgentFix!(latestError!.message)}
            className="shrink-0 text-[10px] font-medium text-rose-400 hover:text-rose-300 bg-rose-500/15 hover:bg-rose-500/25 px-2 py-0.5 rounded transition-colors"
          >
            Ask agent to fix
          </button>
        </div>
      )}

      {/* Preview iframe — fills remaining height */}
      <iframe
        ref={iframeRef}
        src={iframeUrl}
        className="flex-1 border-none w-full h-full"
        title="App preview"
      />
    </motion.div>
  );
};
