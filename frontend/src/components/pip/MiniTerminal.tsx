import React, { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';

const TERMINAL_COLOR_MAP: [RegExp, string][] = [
  [/^\[SYSTEM\]/,    'text-jb-accent/60'],
  [/^\[ERROR\]/,     'text-rose-400'],
  [/^\[STDERR\]/,    'text-rose-400/70'],
  [/^\[WATERFALL\]/, 'text-jb-purple/70'],
  [/^\[AGENT\]/,     'text-emerald-400/70'],
];

export const MiniTerminal: React.FC<{ lines: string[] }> = ({ lines }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);

  const tail = lines.slice(-40);
  return (
    <div
      ref={ref}
      className="flex-1 bg-black/40 rounded-xl border border-white/[0.04] p-2.5 overflow-y-auto fluid-scrollbar font-mono text-[10px] leading-[1.6] min-h-0"
    >
      {tail.length === 0 ? (
        <div className="h-full flex items-center justify-center opacity-15">
          <span className="text-[10px] font-medium uppercase tracking-wider">Terminal empty</span>
        </div>
      ) : (
        tail.map((line, i) => {
          const colorCls = TERMINAL_COLOR_MAP.find(([re]) => re.test(line))?.[1] || 'text-slate-400';
          return (
            <div key={i} className={cn('whitespace-pre-wrap break-all', colorCls)}>
              {line}
            </div>
          );
        })
      )}
    </div>
  );
};
