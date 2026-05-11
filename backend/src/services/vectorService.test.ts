import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { vectorService } from './vectorService';
import { sqliteService } from './db/sqliteService';
import fs from 'fs/promises';
import path from 'path';

// Deterministic word-bag embedding so tests run without a real Gemini API key
const makeEmbedding = (text: string): number[] => {
  const arr = new Array(768).fill(0);
  const words = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/);
  for (const word of words) {
    if (!word) continue;
    let h = 5381;
    for (let i = 0; i < word.length; i++) h = ((h << 5) + h + word.charCodeAt(i)) >>> 0;
    arr[h % 768] += 1;
  }
  const mag = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
  return mag > 0 ? arr.map(v => v / mag) : arr;
};

const mockEmbedModel = {
  embedContent: async (text: string) => ({ embedding: { values: makeEmbedding(text) } }),
  batchEmbedContents: async ({ requests }: any) => ({
    embeddings: requests.map((r: any) => ({ values: makeEmbedding(r.content.parts[0].text) })),
  }),
};

beforeAll(async () => {
  (vectorService as any).genAI = { getGenerativeModel: () => mockEmbedModel };
  // Wait for the constructor's un-awaited loadMemory() to finish, then reset to a clean slate
  // so it can't race-overwrite entries added by addEntriesBatch during tests.
  await (vectorService as any).loadMemory();
  (vectorService as any).memory = [];
  (vectorService as any).rebuildIndices();
});

const EMBEDDING_CACHE_PATH = (vectorService as any).embeddingCachePath as string;

describe('VectorService Enhancements', () => {
  beforeEach(() => {
    // Clean memory before each test to avoid cross-test contamination
    (vectorService as any).memory = [];
    (vectorService as any).rebuildIndices();
  });

  it('should support batch adding entries', async () => {
    const entries = [
      { text: 'Batch entry 1', metadata: { type: 'test', tags: ['batch'] } },
      { text: 'Batch entry 2', metadata: { type: 'test', tags: ['batch', 'secondary'] } }
    ];

    const ids = await vectorService.addEntriesBatch(entries);
    expect(ids).toHaveLength(2);
    
    // Verify indexing
    const results = await vectorService.search('Batch entry', 5, { tags: ['batch'] });
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.some(r => r.metadata.text === 'Batch entry 1')).toBe(true);
  });

  it('should use LRU cache for embeddings', async () => {
    // This is hard to test directly without exposing internals more, 
    // but we can verify that repeated calls are fast.
    const text = 'Cache test ' + Date.now();
    const start1 = Date.now();
    await vectorService.getEmbedding(text);
    const end1 = Date.now();
    
    const start2 = Date.now();
    await vectorService.getEmbedding(text);
    const end2 = Date.now();
    
    // Cached call should be fast (under 50ms); allow slack for CI timing jitter
    expect(end2 - start2).toBeLessThanOrEqual(50);
  });

  it('should filter by type using index', async () => {
    const type = 'unique_type_' + Date.now();
    await vectorService.addEntry('Type test', { type });

    const results = await vectorService.search('Type test', 5, { type });
    expect(results).toHaveLength(1);
    expect(results[0]!.metadata.type).toBe(type);
  });

  it('LRU embedding cache evicts the coldest key by access order', async () => {
    // Swap in a small cache for this test, then restore.
    const { LRUCache } = await import('lru-cache');
    const original = (vectorService as any).embeddingCache;
    (vectorService as any).embeddingCache = new LRUCache<string, any>({ max: 3 });

    try {
      await vectorService.getEmbedding('cold-key-a');
      await vectorService.getEmbedding('cold-key-b');
      await vectorService.getEmbedding('cold-key-c');

      // Touch A so B becomes the coldest.
      await vectorService.getEmbedding('cold-key-a');

      // Adding a 4th key should evict B (oldest by access), not C (newest by access).
      await vectorService.getEmbedding('cold-key-d');

      const cache = (vectorService as any).embeddingCache;
      expect(cache.size).toBe(3);
      expect(cache.has('cold-key-a')).toBe(true);
      expect(cache.has('cold-key-b')).toBe(false);
      expect(cache.has('cold-key-c')).toBe(true);
      expect(cache.has('cold-key-d')).toBe(true);
    } finally {
      (vectorService as any).embeddingCache = original;
    }
  });
});

describe('Embedding Cache Persistence (SQLite)', () => {
  beforeEach(() => {
    // Isolate each test from leftover rows in the shared singleton DB.
    sqliteService.db.exec('DELETE FROM embedding_cache');
    (vectorService as any).embeddingCache.clear();
  });

  afterEach(async () => {
    // Clean up any legacy JSON file a migration test may have left behind.
    try {
      await fs.unlink(EMBEDDING_CACHE_PATH);
    } catch {
      // File may not exist, that's fine
    }
    sqliteService.db.exec('DELETE FROM embedding_cache');
  });

  it('persists dirty embeddings to SQLite (no JSON file)', async () => {
    const text = 'Cache persistence test ' + Date.now();
    await vectorService.getEmbedding(text);

    expect(sqliteService.countEmbeddings()).toBe(0); // dirty, not yet flushed
    await vectorService.persistEmbeddingCache();
    expect(sqliteService.countEmbeddings()).toBeGreaterThan(0);

    // V4 removed the JSON file write path entirely.
    const jsonExists = await fs.access(EMBEDDING_CACHE_PATH).then(() => true).catch(() => false);
    expect(jsonExists).toBe(false);
  });

  it('loads embedding cache from SQLite on initialization', async () => {
    const preVec = new Array(768).fill(0); // f32-exact zeros
    sqliteService.upsertEmbedding('preloaded_test_entry', preVec, Date.now());

    (vectorService as any).embeddingCache.clear();
    await vectorService.loadEmbeddingCache();

    const start = Date.now();
    const result = await vectorService.getEmbedding('preloaded_test_entry');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    expect(result).toHaveLength(768);
  });

  it('round-trips dirty entries through SQLite', async () => {
    // f32-exact pattern so the BLOB round-trip is bitwise identical.
    const testVector = new Array(768).fill(0).map((_, i) => (i % 4) * 0.25);
    (vectorService as any).embeddingCache.set('persist_test_text', {
      vector: testVector,
      lastAccess: Date.now(),
      dirty: true,
    });

    await vectorService.persistEmbeddingCache();

    (vectorService as any).embeddingCache.clear();
    expect((vectorService as any).embeddingCache.size).toBe(0);

    await (vectorService as any).loadEmbeddingCache();

    const reloaded = (vectorService as any).embeddingCache.get('persist_test_text');
    expect(reloaded).toBeDefined();
    expect(reloaded.vector).toEqual(testVector);
    expect(reloaded.dirty).toBe(false);
  });

  it('migrates legacy JSON cache to SQLite on first boot and removes the file', async () => {
    // Pre-seed legacy JSON, ensure SQLite is empty so the migration path runs.
    sqliteService.db.exec('DELETE FROM embedding_cache');
    const legacy = [
      { text: 'legacy-1', vector: new Array(768).fill(0), lastAccess: 1234567890 },
      { text: 'legacy-2', vector: new Array(768).fill(0).map((_, i) => (i % 2) * 0.5), lastAccess: 9999999999 },
    ];
    await fs.writeFile(EMBEDDING_CACHE_PATH, JSON.stringify(legacy));

    (vectorService as any).embeddingCache.clear();
    await vectorService.loadEmbeddingCache();

    expect(sqliteService.countEmbeddings()).toBe(2);
    const jsonExists = await fs.access(EMBEDDING_CACHE_PATH).then(() => true).catch(() => false);
    expect(jsonExists).toBe(false);

    // Second boot: SQLite already populated, JSON gone → migration path is a no-op.
    (vectorService as any).embeddingCache.clear();
    await vectorService.loadEmbeddingCache();
    expect((vectorService as any).embeddingCache.has('legacy-1')).toBe(true);
    expect((vectorService as any).embeddingCache.has('legacy-2')).toBe(true);
  });

  it('LRU eviction also deletes the SQLite row via dispose hook', async () => {
    const { LRUCache } = await import('lru-cache');
    const original = (vectorService as any).embeddingCache;
    // Mirror the production dispose hook on a tiny cache so eviction is observable.
    (vectorService as any).embeddingCache = new LRUCache<string, any>({
      max: 2,
      // Mirror the production dispose hook: only react to true evictions.
      dispose: (_v: unknown, key: string, reason: unknown) => {
        if (reason !== 'evict') return;
        try { sqliteService.deleteEmbedding(key); } catch { /* test-only swallow */ }
      },
    });

    try {
      sqliteService.upsertEmbedding('evict-a', new Array(4).fill(0), Date.now());
      sqliteService.upsertEmbedding('evict-b', new Array(4).fill(0), Date.now());
      sqliteService.upsertEmbedding('evict-c', new Array(4).fill(0), Date.now());
      expect(sqliteService.countEmbeddings()).toBe(3);

      // Fill the in-memory cache, then push a 4th key so the LRU evicts the oldest.
      (vectorService as any).embeddingCache.set('evict-a', { vector: [0, 0, 0, 0], lastAccess: 1, dirty: false });
      (vectorService as any).embeddingCache.set('evict-b', { vector: [0, 0, 0, 0], lastAccess: 2, dirty: false });
      (vectorService as any).embeddingCache.set('evict-c', { vector: [0, 0, 0, 0], lastAccess: 3, dirty: false });

      // The LRU evicted 'evict-a' (capacity 2 + 3 inserts ⇒ 'a' is gone).
      // Dispose hook must have removed it from SQLite too.
      const remaining = new Set(
        (await sqliteService.getAllEmbeddingsAsync()).map(r => r.text)
      );
      expect(remaining.has('evict-a')).toBe(false);
      expect(remaining.has('evict-b')).toBe(true);
      expect(remaining.has('evict-c')).toBe(true);
    } finally {
      (vectorService as any).embeddingCache = original;
    }
  });
});
