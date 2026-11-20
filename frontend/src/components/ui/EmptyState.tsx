import React from 'react';
import { motion } from 'framer-motion';
import { LucideIcon, ArrowRight, Code, Terminal, FileText, Lightbulb } from 'lucide-react';

interface SuggestedPrompt {
  label: string;
  onClick: () => void;
  icon?: LucideIcon;
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  accentColor?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: LucideIcon;
  };
  shortcuts?: Array<{
    key: string;
    label: string;
  }>;
  /** Grid of suggested prompts shown below the description. */
  prompts?: SuggestedPrompt[];
}

const PROMPT_ICONS = [Code, Terminal, FileText, Lightbulb];

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  shortcuts,
  prompts,
}: EmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="flex-1 flex flex-col items-center justify-center gap-5 py-20 pointer-events-auto select-none"
    >
      <div className="relative">
        <div className="w-14 h-14 rounded-2xl bg-white/[0.03] border border-white/[0.06] flex items-center justify-center">
          <Icon className="w-6 h-6 text-jb-accent/60" />
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 max-w-xs text-center">
        <p className="text-sm font-semibold text-slate-300">{title}</p>
        <p className="text-[13px] text-slate-300 leading-relaxed">{description}</p>
      </div>

      {action && (
        <button
          onClick={action.onClick}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium
            bg-jb-accent/10 border border-jb-accent/20 text-jb-accent
            hover:bg-jb-accent/15 hover:border-jb-accent/30
            transition-all duration-200"
        >
          {action.icon && <action.icon className="w-4 h-4" />}
          {action.label}
        </button>
      )}

      {prompts && prompts.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg mt-2">
          {prompts.map((p, idx) => {
            const PromptIcon = p.icon ?? PROMPT_ICONS[idx % 4] ?? ArrowRight;
            const borderClass = [
              'border-t-blue-500/40 border-l-blue-500/40 hover:border-t-blue-400/70 hover:border-l-blue-400/70',
              'border-t-orange-500/40 border-r-orange-500/40 hover:border-t-orange-400/70 hover:border-r-orange-400/70',
              'border-b-orange-500/40 border-l-orange-500/40 hover:border-b-orange-400/70 hover:border-l-orange-400/70',
              'border-b-blue-500/40 border-r-blue-500/40 hover:border-b-blue-400/70 hover:border-r-blue-400/70',
            ][idx % 4];
            return (
              <button
                key={idx}
                onClick={p.onClick}
                className={`group relative flex items-center gap-3 px-4 py-2.5 rounded-xl text-left
                  bg-white/[0.02] border border-white/[0.08] ${borderClass}
                  hover:bg-white/[0.04] hover:border-white/15
                  transition-all duration-200`}
              >
                <PromptIcon className="w-4 h-4 text-white/25 group-hover:text-jb-accent/60 shrink-0 transition-colors" />
                <span className="text-[12px] text-white/40 group-hover:text-white/70 leading-snug transition-colors">
                  {p.label}
                </span>
                <ArrowRight size={12} className="w-3 h-3 text-white/10 group-hover:text-white/40 ml-auto shrink-0 transition-all group-hover:translate-x-0.5" />
              </button>
            );
          })}
        </div>
      )}

      {shortcuts && shortcuts.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-2">
          {shortcuts.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-[11px] text-slate-400">
              <kbd className="font-mono px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/[0.08] text-slate-300">
                {s.key}
              </kbd>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </motion.div>
  );
}
