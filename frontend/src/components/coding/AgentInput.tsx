import React, { useState, useRef, useCallback, useMemo } from 'react';
import { Send, Square, Paperclip, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { SLASH_COMMANDS as CANONICAL_COMMANDS } from './slashCommands';
import { useAppStore } from '../../store/useAppStore';
import { fetchWithRetry } from '../../lib/api-client';
import { BASE_URL } from '../../lib/config';

interface Props {
  isGenerating: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onAttach: (fileName: string, content: string) => void;
}

interface AttachedFile {
  path: string;
  content: string;
  loading?: boolean;
}

const FILE_EXTENSIONS = /\.(ts|tsx|js|jsx|css|json|md|html)$/i;

/** Parse projectMap string into file paths matching supported extensions */
function parseProjectMap(map: string | null): string[] {
  if (!map) return [];
  return map
    .split('\n')
    .map(line => line.trim())
    .filter(line => FILE_EXTENSIONS.test(line) && !line.startsWith('.'))
    .map(line => line.replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

/** Get file extension for syntax highlighting label */
function getFileExt(path: string): string {
  const parts = path.split('.');
  return parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
}

/** Display-friendly command shape for the input panel. */
interface DisplayCommand {
  id: string;
  label: string;
  description: string;
}

/** Map canonical slash commands (from slashCommands.ts) to display format. */
function toDisplayCommands(cmds: typeof CANONICAL_COMMANDS): DisplayCommand[] {
  return cmds.map(c => ({ id: c.label, label: c.label, description: c.description }));
}

export const AgentInput: React.FC<Props> = ({
  isGenerating,
  onSend,
  onStop,
  onAttach,
}) => {
  const [input, setInput] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [fileMenuIndex, setFileMenuIndex] = useState(0);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Subscribe to project store
  const projectMap = useAppStore(s => s.projectMap);
  const currentProject = useAppStore(s => s.currentProject);

  // Parse file list from project map
  const projectFiles = useMemo(() => parseProjectMap(projectMap), [projectMap]);

  // Track the @ mention query position and text. State (not a ref) because
  // filteredFiles derives from it during render — as a ref, typing updated
  // the query without recomputing the list, so it never narrowed.
  const [atQuery, setAtQuery] = useState<{ start: number; query: string } | null>(null);

  // Derive display commands from the canonical slashCommands module
  const slashCommands = useMemo(() => toDisplayCommands(CANONICAL_COMMANDS), []);

  // Filter commands when user types after the / (e.g. /re → /refactor, /refactor)
  const filteredCommands = useMemo(() => {
    if (!showSlashMenu) return slashCommands;
    const query = input.slice(1).toLowerCase(); // text after the /
    if (!query) return slashCommands;
    return slashCommands.filter(c =>
      c.id.toLowerCase().includes(query) || c.description.toLowerCase().includes(query)
    );
  }, [showSlashMenu, input, slashCommands]);

  // Filter files when user types after @
  const filteredFiles = useMemo(() => {
    if (!showFileMenu || !atQuery) return projectFiles;
    const query = atQuery.query.toLowerCase();
    if (!query) return projectFiles;
    return projectFiles.filter(f => f.toLowerCase().includes(query));
  }, [showFileMenu, atQuery, projectFiles]);

  // Fetch file content when a file is selected via @ mention
  const fetchFileContent = useCallback(async (filePath: string) => {
    try {
      const projectPath = currentProject?.path || '';
      const url = `${BASE_URL}/api/files/read?path=${encodeURIComponent(filePath)}&project=${encodeURIComponent(projectPath)}`;
      const data = await fetchWithRetry(url) as Record<string, string>;
      const content = data.content ?? '';
      setAttachedFiles(prev => {
        const existing = prev.find(f => f.path === filePath);
        if (existing) {
          return prev.map(f => f.path === filePath ? { ...f, content, loading: false } : f);
        }
        return [...prev, { path: filePath, content }];
      });
    } catch {
      // Mark as failed but still keep the reference
      setAttachedFiles(prev => {
        const existing = prev.find(f => f.path === filePath);
        if (existing) {
          return prev.map(f => f.path === filePath ? { ...f, content: '', loading: false } : f);
        }
        return [...prev, { path: filePath, content: '', loading: false }];
      });
    }
  }, [currentProject]);

  const handleSend = useCallback(() => {
    if (!input.trim() || isGenerating) return;

    // Build the message with attached file contents prepended
    let message = input.trim();
    if (attachedFiles.length > 0) {
      const fileBlocks = attachedFiles
        .filter(f => f.content)
        .map(f => {
          const ext = getFileExt(f.path);
          return `[Attached: ${f.path}]\n\`\`\`${ext}\n${f.content}\n\`\`\``;
        })
        .join('\n\n');
      if (fileBlocks) {
        message = fileBlocks + '\n\n' + message;
      }
    }

    onSend(message);
    setInput('');
    setShowSlashMenu(false);
    setShowFileMenu(false);
    setAttachedFiles([]);
    setAtQuery(null);
  }, [input, isGenerating, onSend, attachedFiles]);

  const selectFile = useCallback((filePath: string) => {
    if (!atQuery) return;
    const { start } = atQuery;
    const before = input.slice(0, start);
    // Find where the current @ mention ends (next space or end of string from the @ position)
    const atEndIndex = input.indexOf(' ', start);
    const afterStart = atEndIndex !== -1 ? atEndIndex : input.length;
    const newValue = before + '@' + filePath + ' ' + input.slice(afterStart).trimStart();
    setInput(newValue);
    setShowFileMenu(false);
    setAtQuery(null);
    // Add to attached files with loading state, then fetch
    setAttachedFiles(prev => {
      if (prev.find(f => f.path === filePath)) return prev;
      return [...prev, { path: filePath, content: '', loading: true }];
    });
    fetchFileContent(filePath);
    inputRef.current?.focus();
  }, [input, atQuery, fetchFileContent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape') {
      setShowSlashMenu(false);
      setShowFileMenu(false);
      setAtQuery(null);
    } else if (showFileMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFileMenuIndex((i) => (i + 1) % filteredFiles.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFileMenuIndex((i) => (i - 1 + filteredFiles.length) % filteredFiles.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const file = filteredFiles[fileMenuIndex];
        if (file) selectFile(file);
      }
    } else if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashMenuIndex((i) => (i + 1) % filteredCommands.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashMenuIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = filteredCommands[slashMenuIndex];
        if (cmd) {
          setInput(cmd.id + ' ');
          setShowSlashMenu(false);
          inputRef.current?.focus();
        }
      }
    }
  }, [handleSend, showSlashMenu, showFileMenu, slashMenuIndex, fileMenuIndex, filteredCommands, filteredFiles, selectFile]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);

    if (value === '/') {
      setShowSlashMenu(true);
      setSlashMenuIndex(0);
    } else if (!value.startsWith('/')) {
      setShowSlashMenu(false);
    }

    // Detect @ mentions: @ preceded by space or at start, followed by text (no spaces)
    const cursorPos = e.target.selectionStart ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
    // Match @word where @ is at start or preceded by space
    const atMatch = textBeforeCursor.match(/(?:^|\s)@(\S*)$/);
    if (atMatch && atMatch[1] !== undefined && atMatch[0] !== undefined) {
      const query = atMatch[1];
      const atStart = cursorPos - atMatch[0].length;
      setAtQuery({ start: atStart, query });
      setShowFileMenu(true);
      setFileMenuIndex(0);
    } else {
      setShowFileMenu(false);
      setAtQuery(null);
    }
  }, []);

  const handleFileAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        onAttach(file.name, content);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [onAttach]);

  return (
    <div className="border-t border-white/[0.16] p-3 bg-white/[0.02]">
      <div className="relative">
        <div className="flex items-end gap-2 bg-white/[0.06] border border-white/[0.22] rounded-xl px-3 py-2 focus-within:border-jb-accent/60 focus-within:bg-white/[0.08] transition-colors shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]">
          <label className="flex-shrink-0 p-1 text-white/30 hover:text-white/50 cursor-pointer transition-colors">
            <Paperclip size={16} />
            <input
              type="file"
              className="hidden"
              onChange={handleFileAttach}
              accept=".txt,.ts,.tsx,.js,.jsx,.json,.md,.css,.html"
            />
          </label>
          
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder={isGenerating ? 'Agent is working...' : 'Ask the agent anything... (/)'}
            disabled={isGenerating}
            rows={1}
            className="flex-1 bg-transparent text-[13px] text-slate-200 placeholder:text-white/30 resize-none outline-none min-h-[20px] max-h-[120px] py-1"
            style={{ scrollbarWidth: 'thin' }}
          />
          
          <button
            type="button"
            onClick={isGenerating ? onStop : handleSend}
            disabled={!isGenerating && !input.trim()}
            className={cn(
              'flex-shrink-0 p-1.5 rounded-lg transition-all',
              isGenerating
                ? 'bg-rose-500/20 border border-rose-500/60 text-rose-300 hover:bg-rose-500/30 shadow-[inset_0_0_0_1px_rgba(244,63,94,0.2)]'
                : input.trim()
                  ? 'cta-primary'
                  : 'bg-white/[0.05] border border-white/[0.12] text-white/30 cursor-not-allowed'
            )}
          >
            {isGenerating ? <Square size={14} fill="currentColor" /> : <Send size={14} />}
          </button>
        </div>

        {showSlashMenu && filteredCommands.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 py-1 bg-jb-panel border border-white/[0.06] rounded-lg shadow-xl z-10 min-w-[220px]">
            {filteredCommands.map((cmd, idx) => (
              <button
                key={cmd.id}
                type="button"
                onClick={() => {
                  setInput(cmd.id + ' ');
                  setShowSlashMenu(false);
                  inputRef.current?.focus();
                }}
                className={cn(
                  'w-full px-3 py-2 text-left hover:bg-white/[0.05] transition-colors',
                  idx === slashMenuIndex ? 'bg-white/[0.05]' : ''
                )}
              >
                <span className="text-[12px] font-semibold text-jb-accent">{cmd.id}</span>
                <span className="text-[11px] text-white/40 ml-2">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}

        {showFileMenu && filteredFiles.length > 0 && (
          <div className="absolute bottom-full left-0 mb-2 py-1 bg-jb-panel border border-white/[0.06] rounded-lg shadow-xl z-10 min-w-[280px] max-h-[200px] overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
            {filteredFiles.slice(0, 20).map((file, idx) => (
              <button
                key={file}
                type="button"
                onClick={() => selectFile(file)}
                className={cn(
                  'w-full px-3 py-1.5 text-left hover:bg-white/[0.05] transition-colors',
                  idx === fileMenuIndex ? 'bg-white/[0.05]' : ''
                )}
              >
                <span className="text-[12px] text-jb-accent font-mono">{file}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Attached file chips */}
      {attachedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2 px-1">
          {attachedFiles.map(f => (
            <div
              key={f.path}
              className="flex items-center gap-1 bg-jb-accent/10 border border-jb-accent/20 rounded-md px-2 py-0.5 group"
            >
              <span className="text-[11px] text-jb-accent font-mono truncate max-w-[180px]">@{f.path}</span>
              {f.loading && <span className="text-[10px] text-white/30">...</span>}
              <button
                type="button"
                onClick={() => {
                  setAttachedFiles(prev => prev.filter(a => a.path !== f.path));
                  // Also remove the @ mention from input text
                  setInput(prev => prev.replace(new RegExp('@' + f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*'), ''));
                }}
                className="text-white/20 hover:text-white/60 transition-colors ml-0.5"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mt-2 px-1 flex-wrap">
        {slashCommands.map((cmd) => (
          <button
            key={cmd.id}
            type="button"
            onClick={() => {
              setInput(cmd.id + ' ');
              inputRef.current?.focus();
            }}
            className="text-[10px] text-white/30 hover:text-white/50 transition-colors px-1.5 py-0.5 rounded hover:bg-white/[0.05]"
            title={cmd.description}
          >
            {cmd.id}
          </button>
        ))}
      </div>
    </div>
  );
};
