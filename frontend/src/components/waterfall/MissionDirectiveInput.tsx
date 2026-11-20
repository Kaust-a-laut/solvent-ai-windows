import React from 'react';
import { Sparkles } from 'lucide-react';
import { cn } from '../../lib/utils';

interface MissionDirectiveInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  isStreaming: boolean;
  rows?: number;
  vibrantBorder?: boolean;
}

export function MissionDirectiveInput({
  value,
  onChange,
  onSubmit,
  isStreaming,
  rows = 3,
  vibrantBorder = false,
}: MissionDirectiveInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={cn('rounded-[2rem]', vibrantBorder && 'vibrant-border')}>
      <div className="surface-1 bg-white/[0.075] rounded-[2rem] overflow-hidden backdrop-blur-xl relative shadow-[0_0_40px_-12px_rgba(60,113,247,0.25),0_0_80px_-20px_rgba(157,91,210,0.18)]">
        {/* Top accent bar marks this as the primary entry point */}
        <div className="h-[2px] w-full bg-gradient-to-r from-jb-accent via-jb-purple to-jb-orange opacity-80" />
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-center gap-2">
            <div className="w-1 h-3 rounded-full bg-jb-accent shadow-[0_0_8px_rgba(60,113,247,0.8)]" />
            <span className="text-[12px] font-black text-white uppercase tracking-[0.3em]">
              Mission Directive
            </span>
          </div>
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the complex task for the pipeline to orchestrate..."
            rows={rows}
            disabled={isStreaming}
            className="w-full bg-transparent text-[15px] font-medium text-white placeholder:text-slate-500 resize-none outline-none leading-relaxed input-focus-ring disabled:opacity-50 transition-opacity"
          />
          <div className="flex items-center justify-between pt-2 border-t border-white/[0.12]">
            <span className="text-[11px] text-slate-300 font-mono">⌘↩ to submit</span>
            <button
              onClick={onSubmit}
              disabled={!value.trim() || isStreaming}
              className="cta-primary flex items-center gap-2.5 px-7 py-3 text-[12px] font-black uppercase tracking-[0.25em]"
            >
              <Sparkles size={15} className={isStreaming ? 'animate-pulse' : ''} />
              {isStreaming ? 'Processing...' : 'Initiate'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
