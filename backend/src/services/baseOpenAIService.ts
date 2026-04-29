import axios from 'axios';
import { randomUUID } from 'crypto';
import { AIProvider, ChatMessage, CompletionOptions } from '../types/ai';
import { toolService } from './toolService';
import { getOpenAITools } from '../constants/tools';
import { logger } from '../utils/logger';
import { config } from '../config';
import { normalizeMessages } from '../utils/messageUtils';
import type { AgentEvent } from '../types/agentEvents';
import { spawn as nodeSpawn } from 'child_process';
import nodePath from 'path';
import { PROJECT_ROOT, getEffectiveProjectRoot } from '../utils/fileSystem';
import { agentScratchpadService } from './agentScratchpad';
import { delegationService, parseDelegationTags } from './delegationService';

/**
 * Simple XML tool call parser using string operations to avoid regex issues.
 * Parses formats like: <tool_name><param>value</param></tool_name>
 */
function parseXmlToolCalls(content: string, validNames: string[]): Array<{id: string; name: string; args: Record<string, unknown>}> {
  const calls: Array<{id: string; name: string; args: Record<string, unknown>}> = [];
  
  for (const name of validNames) {
    const openTag = '<' + name + '>';
    const closeTag = '</' + name + '>';
    let searchPos = 0;
    
    while (true) {
      const openIdx = content.indexOf(openTag, searchPos);
      if (openIdx === -1) break;
      
      const closeIdx = content.indexOf(closeTag, openIdx);
      if (closeIdx === -1) break;
      
      const blockEnd = closeIdx + closeTag.length;
      const inner = content.substring(openIdx + openTag.length, closeIdx);
      
      // Parse parameters from inner content
      const args: Record<string, unknown> = {};
      const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
      let match: RegExpExecArray | null;
      while ((match = paramRegex.exec(inner)) !== null) {
        if (match[1] && match[2]) {
          args[match[1]] = match[2].trim();
        }
      }
      
      calls.push({ id: randomUUID(), name, args });
      searchPos = blockEnd;
    }
  }
  
  return calls;
}

/**
 * Strip <think>...</think> blocks emitted by reasoning models (Qwen3, DeepSeek-R1, etc.)
 * before processing content or returning it to the user.
 */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * True when a tool result indicates the tool did not fully succeed — either an
 * explicit error string, a `deferred_to_frontend` marker, or an object with an
 * `error` field. Used by the truthfulness guard to decide whether to annotate
 * the model's final text so it doesn't silently claim success.
 */
export function isProblematicToolResult(result: unknown): boolean {
  if (result == null) return false;
  if (typeof result === 'string') return /^error\b/i.test(result.trim());
  if (typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (obj.status === 'deferred_to_frontend') return true;
    if (typeof obj.error === 'string' && obj.error.length > 0) return true;
  }
  return false;
}

const TRUTHFULNESS_NOTE =
  '[System note: One or more tools in this turn did not fully complete — some results were deferred for user approval or returned errors. Reconcile your final response with the tool activity feed instead of claiming unconditional success.]\n\n';

export function prependTruthfulnessNote(finalText: string, hadProblems: boolean): string {
  if (!hadProblems) return finalText;
  return TRUTHFULNESS_NOTE + finalText;
}

function summarizeRequest(messages: Array<{ role: string; content: string; name?: string }>): { msgs: number; kb: number } {
  let bytes = 0;
  for (const m of messages) bytes += (m.content?.length ?? 0) + (m.role?.length ?? 0);
  return { msgs: messages.length, kb: Math.round(bytes / 1024) };
}

// When a request payload grows large, emit a per-message size breakdown so we
// can see *which* message is the bomb. Cheap — only runs past the threshold.
function logLargestMessages(
  providerName: string,
  messages: Array<{ role: string; content: string; name?: string }>,
  totalKb: number
): void {
  if (totalKb < 1024) return; // only log for >1 MB payloads
  const ranked = messages
    .map((m, i) => ({ i, role: m.role, name: m.name, size: m.content?.length ?? 0, head: (m.content ?? '').slice(0, 120).replace(/\s+/g, ' ') }))
    .sort((a, b) => b.size - a.size)
    .slice(0, 3);
  for (const r of ranked) {
    logger.warn(`[${providerName}] oversized-payload msg[${r.i}] role=${r.role} name=${r.name ?? '-'} size=${Math.round(r.size / 1024)}KB head="${r.head}"`);
  }
}

function filterToolsByTier(
  tools: unknown[],
  tier?: 'full-agentic' | 'code-only',
  _traits?: { toolUse: string; multimodal: boolean; contextWindow: number }
): unknown[] {
  // Preview-runtime tools (get_console_logs, get_selected_element) require the
  // frontend to supply previewState in the request. The code-only tier doesn't
  // flow through that path, so hide them there to avoid empty-context calls.
  if (tier !== 'full-agentic') {
    const excludeNames = new Set(['get_console_logs', 'get_selected_element']);
    return (tools as Array<{ function: { name: string } }>).filter(
      t => !excludeNames.has(t.function.name)
    );
  }
  return tools;
}

// Per-tool-result size cap applied before pushing into chat history. Without
// this, a single oversized tool result (e.g. a base64 screenshot, a huge
// grep dump, a large stderr buffer) can bloat subsequent API requests past
// the provider's limit, causing HTTP 400s.
const MAX_TOOL_RESULT_HISTORY_BYTES = 96 * 1024; // 96 KB

function capToolResultForHistory(name: string, serialized: string): string {
  if (serialized.length <= MAX_TOOL_RESULT_HISTORY_BYTES) return serialized;
  const head = serialized.slice(0, MAX_TOOL_RESULT_HISTORY_BYTES);
  const dropped = serialized.length - MAX_TOOL_RESULT_HISTORY_BYTES;
  return JSON.stringify({
    status: 'truncated_for_history',
    tool: name,
    preview: head,
    note: `Result was ${serialized.length} bytes; truncated to ${MAX_TOOL_RESULT_HISTORY_BYTES} to fit the context window. ${dropped} bytes dropped. Re-query with narrower args if needed.`,
  });
}

type HistoryMessage = {
  role: string;
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: unknown;
};

const NEVER_COMPACT_TOOLS = new Set([
  'write_file', 'edit_file', 'create_file', 'move_file', 'git_commit',
]);

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'create_file', 'replace_in_files', 'apply_patch']);

function summarizeToolResult(toolName: string, content: string): string {
  try {
    switch (toolName) {
      case 'read_file':
        return JSON.stringify({ status: 'compacted', summary: 'File content read (compacted)' });
      case 'list_files':
        return JSON.stringify({ status: 'compacted', summary: 'Directory listing (compacted)' });
      case 'grep_files':
        return JSON.stringify({ status: 'compacted', summary: 'Search results (compacted)' });
      case 'get_file_outline':
        return JSON.stringify({ status: 'compacted', summary: 'File outline (compacted)' });
      case 'git_diff':
      case 'git_status':
        return JSON.stringify({ status: 'compacted', summary: 'Git output (compacted)' });
      case 'run_shell':
      case 'run_tests': {
        const parsed = JSON.parse(content) as { stdout?: string; exitCode?: number };
        const preview = (parsed.stdout ?? '').slice(0, 80).replace(/\n/g, ' ');
        return JSON.stringify({ status: 'compacted', summary: `stdout: ${preview}`, exitCode: parsed.exitCode });
      }
      default:
        return JSON.stringify({ status: 'compacted' });
    }
  } catch {
    return JSON.stringify({ status: 'compacted' });
  }
}

export function compactHistory(
  messages: HistoryMessage[],
  keepLastNIterations: number,
  thresholdBytes: number
): HistoryMessage[] {
  // Count tool-call iterations to decide if compaction is worthwhile.
  // We compact whenever there are OLD iterations beyond keepLastNIterations,
  // but only if the total payload is above a minimum floor (thresholdBytes / 32)
  // to avoid touching tiny histories.
  const totalBytes = Buffer.byteLength(JSON.stringify(messages), 'utf-8');
  const floor = Math.max(1024, thresholdBytes >> 5); // thresholdBytes / 32
  if (totalBytes < floor) return messages;

  // Find where to start keeping messages verbatim (last N assistant+tool_calls iterations)
  let iterationsFound = 0;
  let cutoffIdx = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && msg.role === 'assistant' && msg.tool_calls) {
      iterationsFound++;
      if (iterationsFound >= keepLastNIterations) {
        cutoffIdx = i;
        break;
      }
    }
  }

  // If there's nothing old to compact, return unchanged
  if (cutoffIdx === 0 && iterationsFound < keepLastNIterations) return messages;

  return messages.map((msg, idx) => {
    if (idx >= cutoffIdx) return msg;
    if (msg.role !== 'tool') return msg;
    if (msg.name && NEVER_COMPACT_TOOLS.has(msg.name)) return msg;
    return { ...msg, content: summarizeToolResult(msg.name ?? '', msg.content) };
  });
}

function detectProjectRootFromFiles(changedFiles: string[]): string {
  // Per-request scope (set by the controller from the chat request) wins over
  // the filename-prefix heuristic, which was only a fallback for untagged paths.
  const effective = getEffectiveProjectRoot();
  if (effective !== PROJECT_ROOT) return effective;
  if (changedFiles.length === 0) return PROJECT_ROOT;
  const first = changedFiles[0] ?? '';
  const m = first.match(/^(projects\/[^/]+)\//);
  return m && m[1] ? nodePath.join(PROJECT_ROOT, m[1]) : PROJECT_ROOT;
}

async function getTscErrors(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    let out = '';
    const proc = nodeSpawn('npx', ['tsc', '--noEmit', '--pretty', 'false'], { cwd, shell: process.platform === 'win32' });
    const timer = setTimeout(() => { proc.kill(); resolve([]); }, 15_000);
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    proc.on('close', () => { clearTimeout(timer); resolve(out.split('\n').filter(Boolean)); });
    proc.on('error', () => { clearTimeout(timer); resolve([]); });
  });
}

async function autoVerify(
  changedFiles: string[],
  errorBaseline: Set<string>
): Promise<string | null> {
  const projectRoot = detectProjectRootFromFiles(changedFiles);

  // Skip silently if the project has no tsconfig.json (e.g. Python, Go projects)
  try {
    const { access } = await import('fs/promises');
    await access(nodePath.join(projectRoot, 'tsconfig.json'));
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    const proc = nodeSpawn(
      'npx',
      ['tsc', '--noEmit', '--pretty', 'false'],
      { cwd: projectRoot, shell: process.platform === 'win32' }
    );

    let output = '';
    proc.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { output += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) { resolve(null); return; }

      const errorLines = output
        .split('\n')
        .filter((l) => /\.tsx?\(/.test(l) || /\.tsx?:/.test(l));

      // Filter out files that were already erroring before this session
      const newErrors = errorLines.filter((line) => {
        const fileMatch = line.match(/^([^(:]+)/);
        return fileMatch && fileMatch[1] ? !errorBaseline.has(fileMatch[1].trim()) : true;
      });

      // Focus on files we actually changed (full-path match to avoid false positives)
      const relevant =
        changedFiles.length > 0
          ? newErrors.filter((line) =>
              changedFiles.some((f) => {
                const abs = nodePath.isAbsolute(f) ? f : nodePath.join(getEffectiveProjectRoot(), f);
                return line.includes(abs) || line.includes(f);
              })
            )
          : newErrors;

      clearTimeout(timer);
      resolve(relevant.slice(0, 10).join('\n') || null);
    });

    proc.on('error', () => { clearTimeout(timer); resolve(null); }); // tsc unavailable — skip silently
    let timer = setTimeout(() => { proc.kill(); resolve(null); }, 30_000);
  });
}

type RawToolCall = { id: string; function: { name: string; arguments: string } };

interface ParsedToolCall {
  toolCall: RawToolCall;
  name: string;
  callId: string;
  args: Record<string, unknown>;
  parseError: string | null;
}

/**
 * Parse a model's `tool_calls` array. On JSON parse failure the `parseError`
 * is captured and the raw `arguments` field is reset to "{}" so the assistant
 * message stays valid for follow-up provider requests (DashScope/Groq reject
 * tool_calls with non-JSON arguments in history).
 */
export function parseToolCalls(toolCalls: RawToolCall[]): ParsedToolCall[] {
  return toolCalls.map((toolCall) => {
    let args: Record<string, unknown> = {};
    let parseError: string | null = null;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch (e) {
      parseError = (e as Error).message;
      toolCall.function.arguments = '{}';
    }
    return {
      toolCall,
      name: toolCall.function.name,
      callId: toolCall.id,
      args,
      parseError,
    };
  });
}

/**
 * Recovery hints appended to tool-error messages so the model knows how to
 * react instead of looping on the same call. Shared between streaming and
 * non-streaming tool loops.
 */
export function buildRecoveryHint(name: string, errorMessage: string, consecutiveFailures: number, maxConsecutiveFailures: number): string {
  if (name === 'read_file' && errorMessage.includes('ENOENT')) {
    return `${errorMessage}\n\nRECOVERY: The file path does not exist. Use list_files to discover available files before retrying.`;
  }
  if (name === 'list_files' && errorMessage.includes('ENOENT')) {
    return `${errorMessage}\n\nRECOVERY: The directory does not exist. Try listing the parent directory or use list_files with "." to see the project root.`;
  }
  if (name === 'run_shell' && consecutiveFailures >= maxConsecutiveFailures) {
    return `${errorMessage}\n\nRECOVERY: Multiple shell attempts failed. Try a different approach or ask the user for help.`;
  }
  return errorMessage;
}

/**
 * Normalize an error message to a stable signature for detecting retry loops.
 * Strips volatile bits (absolute paths, timestamps, PIDs, transaction ids) so
 * two ENOTEMPTY-on-different-temp-dirs failures still match as "same error".
 */
export function errorSignature(toolName: string, errorMessage: string): string {
  const trimmed = (errorMessage || '')
    .replace(/\b\d{13,}\b/g, 'TS')                        // epoch ms
    .replace(/\b(TX:\s*)[a-z0-9]+/gi, '$1TX')             // transaction ids
    .replace(/[A-Z]:\\[^\s'"]+/g, 'PATH')                 // windows absolute paths
    .replace(/\/[^\s'"]*\/[^\s'"]+/g, 'PATH')             // unix absolute paths
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return `${toolName}|${trimmed}`;
}

/**
 * Abstract base class for OpenAI-compatible providers (Groq, DeepSeek, OpenRouter, etc.)
 * Provides standardized message mapping and recursive tool-calling logic.
 */
export abstract class BaseOpenAIService implements AIProvider {
  abstract readonly name: string;
  protected abstract baseUrl: string;
  protected abstract apiKey: string;
  public defaultModel: string = '';

  isReady(): boolean {
    // Always report ready — runtime API keys from the frontend can satisfy the requirement
    return true;
  }

  complete = this.generateChatCompletion;

  protected getToolDefinitions() {
    return getOpenAITools();
  }

  async generateChatCompletion(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    const apiKey = options.apiKey || this.apiKey;
    if (!apiKey) throw new Error(`${this.name} API Key missing`);

    const currentMessages: Array<{ role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: unknown }> = normalizeMessages(messages).map(m => ({ role: m.role, content: m.content }));
    const model = options.model || this.defaultModel;
    let iteration = 0;
    const maxIterations = 8;

    try {
      let hadProblems = false;
      // Auto-verify state for non-streaming path (mirrors streaming path)
      let errorBaselinePromise: Promise<Set<string>> | null = null;
      const getErrorBaselineNonStream = (): Promise<Set<string>> => {
        if (errorBaselinePromise === null) {
          errorBaselinePromise = getTscErrors(getEffectiveProjectRoot()).then(errs => new Set(errs));
        }
        return errorBaselinePromise;
      };
      let verifyAttempts = 0;

      while (iteration < maxIterations) {
        // Inject agent scratchpad (plan + reflections) into the last system message
        const scratchpadBlock = agentScratchpadService.renderForPrompt('default');
        if (scratchpadBlock) {
          const lastSystemIdx = [...currentMessages].reverse().findIndex(m => m.role === 'system');
          if (lastSystemIdx !== -1) {
            const realIdx = currentMessages.length - 1 - lastSystemIdx;
            const existing = currentMessages[realIdx]!;
            if (!existing.content.includes('[CURRENT PLAN]')) {
              existing.content += `\n\n[CURRENT PLAN]\n${scratchpadBlock}\n\n[INSTRUCTIONS] The plan above is your live task scratchpad. Use update_plan to mark steps as you work. Use reflect after 3+ tool actions to summarize progress.`;
            }
          }
        }

        const messagesForRequest = compactHistory(currentMessages, 4, 32_768);
        if (messagesForRequest !== currentMessages) {
          logger.info(`[${this.name}] History compacted at iter=${iteration}`);
        }

        const payload: Record<string, unknown> = {
          model,
          messages: messagesForRequest,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 8192,
        };

        // CRITICAL FIX: Most providers (Groq, OpenAI) do not allow
        // response_format: "json_object" and tools to be used simultaneously.
        if (options.jsonMode && !this.shouldSkipJsonMode(model)) {
          payload.response_format = { type: "json_object" };
        } else if (options.shouldSearch !== false) {
          payload.tools = this.getToolDefinitions();
          payload.tool_choice = "auto";
        }

        const reqSummary = summarizeRequest(currentMessages);
        const reqStart = Date.now();
        logger.info(`[${this.name}] iter=${iteration}/${maxIterations} msgs=${reqSummary.msgs} payload=${reqSummary.kb}KB model=${model}`);

        const response = await axios.post(
          `${this.baseUrl}/chat/completions`,
          payload,
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              ...(this.getExtraHeaders?.() || {})
            },
            timeout: config.AI_PROVIDER_TIMEOUT_MS ?? 120_000,
            signal: options.signal
          }
        );

        logger.info(`[${this.name}] iter=${iteration} responded in ${Date.now() - reqStart}ms`);

        const message = response.data.choices[0].message;
        const rawContent = message.content || "";
        const content = stripThinkTags(typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent));

        if (!message.tool_calls) {
          return prependTruthfulnessNote(content, hadProblems);
        }

        // Handle Tool Calls
        logger.info(`[${this.name}] Tool calls detected: ${message.tool_calls.length}`);

        const parsed = parseToolCalls(message.tool_calls);

        currentMessages.push({ ...message, content });

        for (const { toolCall, name, args, parseError } of parsed) {
          if (parseError) {
            hadProblems = true;
            const msg = `Tool arguments could not be parsed as JSON (${parseError}). Likely truncated by max_tokens; retry with smaller content or use ide_show_diff for file edits.`;
            logger.error(`[${this.name}] Tool args parse error (${name}): ${parseError}`);
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              name,
              content: JSON.stringify({ error: msg })
            });
            continue;
          }

          try {
            const result = await toolService.executeTool(name, args);
            if (isProblematicToolResult(result)) hadProblems = true;
            currentMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: name,
              content: capToolResultForHistory(name, JSON.stringify(result))
            });
          } catch (toolError: unknown) {
            const toolErr = toolError as Error;
            hadProblems = true;
            logger.error(`[${this.name}] Tool execution failed (${name}): ${toolErr.message}`);
            currentMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              name: name,
              content: JSON.stringify({ error: toolErr.message })
            });
          }
        }

        // Auto-verify after write operations (non-streaming path)
        const changedFiles = parsed
          .filter((c) => WRITE_TOOLS.has(c.name) && !c.parseError)
          .map((c) => (c.args.path as string) ?? '')
          .filter(Boolean);

        if (changedFiles.length > 0 && verifyAttempts < 2) {
          verifyAttempts++;
          const baseline = await getErrorBaselineNonStream();
          const verifyErrors = await autoVerify(changedFiles, baseline);
          if (verifyErrors) {
            hadProblems = true;
            const checkMsg =
              `[VERIFY] After writing ${changedFiles.join(', ')}, TypeScript errors were detected:\n\n` +
              `${verifyErrors}\n\n` +
              `[SYSTEM: You MUST fix these errors before concluding the task.]`;
            logger.warn(`[${this.name}] Non-stream auto-verify found errors at iter=${iteration}`);
            currentMessages.push({ role: 'user', content: checkMsg });
          } else {
            verifyAttempts = 0;
          }
        }

        iteration++;
      }

      throw new Error(`${this.name} agent exceeded maximum tool-calling iterations.`);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: { message?: string } } }; message?: string };
      const errorMsg = err.response?.data?.error?.message || err.message;
      const ctx = summarizeRequest(currentMessages);
      logger.error(`[${this.name}] Request Failed at iter=${iteration}/${maxIterations} msgs=${ctx.msgs} payload=${ctx.kb}KB: ${errorMsg}`);
      logLargestMessages(this.name, currentMessages, ctx.kb);
      throw new Error(`${this.name} API failed at iter=${iteration} (${ctx.kb}KB, ${ctx.msgs} msgs): ${errorMsg}`);
    }
  }

  /**
   * Event-emitting variant of generateChatCompletion.
   * Same recursive tool loop, but emits AgentEvents for each tool call
   * so the frontend can show real-time tool activity.
   */
  async generateChatCompletionWithEvents(
    messages: ChatMessage[],
    options: CompletionOptions,
    onEvent: (event: AgentEvent) => void,
    tier?: 'full-agentic' | 'code-only',
    traits?: { toolUse: 'strong' | 'basic'; multimodal: boolean; contextWindow: number }
  ): Promise<string> {
    const apiKey = options.apiKey || this.apiKey;
    if (!apiKey) throw new Error(`${this.name} API Key missing`);

    const currentMessages: Array<{ role: string; content: string; name?: string; tool_call_id?: string; tool_calls?: unknown }> = normalizeMessages(messages).map(m => ({ role: m.role, content: m.content }));
    const model = options.model || this.defaultModel;

    let iteration = 0;
    const maxIterations = tier === 'full-agentic' ? 20 : 6;

    try {
      let consecutiveFailures = 0;
      const maxConsecutiveFailures = 3;
      // Retry-loop guard: if the same tool fails with the same normalized error
      // N times in a row, break the iteration loop instead of burning budget
      // and rate-limit headroom on a deterministic failure.
      let lastFailureSignature: string | null = null;
      let sameErrorRepeats = 0;
      const maxSameErrorRepeats = 3;
      let hadProblems = false;
      // Baseline of pre-existing tsc errors, captured lazily on the first
      // write-tool call. Chat-only turns never pay the ~15s tsc spawn cost.
      let errorBaselinePromise: Promise<Set<string>> | null = null;
      const getErrorBaseline = (): Promise<Set<string>> => {
        if (errorBaselinePromise === null) {
          errorBaselinePromise = getTscErrors(getEffectiveProjectRoot()).then(errs => new Set(errs));
        }
        return errorBaselinePromise;
      };
      let verifyAttempts = 0;

      while (iteration < maxIterations) {
        // Inject agent scratchpad (plan + reflections) into the last system message
        const scratchpadBlock = agentScratchpadService.renderForPrompt('default');
        if (scratchpadBlock) {
          // Find the last system message and append the scratchpad
          const lastSystemIdx = [...currentMessages].reverse().findIndex(m => m.role === 'system');
          if (lastSystemIdx !== -1) {
            const realIdx = currentMessages.length - 1 - lastSystemIdx;
            const existing = currentMessages[realIdx]!;
            // Avoid duplicating the scratchpad block on repeated iterations
            if (!existing.content.includes('[CURRENT PLAN]')) {
              existing.content += `\n\n[CURRENT PLAN]\n${scratchpadBlock}\n\n[INSTRUCTIONS] The plan above is your live task scratchpad. Use update_plan to mark steps as you work. Use reflect after 3+ tool actions to summarize progress.`;
            }
          }
        }

        // Compact old tool results if payload is too large
        const messagesForRequest = compactHistory(currentMessages, 4, 32_768);
        if (messagesForRequest !== currentMessages) {
          logger.info(`[${this.name}] History compacted at iter=${iteration}`);
        }

        const payload: Record<string, unknown> = {
          model,
          messages: messagesForRequest,
          temperature: options.temperature ?? 0.7,
          max_tokens: options.maxTokens ?? 8192,
        };

        if (options.jsonMode && !this.shouldSkipJsonMode(model)) {
          payload.response_format = { type: "json_object" };
        } else if (options.shouldSearch !== false) {
          const allTools = this.getToolDefinitions();
          const filteredTools = filterToolsByTier(allTools, tier, traits);
          payload.tools = filteredTools;
          payload.tool_choice = "auto";
        }

        const reqSummary = summarizeRequest(currentMessages);
        const reqStart = Date.now();
        logger.info(`[${this.name}] iter=${iteration}/${maxIterations} msgs=${reqSummary.msgs} payload=${reqSummary.kb}KB model=${model} tier=${tier ?? 'default'}`);

        const response = await axios.post(
          `${this.baseUrl}/chat/completions`,
          { ...payload, stream: true },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              ...(this.getExtraHeaders?.() || {}),
            },
            responseType: 'stream',
            timeout: config.AI_PROVIDER_TIMEOUT_MS ?? 120_000,
            signal: options.signal,
          }
        );

        logger.info(`[${this.name}] iter=${iteration} stream started in ${Date.now() - reqStart}ms`);

        let rawContent = '';
        const toolCallsAcc = new Map<number, { id: string; name: string; arguments: string }>();

        await new Promise<void>((streamResolve, streamReject) => {
          let buf = '';
          let streamDone = false;
          const stream = response.data as import('stream').Readable;

          const done = () => {
            if (streamDone) return;
            streamDone = true;
            stream.destroy();
            streamResolve();
          };

          stream.on('data', (chunk: Buffer) => {
            if (streamDone) return;
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const data = line.slice(6).trim();
              if (data === '[DONE]') { done(); return; }
              try {
                const parsed = JSON.parse(data) as {
                  error?: { message?: string };
                  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
                  choices?: Array<{
                    delta?: {
                      content?: string;
                      tool_calls?: Array<{
                        index: number;
                        id?: string;
                        function?: { name?: string; arguments?: string };
                      }>;
                    };
                    finish_reason?: string;
                  }>;
                };

                // Surface provider-side errors (e.g. rate limit, auth failure)
                if (parsed.error) {
                  streamDone = true;
                  stream.destroy();
                  streamReject(new Error(parsed.error.message ?? 'Provider stream error'));
                  return;
                }

                const delta = parsed.choices?.[0]?.delta;
                if (!delta) {
                  // Some providers emit usage in a final chunk with no choices
                  const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
                  if (usage?.prompt_tokens !== undefined) {
                    onEvent({
                      type: 'usage',
                      promptTokens: usage.prompt_tokens,
                      completionTokens: usage.completion_tokens ?? 0,
                      cachedTokens: usage.prompt_tokens_details?.cached_tokens,
                    });
                  }
                  continue;
                }

                if (delta.content) {
                  rawContent += delta.content;
                  onEvent({ type: 'text_delta', content: delta.content });
                }

                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    if (!toolCallsAcc.has(tc.index)) {
                      toolCallsAcc.set(tc.index, { id: '', name: '', arguments: '' });
                    }
                    const acc = toolCallsAcc.get(tc.index)!;
                    if (tc.id) acc.id = tc.id;
                    // name arrives once in the first chunk; use assignment not +=
                    if (tc.function?.name) acc.name = acc.name || tc.function.name;
                    if (tc.function?.arguments) acc.arguments += tc.function.arguments;
                  }
                }

                const finish = parsed.choices?.[0]?.finish_reason;
                if (finish === 'stop' || finish === 'tool_calls') done();
              } catch { /* partial JSON chunk */ }
            }
          });

          stream.on('end', done);
          stream.on('error', streamReject);
        });

        const content = stripThinkTags(rawContent);

        // Reconstruct the message shape the rest of the loop expects
        const message = {
          role: 'assistant' as const,
          content: rawContent,
          tool_calls:
            toolCallsAcc.size > 0
              ? Array.from(toolCallsAcc.values()).map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.name, arguments: tc.arguments },
                }))
              : undefined,
        };

        if (!message.tool_calls) {
          // Fallback: check if the model emitted tool calls as XML in content
          const validNames = (this.getToolDefinitions() as Array<{ function: { name: string } }>)
            .map(t => t.function.name);
          const xmlCalls = parseXmlToolCalls(typeof content === 'string' ? content : JSON.stringify(content), validNames);

          if (xmlCalls.length > 0) {
            logger.info('[' + this.name + '] XML tool calls detected: ' + xmlCalls.map(c => c.name).join(', '));
            
            const cleanContent = '';
            currentMessages.push({
              role: 'assistant',
              content: cleanContent,
              tool_calls: xmlCalls.map(c => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) }
              }))
            });

            for (const call of xmlCalls) {
              // Capture file content BEFORE write tools execute (for undo support)
              let xmlBeforeContent: string | undefined;
              if (WRITE_TOOLS.has(call.name) && typeof call.args.path === 'string') {
                try {
                  const { validatePath } = await import('../utils/fileSystem');
                  const { readFile } = await import('fs/promises');
                  const fullPath = validatePath(call.args.path);
                  xmlBeforeContent = await readFile(fullPath, 'utf-8');
                } catch { /* new file */ }
              }

              onEvent({ type: 'tool_start', tool: call.name, args: call.args, iteration, callId: call.id, beforeContent: xmlBeforeContent });
              try {
                const result = await toolService.executeTool(call.name, call.args);
                if (isProblematicToolResult(result)) hadProblems = true;
                onEvent({ type: 'tool_result', tool: call.name, args: call.args, result, iteration, callId: call.id });
                currentMessages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  name: call.name,
                  content: capToolResultForHistory(call.name, JSON.stringify(result))
                });
                consecutiveFailures = 0;
                lastFailureSignature = null;
                sameErrorRepeats = 0;
              } catch (toolError: unknown) {
                const toolErr = toolError as Error;
                consecutiveFailures++;
                hadProblems = true;
                logger.error('[' + this.name + '] XML tool failed (' + call.name + '): ' + toolErr.message);
                onEvent({ type: 'tool_error', tool: call.name, error: toolErr.message, iteration, callId: call.id });

                const sig = errorSignature(call.name, toolErr.message);
                if (sig === lastFailureSignature) {
                  sameErrorRepeats++;
                } else {
                  sameErrorRepeats = 1;
                  lastFailureSignature = sig;
                }

                const errorContent = buildRecoveryHint(call.name, toolErr.message, consecutiveFailures, maxConsecutiveFailures);
                currentMessages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  name: call.name,
                  content: JSON.stringify({ error: errorContent })
                });

                if (sameErrorRepeats >= maxSameErrorRepeats) {
                  const abortMsg = `Stopped: tool \`${call.name}\` failed ${sameErrorRepeats} times in a row with the same error:\n\n${toolErr.message}\n\nTypical causes: stale dependencies (delete node_modules and reinstall), a file or port lock held by another process, or a deterministic bug. Please investigate before retrying.`;
                  logger.warn(`[${this.name}] Aborting (XML path): ${sig} repeated ${sameErrorRepeats}x at iter=${iteration}`);
                  onEvent({ type: 'text_complete', content: abortMsg });
                  return abortMsg;
                }
              }
            }

            if (consecutiveFailures === 0) {
              iteration++;
            } else if (consecutiveFailures >= maxConsecutiveFailures) {
              iteration++;
            }
            continue;
          }

          // Check for delegation tags in the model's text output
          const textContent = typeof content === 'string' ? content : JSON.stringify(content);
          const delegationTasks = parseDelegationTags(textContent);
          if (delegationTasks.length > 0) {
            logger.info(`[${this.name}] Delegation detected: ${delegationTasks.length} task(s)`);
            for (const dtask of delegationTasks) {
              const delegateCallId = randomUUID().slice(0, 8);
              onEvent({ type: 'tool_start', tool: '__delegated__', args: { task: dtask.task, files: dtask.files }, iteration, callId: delegateCallId });
              try {
                const delegateResult = await delegationService.runDelegatedTask(dtask);
                onEvent({ type: 'tool_result', tool: '__delegated__', args: {}, result: delegateResult, iteration, callId: delegateCallId });
                // Inject result into conversation for parent model to consume
                currentMessages.push({
                  role: 'assistant',
                  content: `[Delegated task completed]\nTask: ${dtask.task}\nResult: ${delegateResult.summary}`,
                });
              } catch (dErr) {
                const dMsg = dErr instanceof Error ? dErr.message : String(dErr);
                onEvent({ type: 'tool_error', tool: '__delegated__', error: dMsg, iteration, callId: delegateCallId });
              }
            }
            // Continue the loop so the parent model can see delegation results
            iteration++;
            continue;
          }

          // Truly done
          const finalText = typeof content === 'string' ? content : JSON.stringify(content);
          const annotated = prependTruthfulnessNote(finalText, hadProblems);
          onEvent({ type: 'text_complete', content: annotated });
          return annotated;
        }

        // Handle Tool Calls with events
        logger.info(`[${this.name}] Tool calls detected: ${message.tool_calls.length}`);

        // Parse arguments up front, and sanitize any malformed JSON in the
        // assistant message before pushing it to history — providers like
        // DashScope reject follow-up requests whose history contains a
        // tool_call with non-JSON `arguments`.
        const parsedCalls = parseToolCalls(message.tool_calls);

        currentMessages.push({ ...message, content });

        for (const { name, callId, args, parseError } of parsedCalls) {
          if (parseError) {
            hadProblems = true;
            consecutiveFailures++;
            const msg = `Tool arguments could not be parsed as JSON (${parseError}). This usually means the model's response was truncated because max_tokens was exceeded. Retry with smaller content — e.g. use ide_show_diff for file edits so the change is reviewed, or break the write into multiple smaller write_file calls.`;
            logger.error(`[${this.name}] Tool args parse error (${name}): ${parseError}`);
            onEvent({ type: 'tool_error', tool: name, error: msg, iteration, callId });
            currentMessages.push({
              role: 'tool',
              tool_call_id: callId,
              name,
              content: JSON.stringify({ error: msg })
            });

            const sig = errorSignature(name, parseError);
            if (sig === lastFailureSignature) {
              sameErrorRepeats++;
            } else {
              sameErrorRepeats = 1;
              lastFailureSignature = sig;
            }
            if (sameErrorRepeats >= maxSameErrorRepeats) {
              const abortMsg = `Stopped: tool \`${name}\` kept returning malformed arguments (${sameErrorRepeats} times in a row). The model's tool-call JSON is likely being truncated. Try a simpler request or break it into smaller steps.`;
              logger.warn(`[${this.name}] Aborting (parseError path): ${sig} repeated ${sameErrorRepeats}x at iter=${iteration}`);
              onEvent({ type: 'text_complete', content: abortMsg });
              return abortMsg;
            }
            continue;
          }

          // Capture file content BEFORE write tools execute (for undo support)
          let beforeContent: string | undefined;
          if (WRITE_TOOLS.has(name) && typeof args.path === 'string') {
            try {
              const { validatePath } = await import('../utils/fileSystem');
              const { readFile } = await import('fs/promises');
              const fullPath = validatePath(args.path);
              beforeContent = await readFile(fullPath, 'utf-8');
            } catch {
              // File doesn't exist yet (create_file) — no beforeContent
            }
          }

          onEvent({ type: 'tool_start', tool: name, args, iteration, callId, beforeContent });

          try {
            const result = await toolService.executeTool(name, args);
            if (isProblematicToolResult(result)) hadProblems = true;
            onEvent({ type: 'tool_result', tool: name, args, result, iteration, callId });
            currentMessages.push({
              role: "tool",
              tool_call_id: callId,
              name,
              content: capToolResultForHistory(name, JSON.stringify(result))
            });
            consecutiveFailures = 0; // Reset on success
            lastFailureSignature = null;
            sameErrorRepeats = 0;
          } catch (toolError: unknown) {
            const toolErr = toolError as Error;

            consecutiveFailures++;
            hadProblems = true;
            logger.error(`[${this.name}] Tool execution failed (${name}): ${toolErr.message}`);
            onEvent({ type: 'tool_error', tool: name, error: toolErr.message, iteration, callId });

            const sig = errorSignature(name, toolErr.message);
            if (sig === lastFailureSignature) {
              sameErrorRepeats++;
            } else {
              sameErrorRepeats = 1;
              lastFailureSignature = sig;
            }

            const errorContent = buildRecoveryHint(name, toolErr.message, consecutiveFailures, maxConsecutiveFailures);

            currentMessages.push({
              role: "tool",
              tool_call_id: callId,
              name,
              content: JSON.stringify({ error: errorContent })
            });

            if (sameErrorRepeats >= maxSameErrorRepeats) {
              const abortMsg = `Stopped: tool \`${name}\` failed ${sameErrorRepeats} times in a row with the same error:\n\n${toolErr.message}\n\nTypical causes: stale dependencies (delete node_modules and reinstall), a file or port lock held by another process, or a deterministic bug. Please investigate before retrying.`;
              logger.warn(`[${this.name}] Aborting (streaming path): ${sig} repeated ${sameErrorRepeats}x at iter=${iteration}`);
              onEvent({ type: 'text_complete', content: abortMsg });
              return abortMsg;
            }

            // Don't increment iteration on failure — give the model a chance to recover
            if (consecutiveFailures >= maxConsecutiveFailures) {
              // Force a final API call with recovery hint, then stop
              iteration++;
            }
          }
        }

        // Auto-verify after write operations (max 2 attempts per write batch)
        const changedFiles = parsedCalls
          .filter((c) => WRITE_TOOLS.has(c.name) && !c.parseError)
          .map((c) => (c.args.path as string) ?? '')
          .filter(Boolean);

        if (changedFiles.length > 0 && verifyAttempts < 2) {
          verifyAttempts++;
          const errorBaseline = await getErrorBaseline();
          const verifyErrors = await autoVerify(changedFiles, errorBaseline);
          const bcCallId = `build-${iteration}-${Date.now()}`;
          if (verifyErrors) {
            hadProblems = true;
            const checkMsg =
              `[build_check after writing ${changedFiles.join(', ')}]\n` +
              `TypeScript errors in changed files:\n\n${verifyErrors}\n\n` +
              `[SYSTEM: You MUST fix these errors before concluding the task.]`;
            logger.warn(`[${this.name}] Auto-verify found errors at iter=${iteration}`);
            currentMessages.push({ role: 'user', content: checkMsg });
            onEvent({
              type: 'tool_result',
              tool: '__build_check__',
              args: { files: changedFiles },
              result: { errors: verifyErrors },
              iteration,
              callId: bcCallId,
            });
          } else {
            verifyAttempts = 0; // reset so the next write also gets checked
            onEvent({
              type: 'tool_result',
              tool: '__build_check__',
              args: { files: changedFiles },
              result: { errors: null },
              iteration,
              callId: bcCallId,
            });
          }
        }

        // Only increment iteration on successful tool execution
        // (failed calls don't count toward the limit, giving the model room to recover)
        if (consecutiveFailures === 0) {
          iteration++;
        }
      }

      throw new Error(`${this.name} agent exceeded maximum tool-calling iterations.`);
    } catch (error: unknown) {
      const err = error as { response?: { data?: { error?: { message?: string } } }; message?: string };
      const errorMsg = err.response?.data?.error?.message || err.message;
      const ctx = summarizeRequest(currentMessages);
      logger.error(`[${this.name}] Request Failed at iter=${iteration}/${maxIterations} msgs=${ctx.msgs} payload=${ctx.kb}KB: ${errorMsg}`);
      logLargestMessages(this.name, currentMessages, ctx.kb);
      throw new Error(`${this.name} API failed at iter=${iteration} (${ctx.kb}KB, ${ctx.msgs} msgs): ${errorMsg}`);
    }
  }

  /**
   * Optional method for subclasses to provide extra headers (e.g. OpenRouter)
   */
  protected getExtraHeaders?(): Record<string, string>;

  /**
   * Override in subclasses to suppress jsonMode for specific model families.
   * Example: OpenRouter suppresses it for reasoning models that use <think> blocks.
   */
  protected shouldSkipJsonMode(_model: string): boolean {
    return false;
  }
}
