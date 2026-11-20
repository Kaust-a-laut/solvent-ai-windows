// backend/src/services/previewStashStore.ts
export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

export interface PreviewStash {
  entries: ConsoleEntry[];
  bodyHTML: string | null;
  bodyHash: string | null;
  updatedAt: number;
}

export class PreviewStashStore {
  private store = new Map<string, { data: PreviewStash; expiry: number }>();
  private pruneInterval: ReturnType<typeof setInterval>;

  constructor(
    private ttlMs: number = 600_000,
    private pruneIntervalMs: number = 60_000,
    private maxSessions: number = 50,
  ) {
    this.pruneInterval = setInterval(() => this.prune(), pruneIntervalMs);
    this.pruneInterval.unref(); // Don't keep process alive
  }

  set(sessionId: string, data: PreviewStash): void {
    // Bound the map: each stash can hold a full body HTML snapshot, and the
    // 10-minute TTL alone doesn't cap how many sessions accumulate.
    this.store.delete(sessionId); // re-insert so Map order tracks recency
    while (this.store.size >= this.maxSessions) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    this.store.set(sessionId, {
      data: { ...data, updatedAt: Date.now() },
      expiry: Date.now() + this.ttlMs,
    });
  }

  get(sessionId: string): PreviewStash | null {
    const entry = this.store.get(sessionId);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.store.delete(sessionId);
      return null;
    }
    return entry.data;
  }

  delete(sessionId: string): void {
    this.store.delete(sessionId);
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiry) this.store.delete(key);
    }
  }

  destroy(): void {
    clearInterval(this.pruneInterval);
    this.store.clear();
  }
}

export const previewStashStore = new PreviewStashStore();
