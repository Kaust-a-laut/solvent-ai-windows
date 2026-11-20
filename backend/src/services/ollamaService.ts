import { Ollama } from 'ollama';
import { config } from '../config';
import { AIProvider, ChatMessage, CompletionOptions } from '../types/ai';
import { normalizeMessagesForOllama } from '../utils/messageUtils';
import { logger } from '../utils/logger';

const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);
// First embed call may cold-start the model (~90s); subsequent calls are ~4s
const OLLAMA_EMBED_COLD_TIMEOUT_MS = parseInt(process.env.OLLAMA_EMBED_COLD_TIMEOUT_MS || '120000', 10);
const OLLAMA_EMBED_WARM_TIMEOUT_MS = parseInt(process.env.OLLAMA_EMBED_WARM_TIMEOUT_MS || '30000', 10);
// Per-text budget for batch calls (CPU embedding with long code blocks — ~10-15s per text)
const OLLAMA_EMBED_PER_TEXT_MS = parseInt(process.env.OLLAMA_EMBED_PER_TEXT_MS || '15000', 10);

function createConfiguredClient(overrideApiKey?: string): Ollama {
  const apiKey = overrideApiKey || config.OLLAMA_API_KEY;
  return new Ollama({
    host: config.OLLAMA_HOST || 'http://127.0.0.1:11434',
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  });
}

function withAbortableTimeout<T>(
  client: Ollama,
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      try { client.abort(); } catch { /* ignore */ }
      reject(new Error(`${label} aborted`));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      try { client.abort(); } catch { /* ignore */ }
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      val => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(val); },
      err => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(err); }
    );
  });
}

export class OllamaService implements AIProvider {
  readonly name = 'ollama';

  private readonly EMBEDDING_MODEL = 'nomic-embed-text';
  private embedWarmedUp = false;

  async generateChatCompletion(messages: ChatMessage[], options: CompletionOptions): Promise<string> {
    const normalizedMessages = normalizeMessagesForOllama(messages);
    const client = createConfiguredClient(options.apiKey);

    const response = await withAbortableTimeout(client, client.chat({
      model: options.model,
      messages: normalizedMessages,
      stream: false,
      options: {
        temperature: options.temperature,
        num_predict: options.maxTokens
      }
    }), OLLAMA_TIMEOUT_MS, 'Ollama chat', options.signal);
    return response.message.content;
  }

  async listModels() {
    const client = createConfiguredClient();
    return await withAbortableTimeout(client, client.list(), 15_000, 'Ollama list');
  }

  async *generateChatStream(messages: ChatMessage[], options: CompletionOptions): AsyncGenerator<string> {
    const normalizedMessages = normalizeMessagesForOllama(messages);
    const client = createConfiguredClient(options.apiKey);
    const idleMs = config.AI_STREAM_IDLE_TIMEOUT_MS ?? 60_000;

    const onAbort = () => { try { client.abort(); } catch { /* ignore */ } };
    if (options.signal?.aborted) return;
    options.signal?.addEventListener('abort', onAbort, { once: true });

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(onAbort, idleMs);
    };
    resetIdle();

    try {
      const response = await withAbortableTimeout(client, client.chat({
        model: options.model,
        messages: normalizedMessages,
        stream: true,
        options: {
          temperature: options.temperature,
          num_predict: options.maxTokens
        }
      }), OLLAMA_TIMEOUT_MS, 'Ollama stream', options.signal);

      for await (const part of response) {
        resetIdle();
        if (options.signal?.aborted) break;
        yield part.message.content;
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Truncate text to stay within nomic-embed-text's ~8192 token context.
   * Rough heuristic: 1 token ≈ 4 chars, leave margin.
   */
  private truncateForEmbedding(text: string, maxChars = 30000): string {
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }

  async embed(text: string): Promise<number[]> {
    const timeout = this.embedWarmedUp ? OLLAMA_EMBED_WARM_TIMEOUT_MS : OLLAMA_EMBED_COLD_TIMEOUT_MS;
    const client = createConfiguredClient();

    const truncated = this.truncateForEmbedding(text);
    const response = await withAbortableTimeout(client, client.embed({
      model: this.EMBEDDING_MODEL,
      input: truncated
    }), timeout, 'Ollama embed');

    if (!response.embeddings || response.embeddings.length === 0) {
      logger.warn('[OllamaService] Embedding returned empty array');
      return new Array(768).fill(0);
    }

    if (!this.embedWarmedUp) {
      this.embedWarmedUp = true;
      logger.info('[OllamaService] Embed model loaded and warm');
    }
    return response.embeddings[0]!;
  }

  /**
   * Batch embed multiple texts via Ollama.
   * Splits into sub-batches of 5 to keep individual API calls manageable on CPU.
   */
  async batchEmbed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const allResults: number[][] = [];
    const subBatchSize = 5;

    for (let i = 0; i < texts.length; i += subBatchSize) {
      const chunk = texts.slice(i, i + subBatchSize);
      const truncated = chunk.map(t => this.truncateForEmbedding(t));
      const baseTimeout = this.embedWarmedUp ? OLLAMA_EMBED_WARM_TIMEOUT_MS : OLLAMA_EMBED_COLD_TIMEOUT_MS;
      const timeout = baseTimeout + (chunk.length * OLLAMA_EMBED_PER_TEXT_MS);
      const client = createConfiguredClient();

      const response = await withAbortableTimeout(client, client.embed({
        model: this.EMBEDDING_MODEL,
        input: truncated
      }), timeout, `Ollama batchEmbed(${chunk.length})`);

      if (!response.embeddings || response.embeddings.length === 0) {
        logger.warn('[OllamaService] Sub-batch embedding returned empty');
        allResults.push(...chunk.map(() => new Array(768).fill(0)));
      } else {
        if (!this.embedWarmedUp) {
          this.embedWarmedUp = true;
          logger.info('[OllamaService] Embed model loaded and warm');
        }
        allResults.push(...response.embeddings);
      }
    }

    return allResults;
  }
}
