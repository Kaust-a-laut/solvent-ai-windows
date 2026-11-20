import React, { useState } from 'react';
import {
  FilePen, FilePlus, FileX, Replace, FlaskConical, Hammer,
  GitCommit, Package, Terminal, ChevronDown, ChevronRight,
  Loader2, Check, AlertCircle,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import type { ToolEvent } from '../../store/codingSlice';

interface Props {
  startEvent: ToolEvent;
  resultEvent?: ToolEvent;
  previousContent?: string;
}

const LOG_TOOLS = new Set([
  'read_file', 'list_files', 'get_file_outline', 'grep_files',
  'git_status', 'git_diff', 'get_project_info', 'fetch_web_content',
  'web_search', 'ide_open_file', 'ide_show_diff',
]);

function computeLineDiff(oldContent: string, newContent: string): Array<{ type: 'add' | 'remove' | 'context'; line: string }> {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = (dp[i - 1]![j - 1] ?? 0) + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j] ?? 0, dp[i]![j - 1] ?? 0);
      }
    }
  }
  const temp: Array<{ type: 'add' | 'remove' | 'context'; line: string }> = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      temp.push({ type: 'context', line: oldLines[i - 1]! });
      i--; j--;
    } else if (j > 0 && (i === 0 || (dp[i]![j - 1] ?? 0) >= (dp[i - 1]![j] ?? 0))) {
      temp.push({ type: 'add', line: newLines[j - 1]! });
      j--;
    } else if (i > 0) {
      temp.push({ type: 'remove', line: oldLines[i - 1]! });
      i--;
    } else {
      j--;
    }
  }
  return temp.reverse();
}

const DiffView: React.FC<{ oldContent: string; newContent: string }> = ({ oldContent, newContent }) => {
  const diff = computeLineDiff(oldContent, newContent);
  return (
    <pre className="text-[11px] font-mono leading-relaxed">
      {diff.map((d, idx) => (
        <div key={idx} className={cn(
          'px-1',
          d.type === 'add' ? 'bg-emerald-500/10 text-emerald-300' :
          d.type === 'remove' ? 'bg-rose-500/10 text-rose-300' :
          'text-white/30'
        )}>
          <span className="select-none mr-2 opacity-40">
            {d.type === 'add' ? '+' : d.type === 'remove' ? '−' : ' '}
          </span>
          {d.line}
        </div>
      )).slice(0, 60)}
      {diff.length > 60 && <div className="text-white/30 italic px-1">...{diff.length - 60} more lines</div>}
    </pre>
  );
};

const FileWriteCard: React.FC<Props & { expanded: boolean; onToggle: () => void }> = ({ startEvent, resultEvent, previousContent, expanded, onToggle }) => {
  const path = startEvent.args?.path as string ?? 'unknown';
  const filename = path.split('/').pop() || path;
  const isPending = !resultEvent;
  const isError = resultEvent?.type === 'tool_error';

  let summary = '';
  let added = 0, removed = 0;
  if (resultEvent && !isError && previousContent) {
    const newContent = typeof resultEvent.result === 'string' ? resultEvent.result : '';
    const diff = computeLineDiff(previousContent, newContent);
    added = diff.filter(d => d.type === 'add').length;
    removed = diff.filter(d => d.type === 'remove').length;
    summary = `+${added} −${removed}`;
  } else if (resultEvent && !isError) {
    summary = '(modified)';
  } else if (isError) {
    summary = 'failed';
  }

  return (
    <div className={cn(
      'rounded-lg border cursor-pointer transition-colors',
      isError ? 'border-rose-500/20 bg-rose-500/5' : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
    )} role="button" onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        {isPending ? <Loader2 size={12} className="animate-spin text-white/40" /> :
         isError ? <AlertCircle size={12} className="text-rose-400" /> :
         <FilePen size={12} className="text-emerald-400" />}
        <span className="font-mono truncate flex-1 text-white/70">{filename}</span>
        {!isPending && <span className={cn('shrink-0', isError ? 'text-rose-400' : 'text-white/40')}>{summary}</span>}
        {expanded ? <ChevronDown size={12} className="text-white/30 shrink-0" /> : <ChevronRight size={12} className="text-white/30 shrink-0" />}
      </div>
      {expanded && !isPending && !isError && previousContent && (
        <div className="border-t border-white/[0.05] p-3 max-h-[60] overflow-auto">
          <DiffView oldContent={previousContent} newContent={typeof resultEvent?.result === 'string' ? resultEvent.result : ''} />
        </div>
      )}
      {expanded && !isPending && !isError && !previousContent && (
        <div className="border-t border-white/[0.05] p-3">
          <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-[60] overflow-auto">
            {typeof resultEvent?.result === 'string' ? resultEvent.result : ''}
          </pre>
        </div>
      )}
      {expanded && isError && (
        <div className="border-t border-white/[0.05] p-3">
          <pre className="text-[11px] font-mono text-rose-400 whitespace-pre-wrap">
            {resultEvent?.error ?? 'Unknown error'}
          </pre>
        </div>
      )}
    </div>
  );
};

const FileCreateCard: React.FC<Props & { expanded: boolean; onToggle: () => void }> = ({ startEvent, resultEvent, expanded, onToggle }) => {
  const path = startEvent.args?.path as string ?? 'unknown';
  const filename = path.split('/').pop() || path;
  const isPending = !resultEvent;
  const isError = resultEvent?.type === 'tool_error';
  const content = typeof resultEvent?.result === 'string' ? resultEvent.result : '';
  const lineCount = content ? content.split('\n').length : 0;

  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04] cursor-pointer transition-colors" role="button" onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        {isPending ? <Loader2 size={12} className="animate-spin text-white/40" /> :
         isError ? <AlertCircle size={12} className="text-rose-400" /> :
         <FilePlus size={12} className="text-emerald-400" />}
        <span className="font-mono truncate flex-1 text-white/70">{filename}</span>
        {!isPending && !isError && <span className="text-white/40 shrink-0">({lineCount} lines)</span>}
        {expanded ? <ChevronDown size={12} className="text-white/30 shrink-0" /> : <ChevronRight size={12} className="text-white/30 shrink-0" />}
      </div>
      {expanded && !isPending && !isError && content && (
        <div className="border-t border-white/[0.05] p-3 max-h-[60] overflow-auto">
          <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap">{content}</pre>
        </div>
      )}
    </div>
  );
};

const FileDeleteCard: React.FC<Props & { expanded: boolean; onToggle: () => void }> = ({ startEvent, expanded, onToggle }) => {
  const path = startEvent.args?.path as string ?? 'unknown';
  const filename = path.split('/').pop() || path;

  return (
    <div className="rounded-lg border border-rose-500/20 bg-rose-500/5 cursor-pointer transition-colors" role="button" onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        <FileX size={12} className="text-rose-400" />
        <span className="font-mono truncate flex-1 text-rose-400">{filename}</span>
        {expanded ? <ChevronDown size={12} className="text-rose-400/50 shrink-0" /> : <ChevronRight size={12} className="text-rose-400/50 shrink-0" />}
      </div>
      {expanded && (
        <div className="border-t border-rose-500/10 p-3">
          <pre className="text-[11px] font-mono text-rose-300/70 whitespace-pre-wrap bg-rose-500/5 rounded px-2 py-1">
            {typeof startEvent.args?.content === 'string' ? startEvent.args.content : '(content unavailable)'}
          </pre>
        </div>
      )}
    </div>
  );
};

const TestRunnerCard: React.FC<Props & { expanded: boolean; onToggle: () => void }> = ({ resultEvent, expanded, onToggle }) => {
  const isPending = !resultEvent;
  const isError = resultEvent?.type === 'tool_error';
  const result = resultEvent?.result as string | undefined;

  let statusText = 'running...';
  let isPassed = false;
  let failed = 0, total = 0;

  if (result && !isError) {
    const passMatch = result.match(/(\d+)\s+passed/);
    const failMatch = result.match(/(\d+)\s+failed/);
    total = parseInt(passMatch?.[1] ?? '0');
    failed = parseInt(failMatch?.[1] ?? '0');
    isPassed = failed === 0;
    statusText = isPassed ? `✓ ${total} / ${total} passed` : `✗ ${failed} failed / ${total}`;
  } else if (isError) {
    statusText = '✗ failed';
  }

  return (
    <div className={cn(
      'rounded-lg border cursor-pointer transition-colors',
      isPending ? 'border-white/[0.07] bg-white/[0.02]' :
      isError ? 'border-rose-500/20 bg-rose-500/5' :
      isPassed ? 'border-emerald-500/20 bg-emerald-500/5' :
      'border-rose-500/20 bg-rose-500/5'
    )} role="button" onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        {isPending ? <Loader2 size={12} className="animate-spin text-white/40" /> :
         isError ? <AlertCircle size={12} className="text-rose-400" /> :
         isPassed ? <Check size={12} className="text-emerald-400" /> :
         <AlertCircle size={12} className="text-rose-400" />}
        <FlaskConical size={12} className={cn(
          'shrink-0', isPending ? 'text-white/40' : isPassed ? 'text-emerald-400' : 'text-rose-400'
        )} />
        <span className="font-mono truncate flex-1 text-white/70">run_tests</span>
        {!isPending && <span className={cn('shrink-0', isPassed ? 'text-emerald-400' : 'text-rose-400')}>{statusText}</span>}
        {expanded && !isPending ? <ChevronDown size={12} className="text-white/30 shrink-0" /> : <ChevronRight size={12} className="text-white/30 shrink-0" />}
      </div>
      {expanded && !isPending && result && (
        <div className="border-t border-white/[0.05] p-3">
          <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-[15] overflow-auto">{result}</pre>
        </div>
      )}
      {expanded && isError && resultEvent?.error && (
        <div className="border-t border-white/[0.05] p-3">
          <pre className="text-[11px] font-mono text-rose-400 whitespace-pre-wrap">{resultEvent.error}</pre>
        </div>
      )}
    </div>
  );
};

const BuildCheckCard: React.FC<Props & { expanded: boolean; onToggle: () => void }> = ({ resultEvent, expanded, onToggle }) => {
  const errors = resultEvent?.result as { errors: string | null } | undefined;
  const isClean = errors?.errors == null;

  return (
    <div className={cn(
      'rounded-lg border cursor-pointer transition-colors',
      isClean ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-amber-500/20 bg-amber-500/5'
    )} role="button" onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        {isClean ? <Check size={12} className="text-emerald-400" /> : <AlertCircle size={12} className="text-amber-400" />}
        <Hammer size={12} className={cn('shrink-0', isClean ? 'text-emerald-400' : 'text-amber-400')} />
        <span className="font-mono truncate flex-1 text-white/70">build check</span>
        {isClean ? (
          <span className="text-emerald-400 shrink-0">✓ clean</span>
        ) : (
          <span className="text-amber-400 shrink-0">✗ {errors?.errors?.split('\n').length ?? 0} errors</span>
        )}
        {!isClean && (expanded ? <ChevronDown size={12} className="text-white/30 shrink-0" /> : <ChevronRight size={12} className="text-white/30 shrink-0" />)}
      </div>
      {expanded && !isClean && errors?.errors && (
        <div className="border-t border-white/[0.05] p-3">
          <pre className="text-[11px] font-mono text-amber-300 whitespace-pre-wrap max-h-[15] overflow-auto">{errors.errors}</pre>
        </div>
      )}
    </div>
  );
};

const GitCommitCard: React.FC<Props> = ({ startEvent, resultEvent }) => {
  const message = startEvent.args?.message as string ?? '';
  const result = typeof resultEvent?.result === 'string' ? resultEvent.result : '';
  const shaMatch = result.match(/sha:\s*([a-f0-9]+)/i);
  const sha = shaMatch?.[1] ? shaMatch[1].slice(0, 7) : '';

  return (
    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[12px]">
      <div className="flex items-center gap-2">
        <Check size={12} className="text-emerald-400 shrink-0" />
        <GitCommit size={12} className="text-emerald-400 shrink-0" />
        <span className="font-mono truncate flex-1 text-white/70">git commit</span>
        <span className="text-emerald-400 shrink-0">&ldquo;{message}&rdquo;</span>
        {sha && <span className="text-white/30 font-mono shrink-0">({sha})</span>}
      </div>
    </div>
  );
};

const ShellCard: React.FC<Props & { expanded: boolean; onToggle: () => void }> = ({ startEvent, resultEvent, expanded, onToggle }) => {
  const command = startEvent.args?.command as string ?? '';
  const shortCmd = command.length > 50 ? command.slice(0, 50) + '…' : command;
  const isPending = !resultEvent;
  const exitCode = resultEvent?.result ? (resultEvent.result as { exitCode?: number })?.exitCode : undefined;

  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04] cursor-pointer transition-colors" role="button" onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        {isPending ? <Loader2 size={12} className="animate-spin text-white/40" /> : <Terminal size={12} className="text-white/40 shrink-0" />}
        <span className="font-mono truncate flex-1 text-white/70">$ {shortCmd}</span>
        {!isPending && exitCode !== undefined && <span className="text-white/40 shrink-0">exit {exitCode}</span>}
        {expanded ? <ChevronDown size={12} className="text-white/30 shrink-0" /> : <ChevronRight size={12} className="text-white/30 shrink-0" />}
      </div>
      {expanded && !!resultEvent?.result && (
        <div className="border-t border-white/[0.05] p-3">
          <pre className="text-[11px] font-mono text-slate-300 whitespace-pre-wrap max-h-[15] overflow-auto">
            {typeof resultEvent!.result === 'string' ? resultEvent!.result : JSON.stringify(resultEvent!.result, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

const InstallPackageCard: React.FC<Props & { expanded: boolean; onToggle: () => void }> = ({ startEvent, resultEvent, expanded, onToggle }) => {
  const pkg = startEvent.args?.package as string ?? 'unknown';
  const isPending = !resultEvent;
  const isError = resultEvent?.type === 'tool_error';

  return (
    <div className={cn(
      'rounded-lg border cursor-pointer transition-colors',
      isError ? 'border-rose-500/20 bg-rose-500/5' : 'border-white/[0.07] bg-white/[0.02]'
    )} role="button" onClick={onToggle} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onToggle()}>
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        {isPending ? <Loader2 size={12} className="animate-spin text-white/40" /> :
         isError ? <AlertCircle size={12} className="text-rose-400" /> :
         <Check size={12} className="text-emerald-400" />}
        <Package size={12} className="text-white/40 shrink-0" />
        <span className="font-mono truncate flex-1 text-white/70">npm install {pkg}</span>
        {!isPending && <span className={cn('shrink-0', isError ? 'text-rose-400' : 'text-emerald-400')}>{isError ? '✗ failed' : '✓ done'}</span>}
        {expanded && !isPending ? <ChevronDown size={12} className="text-white/30 shrink-0" /> : <ChevronRight size={12} className="text-white/30 shrink-0" />}
      </div>
      {expanded && isError && resultEvent?.error && (
        <div className="border-t border-white/[0.05] p-3">
          <pre className="text-[11px] font-mono text-rose-400 whitespace-pre-wrap">{resultEvent.error}</pre>
        </div>
      )}
    </div>
  );
};

const LogEntry: React.FC<Props> = ({ startEvent, resultEvent }) => {
  const tool = startEvent.tool;
  const path = startEvent.args?.path as string;
  const query = startEvent.args?.query as string;
  const url = startEvent.args?.url as string;
  const command = startEvent.args?.command as string;
  const target = path || query || url || command || '';
  const shortTarget = target.length > 50 ? '...' + target.slice(-47) : target;

  let verb = tool.replace('_', ' ');
  if (tool === 'read_file') verb = 'read';
  else if (tool === 'list_files') verb = 'list';
  else if (tool === 'grep_files') verb = 'grep';
  else if (tool === 'web_search') verb = 'search';
  else if (tool === 'fetch_web_content') verb = 'fetch';

  let summary = '';
  if (resultEvent && tool === 'grep_files') {
    const result = typeof resultEvent.result === 'string' ? resultEvent.result : '';
    const lines = result.split('\n').filter(Boolean).length;
    summary = `→ ${lines} match${lines !== 1 ? 'es' : ''}`;
  }

  return (
    <div data-variant="log" className="flex items-center gap-1.5 py-0.5 text-[11px] text-white/30 font-mono">
      <span className="shrink-0">▷</span>
      <span className="truncate">{verb}</span>
      {shortTarget && <span className="truncate text-white/20">{shortTarget}</span>}
      {summary && <span className="shrink-0 text-white/20">{summary}</span>}
    </div>
  );
};

export const AgentActionCard: React.FC<Props> = ({ startEvent, resultEvent, previousContent }) => {
  const [expanded, setExpanded] = useState(false);
  const tool = startEvent.tool;

  if (LOG_TOOLS.has(tool)) {
    return <LogEntry startEvent={startEvent} resultEvent={resultEvent} />;
  }

  const props = { startEvent, resultEvent, previousContent, expanded, onToggle: () => setExpanded(!expanded) };

  switch (tool) {
    case 'write_file':
    case 'edit_file':
      return <FileWriteCard {...props} />;
    case 'create_file':
      return <FileCreateCard {...props} />;
    case 'delete_file':
      return <FileDeleteCard {...props} />;
    case 'run_tests':
      return <TestRunnerCard {...props} />;
    case '__build_check__':
      return <BuildCheckCard {...props} />;
    case 'git_commit':
      return <GitCommitCard startEvent={startEvent} resultEvent={resultEvent} />;
    case 'run_shell':
    case 'ide_run_in_sandbox':
      return <ShellCard {...props} />;
    case 'install_package':
      return <InstallPackageCard {...props} />;
    case 'replace_in_files':
      return (
        <div className="rounded-lg border border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04] cursor-pointer transition-colors px-3 py-2 text-[12px]" role="button" onClick={() => setExpanded(!expanded)} tabIndex={0}>
          <div className="flex items-center gap-2">
            <Replace size={12} className="text-white/40 shrink-0" />
            <span className="font-mono text-white/70">Replace in {startEvent.args?.files ? (startEvent.args.files as []).length : '?'} files</span>
          </div>
        </div>
      );
    default:
      return <LogEntry startEvent={startEvent} resultEvent={resultEvent} />;
  }
};
