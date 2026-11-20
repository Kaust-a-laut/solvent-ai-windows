import { IProviderPlugin } from '../../types/plugins';
import { ChatMessage, CompletionOptions } from '../../types/ai';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { normalizeMessages, normalizeMessagesForOllama } from '../../utils/messageUtils';
import { Ollama } from 'ollama';

export class OllamaProviderPlugin implements IProviderPlugin {
  id = 'ollama';
  name = 'Ollama';
  description = 'Local Ollama AI provider';
  version = '1.0.0';
  defaultModel = 'qwen2.5-coder:7b';
  capabilities = {
    supportsVision: false,  // Depends on model
    supportsStreaming: true,
    supportsEmbeddings: false,
    contextWindow: 32768,  // Varies by model
    maxOutputTokens: 4096,
    supportsFunctionCalling: false,
    costPer1k: { input: 0, output: 0 } // Local provider, no cost
  };

  async healthCheck(): Promise<boolean> {
    try {
      if (!this.client) return false;

      // Check if Ollama is reachable
      const response = await this.client.ps();
      return !!response;
    } catch (error) {
      logger.error(`[Ollama] Health check failed:`, error);
      return false;
    }
  }

  async getHealth(): Promise<import('../../types/plugins').ProviderHealth> {
    const startTime = Date.now();
    const isHealthy = await this.healthCheck();
    const latency = Date.now() - startTime;

    // In a real implementation, we'd track error rates over time
    const errorRate = 0; // Placeholder

    return {
      isHealthy,
      lastChecked: Date.now(),
      latency,
      errorRate
    };
  }

  private client: Ollama | null = null;
  private isInitialized = false;
  private host: string = 'http://127.0.0.1:11434';
  private apiKey: string | null = null;

  async initialize(options: Record<string, unknown>): Promise<void> {
    this.host = (options.host as string) || config.OLLAMA_HOST || 'http://127.0.0.1:11434';
    this.apiKey = (options.apiKey as string) || config.OLLAMA_API_KEY || null;
    this.client = new Ollama({
      host: this.host,
      ...(this.apiKey ? { headers: { 'Authorization': `Bearer ${this.apiKey}` } } : {}),
    });
    this.isInitialized = true;
    logger.info(`[Ollama] Provider initialized (API key present: ${!!this.apiKey})`);
  }

  isReady(): boolean {
    return this.isInitialized && !!this.client;
  }

  hasConfiguredKey(): boolean {
    return this.isInitialized && !!this.client && config.ENABLE_OLLAMA;
  }

  async complete(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    const { model, temperature = 0.7, maxTokens = 2048, jsonMode, apiKey, signal } = options;
    if (signal?.aborted) throw new Error('Ollama request aborted');

    // Use a per-call client if abort/timeout might trigger so abort() doesn't cancel other concurrent calls
    const client = new Ollama({
      host: this.host,
      ...((apiKey || this.apiKey) ? { headers: { Authorization: `Bearer ${apiKey || this.apiKey}` } } : {}),
    });

    const timeoutMs = config.AI_PROVIDER_TIMEOUT_MS ?? 120_000;
    const onAbort = () => { try { client.abort(); } catch { /* ignore */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(onAbort, timeoutMs);

    try {
      const normalized = normalizeMessagesForOllama(normalizeMessages(messages));
      const response = await client.chat({
        model: model || this.defaultModel,
        messages: normalized,
        ...(jsonMode ? { format: 'json' } : {}),
        options: {
          temperature,
          num_predict: maxTokens,
        }
      });
      return response.message.content;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async *stream(messages: ChatMessage[], options: CompletionOptions): AsyncGenerator<string> {
    const { model, temperature = 0.7, maxTokens = 2048, jsonMode, apiKey, signal } = options;
    if (signal?.aborted) return;

    const client = new Ollama({
      host: this.host,
      ...((apiKey || this.apiKey) ? { headers: { Authorization: `Bearer ${apiKey || this.apiKey}` } } : {}),
    });

    const idleMs = config.AI_STREAM_IDLE_TIMEOUT_MS ?? 60_000;
    const onAbort = () => { try { client.abort(); } catch { /* ignore */ } };
    signal?.addEventListener('abort', onAbort, { once: true });
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(onAbort, idleMs);
    };
    resetIdle();

    try {
      const normalized = normalizeMessagesForOllama(normalizeMessages(messages));
      const response = await client.chat({
        model: model || this.defaultModel,
        messages: normalized,
        ...(jsonMode ? { format: 'json' } : {}),
        options: {
          temperature,
          num_predict: maxTokens,
        },
        stream: true
      });

      for await (const chunk of response) {
        resetIdle();
        if (signal?.aborted) break;
        if (chunk.message?.content) {
          yield chunk.message.content;
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  generateChatStream = (messages: ChatMessage[], options: CompletionOptions): AsyncGenerator<string> =>
    this.stream(messages, options);
}

// Export as default for dynamic loading
export default OllamaProviderPlugin;