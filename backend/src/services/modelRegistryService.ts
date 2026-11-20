import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AtomicFileSystem } from '../utils/fileSystem';

/**
 * Live model registry. Fetches each provider's /models list with the
 * configured keys on launch (and every REFRESH_INTERVAL_MS), and persists the
 * result so offline launches keep the last-known-good lists. Consumers ask
 * isLive(provider, model) — for providers we cannot list (no key, no list
 * endpoint, fetch failed with no cache) the answer is permissive `true`, so
 * the registry only ever *removes* models it has positively seen retired.
 */

interface ProviderEntry {
  ids: string[];
  fetchedAt: string;          // when this list was last fetched live
  source: 'live' | 'cached';
}

interface RegistrySnapshot {
  version: 1;
  providers: Record<string, ProviderEntry>;
}

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

type Fetcher = () => Promise<string[]>;

function bearerListFetcher(url: string, key: string | undefined): Fetcher | null {
  if (!key) return null;
  return async () => {
    const d = await fetchJson(url, { Authorization: `Bearer ${key}` }) as { data: Array<{ id: string }> };
    return d.data.map(m => m.id);
  };
}

export class ModelRegistryService {
  private registry: RegistrySnapshot = { version: 1, providers: {} };
  private registryPath = process.env.SOLVENT_MODEL_REGISTRY_PATH
    || path.resolve(__dirname, '../../../.solvent_model_registry.json');
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;

  private fetchers(): Record<string, Fetcher | null> {
    return {
      groq: bearerListFetcher('https://api.groq.com/openai/v1/models', config.GROQ_API_KEY),
      fireworks: bearerListFetcher('https://api.fireworks.ai/inference/v1/models', config.FIREWORKS_API_KEY),
      cerebras: bearerListFetcher('https://api.cerebras.ai/v1/models', config.CEREBRAS_API_KEY),
      deepseek: bearerListFetcher('https://api.deepseek.com/models', config.DEEPSEEK_API_KEY),
      dashscope: config.DASHSCOPE_API_KEY ? async () => {
        const headers = { Authorization: `Bearer ${config.DASHSCOPE_API_KEY}` };
        const d = await fetchJson('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', headers)
          .catch(() => fetchJson('https://dashscope.aliyuncs.com/compatible-mode/v1/models', headers)) as { data: Array<{ id: string }> };
        return d.data.map(m => m.id);
      } : null,
      openrouter: async () => {
        const d = await fetchJson('https://openrouter.ai/api/v1/models') as { data: Array<{ id: string }> };
        const ids: string[] = [];
        for (const m of d.data) {
          ids.push(m.id);
          // ':free' listings imply the base id routes too
          if (m.id.endsWith(':free')) ids.push(m.id.replace(/:free$/, ''));
        }
        return ids;
      },
      gemini: config.GEMINI_API_KEY ? async () => {
        // Send API key via header instead of URL query string so it never appears in proxy/error logs
        const d = await fetchJson('https://generativelanguage.googleapis.com/v1beta/models', {
          'x-goog-api-key': config.GEMINI_API_KEY!,
        }) as { models: Array<{ name: string }> };
        return d.models.map(m => m.name.replace(/^models\//, ''));
      } : null,
      // Stored under a distinct key on purpose: /api/tags only lists locally
      // pulled models, so it must not veto ':cloud' ids — isLive('ollama', …)
      // stays permissive.
      'ollama-local': async () => {
        const d = await fetchJson(`${config.OLLAMA_HOST}/api/tags`) as { models: Array<{ name: string }> };
        return d.models.map(m => m.name);
      },
    };
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.registryPath, 'utf-8');
      const parsed = JSON.parse(raw) as RegistrySnapshot;
      if (parsed?.version === 1 && parsed.providers) {
        // Disk entries start as 'cached' until this process refreshes them.
        for (const entry of Object.values(parsed.providers)) entry.source = 'cached';
        this.registry = parsed;
        logger.info(`[ModelRegistry] Loaded cached registry (${Object.keys(parsed.providers).length} providers).`);
      }
    } catch { /* first run — no cache yet */ }

    // Refresh in the background; never block startup on provider APIs.
    void this.refresh();

    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  /** Fetch all providers' live lists; keep last-known-good on failure. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const fetchers = this.fetchers();
      const results = await Promise.allSettled(
        Object.entries(fetchers).map(async ([provider, fetcher]) => {
          if (!fetcher) return; // unlistable (no key) — keep cache, stay permissive
          const ids = await fetcher();
          if (ids.length === 0) throw new Error('empty list');
          this.registry.providers[provider] = { ids, fetchedAt: new Date().toISOString(), source: 'live' };
        })
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      const live = Object.values(this.registry.providers).filter(p => p.source === 'live').length;
      logger.info(`[ModelRegistry] Refreshed: ${live} live lists${failed ? `, ${failed} fetch failures (kept cache)` : ''}.`);

      try {
        await AtomicFileSystem.writeJson(this.registryPath, this.registry);
      } catch (e) {
        logger.warn('[ModelRegistry] Failed to persist registry', e);
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /** Live ids for a provider, or null when the provider can't be listed. */
  getLive(provider: string): string[] | null {
    return this.registry.providers[provider]?.ids ?? null;
  }

  /**
   * False only when the provider's list is known AND the model is absent —
   * unverifiable providers/models always pass.
   */
  isLive(provider: string, model: string): boolean {
    const ids = this.getLive(provider);
    if (!ids) return true;
    return ids.includes(model);
  }

  /** Filter out audio/TTS/embedding/image-gen models that cannot serve chat completions. */
  isChatModel(modelId: string): boolean {
    return !/\b(whisper|tts|playai-tts|embed|embedding|flux|imagen|dall-e|stable-diffusion|rerank|moderation|guard|speech|audio)\b/i.test(modelId);
  }

  /**
   * Resolve a requested model to one the provider still serves. Returns the
   * requested model untouched when it's live (or unverifiable); otherwise the
   * provider default, or the first live chat model id when even the default is gone.
   */
  resolveLiveModel(provider: string, model: string, fallback: string): { model: string; substituted: boolean } {
    if (this.isLive(provider, model)) return { model, substituted: false };
    const firstChatLive = this.getLive(provider)?.find(id => this.isChatModel(id));
    const replacement = this.isLive(provider, fallback)
      ? fallback
      : (firstChatLive ?? fallback);
    return { model: replacement, substituted: true };
  }

  /** Snapshot metadata for diagnostics. */
  status(): Record<string, { count: number; fetchedAt: string; source: string }> {
    const out: Record<string, { count: number; fetchedAt: string; source: string }> = {};
    for (const [p, e] of Object.entries(this.registry.providers)) {
      out[p] = { count: e.ids.length, fetchedAt: e.fetchedAt, source: e.source };
    }
    return out;
  }

  shutdown(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }
}

export const modelRegistryService = new ModelRegistryService();
