export interface IStorageProvider {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  saveTrace(data: Record<string, unknown>): Promise<string>;
}

import fs from 'fs/promises';
import path from 'path';
import { createHash, randomBytes } from 'node:crypto';
import { AtomicFileSystem } from '../utils/fileSystem';

interface CacheRecord {
  /** Epoch ms after which the entry is expired; 0 = never. */
  expiresAt: number;
  value: unknown;
}

export class FileStorageProvider implements IStorageProvider {
  private baseDir: string;
  private cacheDir: string;
  private tracesDir: string;
  // Directory creation is async — every operation awaits it, so the first
  // get/set after construction can't race ahead of mkdir.
  private ready: Promise<void>;

  constructor() {
    this.baseDir = path.join(process.cwd(), '.solvent');
    this.cacheDir = path.join(this.baseDir, 'cache');
    this.tracesDir = path.join(this.baseDir, 'traces');
    this.ready = this.init();
    this.ready.catch(() => { /* surfaced again by the awaiting operation */ });
  }

  private async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.mkdir(this.tracesDir, { recursive: true });
  }

  /**
   * Keys are hashed into the filename — joining a raw key let `../../x`
   * read or write outside the cache directory.
   */
  private cachePath(key: string): string {
    const digest = createHash('sha256').update(String(key)).digest('hex');
    return path.join(this.cacheDir, `${digest}.json`);
  }

  async get(key: string): Promise<unknown | null> {
    await this.ready;
    const cachePath = this.cachePath(key);
    try {
      const parsed = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as Partial<CacheRecord>;
      if (parsed && typeof parsed === 'object' && 'expiresAt' in parsed && 'value' in parsed) {
        if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
          await fs.unlink(cachePath).catch(() => { /* already gone */ });
          return null;
        }
        return parsed.value ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** @param ttl seconds; omitted or 0 = no expiry. */
  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    await this.ready;
    const expiresAt = typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0 ? Date.now() + ttl * 1000 : 0;
    const record: CacheRecord = { expiresAt, value };
    await AtomicFileSystem.writeJson(this.cachePath(key), record);
  }

  async saveTrace(data: Record<string, unknown>): Promise<string> {
    await this.ready;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const traceId = `trace-${timestamp}-${randomBytes(4).toString('hex')}`;
    const tracePath = path.join(this.tracesDir, `${traceId}.json`);
    await fs.writeFile(tracePath, JSON.stringify({
        id: traceId,
        timestamp: new Date().toISOString(),
        ...data
    }, null, 2));
    return traceId;
  }
}
