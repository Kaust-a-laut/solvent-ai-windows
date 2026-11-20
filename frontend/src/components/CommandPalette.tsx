import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare, Code, Globe, Sparkles, FlaskConical,
  Brain, Search, FileText, Terminal, Settings,
  Command, X, ScanEye, Swords, GitCompare, Users, NotebookPen, Home
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { cn } from '../lib/utils';

type ModeId = 'home' | 'chat' | 'vision' | 'coding' | 'browser' | 'notepad' | 'model_playground' | 'compare' | 'debate' | 'collaborate' | 'waterfall';

interface CommandItem {
  id: string;
  label: string;
  icon: React.ElementType;
  category: 'mode' | 'action' | 'file';
  shortcut?: string;
  action: () => void;
}

const COMMAND_PALETTE_STORAGE_KEY = 'solvent-command-recent';
const MAX_RECENT = 8;

const loadRecentIds = (): string[] => {
  try {
    const stored = localStorage.getItem(COMMAND_PALETTE_STORAGE_KEY);
    return stored ? JSON.parse(stored) as string[] : [];
  } catch { return []; }
};

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ open, onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const {
    currentMode, setCurrentMode, openFiles, setActiveFile,
    setSettingsOpen, toggleCommandCenter,
    setMemoryVisible, setTerminalVisible,
  } = useAppStore();

  // Build commands
  const commands: CommandItem[] = useMemo(() => [
    // Modes
    { id: 'mode-home', label: 'Overview', icon: Home, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('home' as ModeId) },
    { id: 'mode-chat', label: 'Chat', icon: MessageSquare, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('chat' as ModeId) },
    { id: 'mode-vision', label: 'SolventSee Lab', icon: ScanEye, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('vision' as ModeId) },
    { id: 'mode-coding', label: 'Coding Suite', icon: Code, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('coding' as ModeId) },
    { id: 'mode-browser', label: 'Web Search', icon: Globe, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('browser' as ModeId) },
    { id: 'mode-notepad', label: 'Notepad', icon: NotebookPen, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('notepad' as ModeId) },
    { id: 'mode-model_playground', label: 'Lab Center', icon: Sparkles, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('model_playground' as ModeId) },
    { id: 'mode-compare', label: 'Compare', icon: GitCompare, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('compare' as ModeId) },
    { id: 'mode-debate', label: 'Debate', icon: Swords, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('debate' as ModeId) },
    { id: 'mode-collaborate', label: 'Multi-Agent', icon: Users, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('collaborate' as ModeId) },
    { id: 'mode-waterfall', label: 'Waterfall Lab', icon: FlaskConical, category: 'mode' as const, shortcut: '', action: () => setCurrentMode('waterfall' as ModeId) },

    // Actions
    { id: 'action-command-center', label: 'Open Command Center', icon: Command, category: 'action' as const, shortcut: '', action: () => toggleCommandCenter() },
    { id: 'action-settings', label: 'Settings', icon: Settings, category: 'action' as const, shortcut: '', action: () => setSettingsOpen(true) },
    { id: 'action-memory', label: 'View Agent Memory', icon: Brain, category: 'action' as const, shortcut: '', action: () => setMemoryVisible(true) },
    { id: 'action-terminal', label: 'Toggle Terminal', icon: Terminal, category: 'action' as const, shortcut: '', action: () => setTerminalVisible(!useAppStore.getState().terminalVisible) },

    // Files
    ...openFiles.map(f => ({
      id: `file-${f.path}`,
      label: f.path,
      icon: FileText,
      category: 'file' as const,
      action: () => setActiveFile(f.path),
    })),
  ], [openFiles, setActiveFile, setCurrentMode, toggleCommandCenter, setSettingsOpen, setMemoryVisible, setTerminalVisible]);

  const [recentIds, setRecentIds] = useState<string[]>(() => loadRecentIds());

  // Reset transient state on the open transition (render-adjust idiom — an
  // effect would paint one frame with the stale query/selection first), and
  // refresh recents in case another surface recorded usage.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setRecentIds(loadRecentIds());
    }
  }

  const recordRecent = useCallback((id: string) => {
    setRecentIds(prev => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, MAX_RECENT);
      try {
        localStorage.setItem(COMMAND_PALETTE_STORAGE_KEY, JSON.stringify(next));
      } catch { /* storage full — ignore */ }
      return next;
    });
  }, []);

  // Filter commands by query
  const filteredCommands = useMemo(() => {
    if (!query.trim()) {
      // When no query: show recent items first, then all commands
      const recent = recentIds
        .map((id: string) => commands.find(c => c.id === id))
        .filter(Boolean) as CommandItem[];
      const remaining = commands.filter(c => !recentIds.includes(c.id));
      return [...recent.slice(0, 4), ...remaining.slice(0, 16)];
    }
    const q = query.toLowerCase();
    return commands.filter(c => c.label.toLowerCase().includes(q));
  }, [query, commands, recentIds]);

  // Focus input on open (selection/query resets happen in the render-adjust
  // block above; query edits reset selection at the onChange site).
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filteredCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && filteredCommands[selectedIndex]) {
      e.preventDefault();
      const cmd = filteredCommands[selectedIndex]!;
      cmd.action();
      recordRecent(cmd.id);
      onClose();
    }
  }, [filteredCommands, selectedIndex, onClose, recordRecent]);

  // Scroll selected into view
  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Group by category for display
  const groups = useMemo(() => {
    const result: { category: string; items: CommandItem[] }[] = [];
    const seen = new Set<string>();
    for (const cmd of filteredCommands) {
      const cat = cmd.category;
      if (!seen.has(cat)) {
        seen.add(cat);
        result.push({
          category: cat === 'mode' ? 'Modes' : cat === 'action' ? 'Actions' : 'Files',
          items: [],
        });
      }
      result[result.length - 1]!.items.push(cmd);
    }
    return result;
  }, [filteredCommands]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[10000] flex items-start justify-center"
          onClick={onClose}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Palette */}
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.98 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-[580px] mt-[80px] mx-4 rounded-2xl border border-white/10 bg-[#0a0a14] shadow-[0_0_60px_rgba(0,0,0,0.8)] overflow-hidden"
          >
            {/* Search input */}
            <div className="flex items-center gap-3 px-5 py-4 border-b border-white/8">
              <Search size={16} className="text-white/30 shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
                onKeyDown={handleKeyDown}
                placeholder="Type a command or search files..."
                className="flex-1 bg-transparent border-none outline-none text-sm font-medium text-white placeholder:text-white/25"
              />
              {query && (
                <button
                  onClick={() => { setQuery(''); setSelectedIndex(0); }}
                  className="p-0.5 rounded text-white/20 hover:text-white/50 transition-colors"
                >
                  <X size={14} />
                </button>
              )}
              <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] font-mono text-white/30">ESC</kbd>
            </div>

            {/* Results */}
            <div ref={listRef} className="max-h-[360px] overflow-y-auto py-2 scrollbar-thin">
              {filteredCommands.length === 0 && (
                <div className="px-5 py-8 text-center text-[12px] text-white/20">
                  No results for &ldquo;{query}&rdquo;
                </div>
              )}

              {groups.map((group) => (
                <div key={group.category}>
                  <div className="px-5 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-white/20">
                    {group.category}
                  </div>
                  {group.items.map((cmd) => {
                    const globalIdx = filteredCommands.indexOf(cmd);
                    const isSelected = globalIdx === selectedIndex;
                    const isActive = cmd.id === `mode-${currentMode}`;
                    return (
                      <button
                        key={cmd.id}
                        onMouseEnter={() => setSelectedIndex(globalIdx)}
                        onClick={() => { cmd.action(); recordRecent(cmd.id); onClose(); }}
                        className={cn(
                          'w-full flex items-center gap-3 px-5 py-2.5 text-left transition-colors',
                          isSelected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]',
                          isActive && 'bg-jb-accent/5'
                        )}
                      >
                        <cmd.icon
                          size={15}
                          className={cn(
                            'shrink-0 transition-colors',
                            isSelected ? 'text-white/60' : 'text-white/25',
                            isActive && 'text-jb-accent/70'
                          )}
                        />
                        <span className={cn(
                          'text-[12px] font-medium truncate transition-colors',
                          isSelected ? 'text-white/80' : 'text-white/40',
                          isActive && 'text-jb-accent/80'
                        )}>
                          {cmd.label}
                        </span>
                        {cmd.shortcut && (
                          <kbd className="ml-auto px-1.5 py-0.5 rounded bg-white/5 border border-white/10 text-[10px] font-mono text-white/20 shrink-0">
                            {cmd.shortcut}
                          </kbd>
                        )}
                        {isActive && (
                          <span className="ml-auto text-[9px] font-bold uppercase tracking-wider text-jb-accent/50 shrink-0">
                            Active
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-4 px-5 py-2.5 border-t border-white/5 text-[10px] text-white/20">
              <span><kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/8 text-[9px] font-mono text-white/30">↑↓</kbd> Navigate</span>
              <span><kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/8 text-[9px] font-mono text-white/30">↵</kbd> Select</span>
              <span><kbd className="px-1 py-0.5 rounded bg-white/5 border border-white/8 text-[9px] font-mono text-white/30">ESC</kbd> Close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
