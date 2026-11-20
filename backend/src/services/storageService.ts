import { logger } from '../utils/logger';

// Interface allows swapping for Redis later
export interface IStorage {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  incr(key: string): Promise<number>;
  del(key: string): Promise<void>;
}

// Expired entries are only dropped when read, so keys that are never read
// again (one-off rate-limit buckets) accumulated forever. Sweep once the map
// grows past this size, at most once per SWEEP_INTERVAL_MS.
const SWEEP_THRESHOLD = 1000;
const SWEEP_INTERVAL_MS = 60_000;

export class StorageService implements IStorage {
  // In-memory fallback. Circuit breaker state is lost on restart.
  // In production, replace this implementation with a Redis-backed store.
  private memory = new Map<string, { val: unknown, exp: number }>();
  private lastSweep = 0;

  constructor() {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('[StorageService] WARNING: Using in-memory storage in production. Circuit breaker state will not survive restarts. Configure a Redis-backed StorageService for production use.');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const data = this.memory.get(key);
    if (!data) return null;
    if (data.exp !== 0 && Date.now() > data.exp) {
      this.memory.delete(key);
      return null;
    }
    return data.val as T;
  }

  async set(key: string, value: unknown, ttlSeconds: number = 0): Promise<void> {
    const exp = ttlSeconds === 0 ? 0 : Date.now() + (ttlSeconds * 1000);
    this.memory.set(key, { val: value, exp });
    this.maybeSweep();
  }

  /**
   * Increment a counter, preserving its remaining TTL. (Re-setting with no
   * TTL turned a windowed counter into a permanent one on the first incr.)
   */
  async incr(key: string): Promise<number> {
    const now = Date.now();
    const existing = this.memory.get(key);
    const live = existing && (existing.exp === 0 || now <= existing.exp) ? existing : undefined;
    const current = typeof live?.val === 'number' ? live.val : 0;
    const next = current + 1;
    this.memory.set(key, { val: next, exp: live?.exp ?? 0 });
    this.maybeSweep();
    return next;
  }

  async del(key: string): Promise<void> {
    this.memory.delete(key);
  }

  private maybeSweep(): void {
    if (this.memory.size < SWEEP_THRESHOLD) return;
    const now = Date.now();
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, entry] of this.memory) {
      if (entry.exp !== 0 && now > entry.exp) this.memory.delete(key);
    }
  }
}

export const storageService = new StorageService();
