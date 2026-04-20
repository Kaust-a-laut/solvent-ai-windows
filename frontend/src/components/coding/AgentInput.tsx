import React, { useState, useRef, useCallback } from 'react';
import { Send, Square, Paperclip } from 'lucide-react';
import { cn } from '../../lib/utils';

interface Props {
  isGenerating: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onAttach: (fileName: string, content: string) => void;
}

const SLASH_COMMANDS = [
  { id: '/fix', description: 'Fix the current file' },
  { id: '/explain', description: 'Explain the selected code' },
  { id: '/test', description: 'Generate tests for current file' },
];

export const AgentInput: React.FC<Props> = ({
  isGenerating,
  onSend,
  onStop,
  onAttach,
}) => {
  const [input, setInput] = useState('');
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    if (!input.trim() || isGenerating) return;
    onSend(input.trim());
    setInput('');
    setShowSlashMenu(false);
  }, [input, isGenerating, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === 'Escape') {
      setShowSlashMenu(false);
    } else if (showSlashMenu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashMenuIndex((i) => (i + 1) % SLASH_COMMANDS.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashMenuIndex((i) => (i - 1 + SLASH_COMMANDS.length) % SLASH_COMMANDS.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const cmd = SLASH_COMMANDS[slashMenuIndex];
        if (cmd) {
          setInput(cmd.id + ' ');
          setShowSlashMenu(false);
          inputRef.current?.focus();
        }
      }
    }
  }, [handleSend, showSlashMenu, slashMenuIndex]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    
    if (value === '/') {
      setShowSlashMenu(true);
      setSlashMenuIndex(0);
    } else if (!value.startsWith('/')) {
      setShowSlashMenu(false);
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
    <div className="border-t border-white/[0.06] p-3">
      <div className="relative">
        <div className="flex items-end gap-2 bg-white/[0.03] border border-white/[0.06] rounded-xl px-3 py-2 focus-within:border-jb-accent/30 transition-colors">
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
                ? 'bg-rose-500/10 text-rose-400 hover:bg-rose-500/20'
                : input.trim()
                  ? 'bg-jb-accent/20 text-jb-accent hover:bg-jb-accent/30'
                  : 'bg-white/[0.05] text-white/30 cursor-not-allowed'
            )}
          >
            {isGenerating ? <Square size={14} fill="currentColor" /> : <Send size={14} />}
          </button>
        </div>

        {showSlashMenu && (
          <div className="absolute bottom-full left-0 mb-2 py-1 bg-jb-panel border border-white/[0.06] rounded-lg shadow-xl z-10 min-w-[200px]">
            {SLASH_COMMANDS.map((cmd, idx) => (
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
      </div>

      <div className="flex items-center gap-2 mt-2 px-1">
        {SLASH_COMMANDS.map((cmd) => (
          <button
            key={cmd.id}
            type="button"
            onClick={() => {
              setInput(cmd.id + ' ');
              inputRef.current?.focus();
            }}
            className="text-[10px] text-white/30 hover:text-white/50 transition-colors px-1.5 py-0.5 rounded hover:bg-white/[0.05]"
          >
            {cmd.id}
          </button>
        ))}
      </div>
    </div>
  );
};
