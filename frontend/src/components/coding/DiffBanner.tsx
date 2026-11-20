import React, { useState } from 'react';
import { Check, X, Sparkles, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { StagedDiff } from '../../store/codingSlice';

interface Props {
  diffs: StagedDiff[];
  onApplyAll: () => void;
  onRejectAll: () => void;
  onToggleStatus: (callId: string, status: 'approved' | 'rejected') => void;
}

function countChangedLines(original: string, modified: string): { added: number; removed: number } {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  let added = 0;
  let removed = 0;

  // Simple LCS-free heuristic: count lines unique to each side
  const origSet = new Set(origLines);
  const modSet = new Set(modLines);
  for (const line of modLines) { if (!origSet.has(line)) added++; }
  for (const line of origLines) { if (!modSet.has(line)) removed++; }

  return { added, removed };
}

const DiffLinePreview: React.FC<{ original: string; modified: string }> = ({ original, modified }) => {
  const origLines = original.split('\n');
  const modLines = modified.split('\n');
  const maxLines = Math.max(origLines.length, modLines.length);
  const displayLines = Math.min(maxLines, 30); // cap preview

  const lines: Array<{ type: 'same' | 'added' | 'removed'; content: string }> = [];
  for (let i = 0; i < displayLines; i++) {
    const orig = origLines[i];
    const mod = modLines[i];
    if (orig === mod) {
      lines.push({ type: 'same', content: mod ?? '' });
    } else {
      if (orig !== undefined) lines.push({ type: 'removed', content: orig });
      if (mod !== undefined) lines.push({ type: 'added', content: mod });
    }
  }

  return (
    <div className="font-mono text-[10px] leading-relaxed max-h-[180px] overflow-y-auto bg-black/20 rounded p-2">
      {lines.map((line, i) => (
        <div key={i} className={cn(
          'px-1',
          line.type === 'added' ? 'bg-emerald-500/10 text-emerald-300/80' :
          line.type === 'removed' ? 'bg-rose-500/10 text-rose-300/80 line-through' :
          'text-white/20'
        )}>
          {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}{line.content.slice(0, 120)}
        </div>
      ))}
      {maxLines > displayLines && (
        <div className="text-white/15 italic mt-1">... {maxLines - displayLines} more lines</div>
      )}
    </div>
  );
};

export const DiffBanner: React.FC<Props> = ({ diffs, onApplyAll, onRejectAll, onToggleStatus }) => {
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  if (diffs.length === 0) return null;

  const pendingCount = diffs.filter(d => d.status === 'pending').length;
  const approvedCount = diffs.filter(d => d.status === 'approved').length;
  const rejectedCount = diffs.filter(d => d.status === 'rejected').length;

  return (
    <div className="border-b border-white/[0.18] bg-jb-accent/12 shrink-0 shadow-[inset_0_0_0_1px_rgba(60,113,247,0.12)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2">
        <div className="flex items-center gap-2">
          <Sparkles size={13} className="text-jb-accent" />
          <span className="text-[11px] font-semibold text-white/70">AI Suggestions</span>
          <span className="text-[10px] text-white/30">
            ({diffs.length} file{diffs.length !== 1 ? 's' : ''}
            {pendingCount > 0 ? `, ${pendingCount} pending` : ''}
            {approvedCount > 0 ? `, ${approvedCount} approved` : ''}
            {rejectedCount > 0 ? `, ${rejectedCount} rejected` : ''})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onApplyAll}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/60 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/30 hover:border-emerald-500/80 transition-colors shadow-[inset_0_0_0_1px_rgba(16,185,129,0.25),0_4px_14px_-6px_rgba(16,185,129,0.5)]"
          >
            <Check size={12} /> Apply All
          </button>
          <button
            type="button"
            onClick={onRejectAll}
            className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-rose-500/15 border border-rose-500/55 text-rose-300 text-[11px] font-bold hover:bg-rose-500/25 hover:border-rose-500/75 transition-colors shadow-[inset_0_0_0_1px_rgba(244,63,94,0.2)]"
          >
            <X size={12} /> Reject All
          </button>
        </div>
      </div>

      {/* File list */}
      <div className="border-t border-white/[0.04]">
        {diffs.map((diff) => {
          const { added, removed } = countChangedLines(diff.original, diff.modified);
          const isExpanded = expandedFile === diff.callId;

          return (
            <div
              key={diff.callId}
              className={cn(
                'border-t border-white/[0.03]',
                diff.status === 'rejected' ? 'opacity-40' : ''
              )}
            >
              {/* File row */}
              <div
                className="flex items-center gap-2 px-4 py-1.5 cursor-pointer hover:bg-white/[0.02] transition-colors"
                onClick={() => setExpandedFile(isExpanded ? null : diff.callId)}
              >
                <button
                  type="button"
                  className="text-white/20 hover:text-white/40 shrink-0"
                >
                  {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>

                <span className="text-[11px] text-white/50 font-mono truncate flex-1 min-w-0">
                  {diff.filePath}
                </span>

                <span className="text-[10px] text-emerald-400/60">+{added}</span>
                <span className="text-[10px] text-rose-400/60">-{removed}</span>

                {/* Status badge */}
                <span className={cn(
                  'text-[9px] px-1.5 py-0.5 rounded font-medium shrink-0',
                  diff.status === 'approved' ? 'bg-emerald-500/15 text-emerald-400' :
                  diff.status === 'rejected' ? 'bg-rose-500/15 text-rose-400' :
                  'bg-white/[0.06] text-white/30'
                )}>
                  {diff.status}
                </span>

                {/* Per-file actions */}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleStatus(diff.callId, 'approved'); }}
                  className={cn(
                    'p-0.5 rounded shrink-0 transition-colors',
                    diff.status === 'approved' ? 'text-emerald-400 bg-emerald-500/15' : 'text-white/15 hover:text-emerald-400 hover:bg-emerald-500/10'
                  )}
                  title="Approve"
                >
                  <Check size={11} />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToggleStatus(diff.callId, 'rejected'); }}
                  className={cn(
                    'p-0.5 rounded shrink-0 transition-colors',
                    diff.status === 'rejected' ? 'text-rose-400 bg-rose-500/15' : 'text-white/15 hover:text-rose-400 hover:bg-rose-500/10'
                  )}
                  title="Reject"
                >
                  <X size={11} />
                </button>
              </div>

              {/* Expanded diff preview */}
              {isExpanded && (
                <div className="px-4 pb-2 pt-1">
                  {diff.description && (
                    <p className="text-[10px] text-white/30 mb-1 italic">{diff.description}</p>
                  )}
                  <DiffLinePreview original={diff.original} modified={diff.modified} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
