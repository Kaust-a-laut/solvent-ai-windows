import { randomUUID } from 'crypto';
import { AIProviderFactory } from './aiProviderFactory';
import { TOOL_DEFINITIONS } from '../constants/tools';
import { logger } from '../utils/logger';
import { validatePath } from '../utils/fileSystem';
import { toolService } from './toolService';
import fs from 'fs/promises';
import path from 'path';

const SENSITIVE_FILE_RE = /(?:^|[\\/])(?:\.env(?:\.[^\\/]*)?|id_rsa(?:\.pub)?|id_ed25519(?:\.pub)?|settings\.json|.*\.(?:pem|key|p12|pfx))$/i;
const MAX_DELEGATE_TOOL_RESULT_BYTES = 32 * 1024;

export interface DelegatedTask {
  task: string;
  files: string[];
  context: string;
  parentSessionId: string;
}

export interface DelegationResult {
  summary: string;
  filesWritten: string[];
  error?: string;
}

const DELEGATE_ALLOWED_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'create_file',
  'get_file_outline', 'list_files', 'get_errors',
]);

/**
 * DelegationService spawns a cheap-model sub-agent for self-contained tasks
 * identified via <delegate-candidate> XML tags in the main agent's output.
 *
 * Runs a raw OpenAI-compatible tool loop (bypassing BaseOpenAIService) so we
 * can:
 *  1. Inject a restricted tool set directly in the payload (not discarded).
 *  2. Keep tool_call_id fields intact (normalizeMessages won't strip them).
 *  3. Execute tools ourselves via toolService.executeTool.
 *  4. Avoid recursion into the parent agent's tool loop.
 */
export class DelegationService {
  async runDelegatedTask(task: DelegatedTask): Promise<DelegationResult> {
    const callId = randomUUID().slice(0, 8);
    logger.info(`[Delegate ${callId}] Starting: "${task.task.slice(0, 80)}"`);

    try {
      // Find cheapest available provider that actually has a configured key
      const candidates = ['groq', 'fireworks', 'openrouter'];
      let provider: { id: string; apiKey?: string; isReady(): boolean; hasConfiguredKey?(): boolean } | null = null;
      let providerName = '';
      let model = '';
      for (const p of candidates) {
        try {
          const candidate = await AIProviderFactory.getExactProvider(p) as unknown as {
            id: string;
            apiKey?: string;
            isReady(): boolean;
            hasConfiguredKey?(): boolean;
          };
          const hasKey = typeof candidate.hasConfiguredKey === 'function'
            ? candidate.hasConfiguredKey()
            : Boolean(candidate.apiKey || process.env[`${p.toUpperCase()}_API_KEY`]);
          if (candidate.id === p && candidate.isReady() && hasKey) {
            provider = candidate;
            providerName = p;
            model = p === 'groq' ? 'llama-3.1-8b-instant'
                  : p === 'fireworks' ? 'accounts/fireworks/models/gpt-oss-120b'
                  : 'meta-llama/llama-3.1-8b-instruct';
            break;
          }
        } catch { /* next */ }
      }
      if (!provider) {
        return { summary: 'No available provider for delegation.', filesWritten: [], error: 'No provider' };
      }

      // Read file contexts safely inside effective project root (prevent path traversal & secret leaks)
      const fileContexts: string[] = [];
      for (const f of task.files) {
        try {
          if (SENSITIVE_FILE_RE.test(f)) {
            fileContexts.push(`--- ${f} ---\n[skipped sensitive file]\n`);
            continue;
          }
          const safePath = validatePath(f);
          if (SENSITIVE_FILE_RE.test(path.basename(safePath))) {
            fileContexts.push(`--- ${f} ---\n[skipped sensitive file]\n`);
            continue;
          }
          const content = await fs.readFile(safePath, 'utf-8');
          fileContexts.push(`--- ${f} ---\n${content.slice(0, 4000)}\n`);
        } catch {
          fileContexts.push(`--- ${f} ---\n[unreadable]\n`);
        }
      }

      const systemPrompt = `You are a focused code implementation assistant. Complete the given task by calling the available file tools. You have: read_file, write_file, edit_file, create_file, get_file_outline, list_files, get_errors. NO shell. Call tools directly — do not describe what you'll do, just do it.`;

      // Build restricted OpenAI tool payload
      const allowedTools = TOOL_DEFINITIONS
        .filter(t => DELEGATE_ALLOWED_TOOLS.has(t.name))
        .map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));

      // Message array for our raw tool loop
      const messages: Array<Record<string, unknown>> = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `TASK: ${task.task}\n\n${task.context ? 'CONTEXT:\n' + task.context + '\n\n' : ''}FILES:\n${fileContexts.join('\n')}` },
      ];

      const filesWritten: string[] = [];
      let finalAssistantText = '';
      const maxIterations = 8;

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        // Raw API call with our restricted tool set
        const response = await this.rawComplete(provider, providerName, model, messages, allowedTools);

        // Extract assistant message content and tool_calls
        const choice = response.choices?.[0]?.message;
        if (!choice) break;

        if (typeof choice.content === 'string' && choice.content.trim()) {
          finalAssistantText = choice.content.trim();
        }

        const assistantMsg: Record<string, unknown> = {
          role: 'assistant',
          content: choice.content ?? '',
        };

        const toolCalls = choice.tool_calls as Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }> | undefined;

        if (toolCalls && toolCalls.length > 0) {
          assistantMsg.tool_calls = toolCalls;
        }
        messages.push(assistantMsg);

        // No tool calls — model is done
        if (!toolCalls || toolCalls.length === 0) break;

        // Execute each tool call (strictly enforcing DELEGATE_ALLOWED_TOOLS)
        for (const tc of toolCalls) {
          const toolName = tc.function?.name ?? '';
          const tcId = tc.id || randomUUID().slice(0, 8);

          if (!DELEGATE_ALLOWED_TOOLS.has(toolName)) {
            logger.warn(`[Delegate ${callId}] Blocked disallowed tool: ${toolName}`);
            messages.push({
              role: 'tool',
              tool_call_id: tcId,
              name: toolName,
              content: JSON.stringify({ error: `Tool '${toolName}' is not permitted for delegated sub-agents.` }),
            });
            continue;
          }

          let toolArgs: Record<string, unknown>;
          try {
            const parsed = typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments)
              : tc.function?.arguments;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('Tool arguments must be a JSON object');
            }
            toolArgs = parsed as Record<string, unknown>;
          } catch (parseErr) {
            const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            messages.push({
              role: 'tool',
              tool_call_id: tcId,
              name: toolName,
              content: JSON.stringify({ error: `Invalid tool arguments JSON: ${parseMsg}` }),
            });
            continue;
          }

          try {
            const result = await toolService.executeTool(toolName, toolArgs);
            if ((toolName === 'write_file' || toolName === 'edit_file' || toolName === 'create_file') && typeof toolArgs.path === 'string') {
              filesWritten.push(toolArgs.path);
            }
            const serialized = typeof result === 'string' ? result : JSON.stringify(result);
            const capped = serialized.length > MAX_DELEGATE_TOOL_RESULT_BYTES
              ? serialized.slice(0, MAX_DELEGATE_TOOL_RESULT_BYTES) + '...[truncated]'
              : serialized;
            messages.push({
              role: 'tool',
              tool_call_id: tcId,
              name: toolName,
              content: capped,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`[Delegate ${callId}] Tool ${toolName} failed: ${msg}`);
            messages.push({
              role: 'tool',
              tool_call_id: tcId,
              name: toolName,
              content: JSON.stringify({ error: msg }),
            });
          }
        }
      }

      logger.info(`[Delegate ${callId}] Completed. Files written: ${filesWritten.length}`);

      const uniqueFiles = [...new Set(filesWritten)];
      const fileSummary = uniqueFiles.length > 0 ? `Files written: ${uniqueFiles.join(', ')}.` : '';
      const summary = finalAssistantText
        ? (fileSummary ? `${finalAssistantText}\n\n${fileSummary}` : finalAssistantText)
        : `Delegated task completed. Files written: ${uniqueFiles.join(', ') || 'none'}.`;

      return {
        summary,
        filesWritten: uniqueFiles,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Delegate ${callId}] Failed: ${msg}`);
      return { summary: `Delegation failed: ${msg}`, filesWritten: [], error: msg };
    }
  }

  /**
   * Raw OpenAI-compatible completion that returns the full response object
   * (including tool_calls) without any post-processing or recursive tool loops.
   *
   * Bypasses BaseOpenAIService.generateChatCompletion entirely so that:
   *  - our restricted tools[] payload is actually sent
   *  - normalizeMessages won't strip tool_call_id fields
   *  - no recursive tool execution happens
   */
  private async rawComplete(
    provider: any,
    providerName: string,
    model: string,
    messages: Array<Record<string, unknown>>,
    tools: Array<{ type: string; function: { name: string; description: string; parameters: any } }>
  ): Promise<{ choices?: Array<{ message?: { content?: string; tool_calls?: any[] } }> }> {
    const apiKey = provider.apiKey || process.env[`${providerName.toUpperCase()}_API_KEY`] || '';

    const body = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content, tool_calls: m.tool_calls, tool_call_id: m.tool_call_id, name: m.name })),
      temperature: 0.1,
      max_tokens: 8192,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' as const : undefined,
    };

    const endpoint = this.getEndpoint(providerName);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Delegation API ${providerName}/${model} failed (${response.status}): ${text.slice(0, 300)}`);
    }

    return response.json() as Promise<{ choices?: Array<{ message?: { content?: string; tool_calls?: any[] } }> }>;
  }

  private getEndpoint(providerName: string): string {
    switch (providerName) {
      case 'groq':
        return 'https://api.groq.com/openai/v1/chat/completions';
      case 'fireworks':
        return 'https://api.fireworks.ai/inference/v1/chat/completions';
      case 'openrouter':
        return 'https://openrouter.ai/api/v1/chat/completions';
      default:
        throw new Error(`Unknown provider for delegation: ${providerName}`);
    }
  }
}

/**
 * Parse <delegate-candidate> XML blocks from model output.
 */
export function parseDelegationTags(content: string): DelegatedTask[] {
  const tasks: DelegatedTask[] = [];
  const regex = /<delegate-candidate>([\s\S]*?)<\/delegate-candidate>/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const block = match[1] ?? '';
    const taskMatch = block.match(/<task>([\s\S]*?)<\/task>/);
    const filesMatch = block.match(/<files>([\s\S]*?)<\/files>/);
    const contextMatch = block.match(/<context>([\s\S]*?)<\/context>/);
    if (taskMatch?.[1]) {
      tasks.push({
        task: taskMatch[1].trim(),
        files: filesMatch?.[1]?.split(',').map(f => f.trim()).filter(Boolean) ?? [],
        context: contextMatch?.[1]?.trim() ?? '',
        parentSessionId: 'default',
      });
    }
  }
  return tasks;
}

export const delegationService = new DelegationService();
