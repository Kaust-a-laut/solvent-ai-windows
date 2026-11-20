import { GoogleGenerativeAI } from '@google/generative-ai';
import { LRUCache } from 'lru-cache';
import { config } from '../config';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger';
import { CrystallizedMemory, CrystallizedRule, SuccessPattern, SupervisoryInsight } from '../types/memory';
import { BackupManager } from '../utils/backupManager';
import { AtomicFileSystem } from '../utils/fileSystem';
import { HNSWIndex } from '../utils/hnswIndex';
import { memoryMetrics } from '../utils/memoryMetrics';
import { OllamaService } from './ollamaService';
import { sqliteService } from './db/sqliteService';
import { BM25Index, reciprocalRankFusion } from '../utils/bm25';
import { isExcludedFromIndex } from '../utils/sensitivePaths';

interface VectorLink {
  targetId: string;
  type: string;
}

export interface VectorMetadata {
  id?: string;
  text?: string;
  type?: string;
  tier?: MemoryTier;
  importance?: number;
  createdAt?: string;
  status?: string;
  links?: Array<string | VectorLink>;
  isAnchor?: boolean;
  isUniversal?: boolean;
  timestamp?: string;
  tags?: string[];
  filePath?: string;
  symbols?: string[];
  fileModifiedAt?: number;
  [key: string]: unknown;
}

interface VectorEntry {
  id: string;
  vector: number[];
  metadata: VectorMetadata;
}

export type MemoryTier = 'episodic' | 'crystallized' | 'meta-summary' | 'archived';

interface CachedEmbedding {
  vector: number[];
  lastAccess: number;
  dirty: boolean; // Flag for efficient persistence
}

export class VectorService {
  private genAI: GoogleGenerativeAI | null = null;
  private ollama: OllamaService | null = null;
  private dbPath: string;
  private embeddingCachePath: string;
  private memory: VectorEntry[] = [];
  // O(1) id → entry lookup. Shadows `this.memory` and MUST be kept in sync via
  // trackEntry/untrackEntry (or a rebuildIndices() pass for bulk resets).
  private memoryById: Map<string, VectorEntry> = new Map();
  private isIndexing: boolean = false;
  // O(1) eviction via lru-cache v11. Initialized in the constructor so we can
  // read MAX_CACHE_SIZE without depending on field-initializer ordering.
  private embeddingCache!: LRUCache<string, CachedEmbedding>;
  private embeddingCacheLoaded: Promise<void>;
  // Resolves when the SQLite-backed memory array has been loaded; async entry
  // points await this so early requests don't observe an empty store.
  private memoryLoaded: Promise<void>;
  private hnswReady: Promise<void>;
  private newEntriesSinceLastDream: number = 0;
  private readonly SATURATION_THRESHOLD = 200;
  private cacheWriteCounter: number = 0;
  private readonly CACHE_PERSIST_THRESHOLD = 100;
  private backupManager: BackupManager;
  private hnswIndex: HNSWIndex | null = null;
  private hnswIndexPath: string;
  private useHNSW: boolean = true;
  private saveCounter: number = 0;
  private readonly BACKUP_INTERVAL = 50;
  private hnswSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly HNSW_SAVE_DEBOUNCE_MS = 30_000;

  // LRU Cache Configuration
  private readonly MAX_CACHE_SIZE = config.MEMORY_CACHE_SIZE;

  // Embedding circuit breaker: after a Gemini failure, skip it for a cooldown
  // window rather than for the rest of the process lifetime, then retry.
  private geminiEmbedFailedAt: number | null = null;
  private readonly GEMINI_EMBED_RETRY_MS = 5 * 60_000;

  // Secondary Indices
  public typeIndex: Map<string, Set<string>> = new Map();
  public tagIndex: Map<string, Set<string>> = new Map();
  public symbolIndex: Map<string, string> = new Map(); // symbol -> entryId
  private bm25Index = new BM25Index();

  constructor() {
    this.embeddingCache = new LRUCache({
      max: this.MAX_CACHE_SIZE,
      // V4: drop the on-disk row only when the LRU genuinely evicts an entry
      // because it's full. lru-cache also calls dispose on 'set' (overwrite)
      // and 'delete' (explicit/.clear()) — both are correctness-neutral for the
      // disk layer, and treating them as evictions would wipe SQLite on every
      // reload. The next persist cycle will upsert the new in-memory value.
      dispose: (_value, key, reason) => {
        if (reason !== 'evict') return;
        try {
          sqliteService.deleteEmbedding(key);
        } catch (e) {
          logger.debug(`[VectorService] deleteEmbedding on evict failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
    if (config.GEMINI_API_KEY) {
      this.genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    }
    // Initialize Ollama as fallback for embeddings
    this.ollama = new OllamaService();
    this.dbPath = process.env.SOLVENT_VECTOR_MEMORY_PATH || path.resolve(__dirname, '../../../.solvent_memory.json');
    this.embeddingCachePath = process.env.SOLVENT_EMBEDDING_CACHE_PATH || path.resolve(__dirname, '../../../.solvent_embedding_cache.json');
    this.backupManager = new BackupManager(
      this.dbPath,
      process.env.SOLVENT_BACKUP_DIR || path.resolve(__dirname, '../../../.solvent_backups'),
      5
    );
    this.hnswIndexPath = process.env.SOLVENT_HNSW_PATH || path.resolve(__dirname, '../../../.solvent_hnsw.bin');
    // Sequenced startup: memory first, then the embedding cache (no concurrent
    // SQLite readers), and the HNSW index decides load-vs-rebuild only once
    // memory is known — avoiding the load/rebuild clobber race.
    this.memoryLoaded = this.loadMemory();
    this.embeddingCacheLoaded = this.memoryLoaded
      .catch(() => { /* loadMemory handles its own errors */ })
      .then(() => this.loadEmbeddingCache());
    this.hnswReady = this.initHNSWIndex().catch((e: unknown) => {
      logger.warn('[VectorService] HNSW initialization failed, using brute force.', e);
      this.useHNSW = false;
    });
  }

  /** Resolves once memory, embedding cache, and HNSW index have finished loading. */
  async waitUntilReady(): Promise<void> {
    await Promise.all([
      this.memoryLoaded.catch(() => undefined),
      this.embeddingCacheLoaded.catch(() => undefined),
      this.hnswReady,
    ]);
  }

  private createEmptyHnswIndex(): HNSWIndex {
    return new HNSWIndex(768, Math.max(config.MEMORY_MAX_ENTRIES + 500, this.memory.length + 500));
  }

  private async initHNSWIndex() {
    try {
      this.hnswIndex = this.createEmptyHnswIndex();
    } catch (e) {
      logger.warn('[VectorService] HNSW initialization failed, using brute force.', e);
      this.useHNSW = false;
      return;
    }

    await this.memoryLoaded.catch(() => undefined);

    let loaded = false;
    try {
      await fs.access(this.hnswIndexPath);
      const candidate = this.createEmptyHnswIndex();
      await candidate.load(this.hnswIndexPath);
      this.hnswIndex = candidate;
      loaded = true;
    } catch {
      // No (valid) persisted index — fall through to rebuild from memory.
    }

    // Reconcile: a persisted index that disagrees with SQLite memory is stale.
    if (!loaded || this.hnswIndex.size() !== this.memory.length) {
      if (this.memory.length > 0 || loaded) {
        await this.rebuildHNSWIndex();
      }
    } else {
      logger.info('[VectorService] Loaded existing HNSW index.');
    }
  }

  private async rebuildHNSWIndex() {
    if (!this.useHNSW) return;

    logger.info('[VectorService] Rebuilding HNSW index from memory...');
    // Build into a fresh index so stale labels from a previous index never survive.
    const fresh = this.createEmptyHnswIndex();
    for (const entry of this.memory) {
      if (Array.isArray(entry.vector) && entry.vector.length === 768) {
        fresh.add(entry.id, entry.vector);
      }
    }
    this.hnswIndex = fresh;

    try {
      await fresh.save(this.hnswIndexPath);
      logger.info(`[VectorService] HNSW index rebuilt with ${fresh.size()} entries.`);
    } catch (e) {
      logger.error('[VectorService] Failed to save rebuilt HNSW index', e);
    }
  }

  private getGenAI(): GoogleGenerativeAI {
    if (!this.genAI) {
      throw new Error('Gemini API Key missing for Vector Service.');
    }
    return this.genAI;
  }

  // Half-open circuit breaker: skip Gemini while cooling down after a failure,
  // then allow one retry. Also false when no API key is configured.
  private geminiEmbedAvailable(): boolean {
    if (!this.genAI) return false;
    if (this.geminiEmbedFailedAt === null) return true;
    return Date.now() - this.geminiEmbedFailedAt > this.GEMINI_EMBED_RETRY_MS;
  }

  private async loadMemory() {
    try {
      // Use the async, chunked loader so a large memory store doesn't block
      // the event loop on startup. Rows are JSON-parsed in batches of 500
      // with setImmediate yields between batches.
      this.memory = (await sqliteService.getAllMemoriesAsync()) as VectorEntry[];
      this.rebuildIndices();
      logger.info(`Loaded ${this.memory.length} vectors from SQLite memory and rebuilt indices.`);
      // HNSW load-vs-rebuild is decided in initHNSWIndex() after this resolves.
    } catch (e: unknown) {
      const err = e as Error;
      logger.error(`[VectorService] Failed to load memory from SQLite: ${err.message}`);

      // Attempt recovery from backup
      const recovered = await this.attemptRecovery();
      if (!recovered) {
        logger.warn('[VectorService] Starting with empty memory.');
        this.memory = [];
        this.memoryById.clear();
      }
    }
  }

  async attemptRecovery(): Promise<boolean> {
    logger.warn('[VectorService] Attempting recovery from backup...');
    const restored = await this.backupManager.restoreFromBackup();
    if (restored) {
      try {
        const data = await fs.readFile(this.dbPath, 'utf-8');
        this.memory = JSON.parse(data);
        this.rebuildIndices();

        // Re-persist into SQLite so the recovery survives the next restart —
        // without this the heal is RAM-only and the broken store wins again.
        try {
          sqliteService.insertMemories(this.memory);
        } catch (persistErr) {
          logger.warn('[VectorService] Could not re-persist recovered entries to SQLite (in-memory recovery only)', persistErr);
        }

        logger.info(`[VectorService] Recovery successful. Loaded ${this.memory.length} vectors.`);
        // When recovery runs during startup, initHNSWIndex() rebuilds after memoryLoaded resolves.
        if (this.useHNSW && this.hnswIndex) await this.rebuildHNSWIndex();
        return true;
      } catch (e) {
        logger.error('[VectorService] Failed to load restored data');
        return false;
      }
    }
    return false;
  }

  async loadEmbeddingCache() {
    try {
      const dbCount = sqliteService.countEmbeddings();
      if (dbCount > 0) {
        const rows = await sqliteService.getAllEmbeddingsAsync();
        this.embeddingCache.clear();
        for (const row of rows) {
          this.embeddingCache.set(row.text, {
            vector: row.vector,
            lastAccess: row.lastAccess,
            dirty: false,
          });
        }
        logger.info(`[VectorService] Loaded ${rows.length} cached embeddings from SQLite.`);
        return;
      }

      // First boot after V4 upgrade — migrate the legacy JSON cache once, then
      // unlink the file so we don't re-migrate on every restart.
      let parsed: unknown;
      try {
        const data = await fs.readFile(this.embeddingCachePath, 'utf-8');
        parsed = JSON.parse(data);
      } catch (e: unknown) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          logger.debug('[VectorService] No legacy embedding cache file; starting fresh.');
        } else {
          logger.warn(`[VectorService] Failed to read legacy cache file: ${err.message}. Starting fresh.`);
        }
        return;
      }

      if (!Array.isArray(parsed)) {
        logger.warn('[VectorService] Legacy embedding cache file has invalid format; skipping migration.');
        return;
      }

      const migrationPayload: Array<{ text: string; vector: number[]; lastAccess: number }> = [];
      this.embeddingCache.clear();
      for (const entry of parsed) {
        if (entry && typeof entry.text === 'string' && Array.isArray(entry.vector)) {
          const lastAccess = entry.lastAccess || Date.now();
          this.embeddingCache.set(entry.text, {
            vector: entry.vector,
            lastAccess,
            dirty: false,
          });
          migrationPayload.push({ text: entry.text, vector: entry.vector, lastAccess });
        }
      }

      if (migrationPayload.length > 0) {
        sqliteService.upsertEmbeddings(migrationPayload);
        await fs.unlink(this.embeddingCachePath).catch(() => { /* best effort */ });
        logger.info(`[VectorService] Migrated ${migrationPayload.length} cached embeddings from JSON to SQLite (legacy file removed).`);
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      logger.warn(`[VectorService] Failed to load embedding cache from SQLite: ${err.message}. Starting fresh.`);
    }
  }

  async persistEmbeddingCache() {
    try {
      const now = Date.now();
      const dirty: Array<{ text: string; entry: CachedEmbedding }> = [];
      for (const [text, entry] of this.embeddingCache.entries()) {
        if (entry.dirty) dirty.push({ text, entry });
      }
      if (dirty.length === 0) {
        logger.debug('[VectorService] No dirty entries to persist.');
        return;
      }

      const payload = dirty.map(d => ({
        text: d.text,
        vector: d.entry.vector,
        lastAccess: d.entry.lastAccess || now,
      }));
      sqliteService.upsertEmbeddings(payload);
      for (const d of dirty) d.entry.dirty = false;
      logger.info(`[VectorService] Persisted ${dirty.length} dirty embeddings to SQLite.`);
    } catch (error) {
      logger.error('[VectorService] Failed to persist embedding cache', error);
    }
  }

  private rebuildIndices() {
    this.typeIndex.clear();
    this.tagIndex.clear();
    this.symbolIndex.clear();
    this.memoryById.clear();
    const docs: Array<{ id: string, text: string }> = [];
    for (const entry of this.memory) {
      this.memoryById.set(entry.id, entry);
      this.addToIndices(entry);
      docs.push({ id: entry.id, text: entry.metadata.text || '' });
    }
    this.bm25Index.build(docs);
  }

  // Single insertion point for new entries — keeps this.memory and
  // this.memoryById in lockstep. Eviction and bulk-reset paths bypass this and
  // call rebuildIndices() instead.
  private trackEntry(entry: VectorEntry): void {
    this.memory.push(entry);
    this.memoryById.set(entry.id, entry);
    this.bm25Index.addDocument({ id: entry.id, text: entry.metadata.text || '' });
  }

  // Removes a single entry from the in-memory array + id map. Returns the
  // splice index for callers that need to know whether anything was removed.
  // Linear over this.memory by design (id index can't replace splice without
  // breaking iteration order); bulk delete paths should still prefer a single
  // filter + map.clear sequence.
  private untrackEntry(id: string): number {
    const idx = this.memory.findIndex(m => m.id === id);
    if (idx === -1) return -1;
    this.memory.splice(idx, 1);
    this.memoryById.delete(id);
    this.bm25Index.removeDocument(id);
    return idx;
  }

  private addToIndices(entry: VectorEntry) {
    // Type Index
    const type = entry.metadata.type;
    if (type) {
      if (!this.typeIndex.has(type)) this.typeIndex.set(type, new Set());
      this.typeIndex.get(type)!.add(entry.id);
    }

    // Tag Index
    const tags = entry.metadata.tags;
    if (Array.isArray(tags)) {
      for (const tag of tags) {
        if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
        this.tagIndex.get(tag)!.add(entry.id);
      }
    }

    // Symbol Index
    const symbols = entry.metadata.symbols;
    if (Array.isArray(symbols)) {
      for (const symbol of symbols) {
        this.symbolIndex.set(symbol, entry.id);
      }
    }
  }

  private removeFromIndices(id: string) {
    if (this.hnswIndex && this.useHNSW) {
      this.hnswIndex.markDeleted(id);
    }
    this.removeFromSecondaryIndices(id);
  }

  // Type/tag/symbol indices only — leaves HNSW and BM25 untouched.
  private removeFromSecondaryIndices(id: string) {
    const entry = this.memoryById.get(id);
    if (!entry) return;

    if (entry.metadata.type) {
      this.typeIndex.get(entry.metadata.type)?.delete(id);
    }

    if (Array.isArray(entry.metadata.tags)) {
      for (const tag of entry.metadata.tags) {
        this.tagIndex.get(tag)?.delete(id);
      }
    }

    if (Array.isArray(entry.metadata.symbols)) {
      for (const symbol of entry.metadata.symbols) {
        if (this.symbolIndex.get(symbol) === id) {
          this.symbolIndex.delete(symbol);
        }
      }
    }
  }

  private extractSymbols(text: string): string[] {
    const symbols: string[] = [];
    // Class definitions
    const classMatches = text.matchAll(/class\s+([a-zA-Z0-9_]+)/g);
    for (const match of classMatches) {
      const sym = match[1];
      if (sym) symbols.push(sym);
    }

    // Interface definitions
    const interfaceMatches = text.matchAll(/interface\s+([a-zA-Z0-9_]+)/g);
    for (const match of interfaceMatches) {
      const sym = match[1];
      if (sym) symbols.push(sym);
    }

    // Function definitions
    const functionMatches = text.matchAll(/function\s+([a-zA-Z0-9_]+)/g);
    for (const match of functionMatches) {
      const sym = match[1];
      if (sym) symbols.push(sym);
    }

    // Exported constants/vars
    const constMatches = text.matchAll(/export\s+(const|let|var)\s+([a-zA-Z0-9_]+)/g);
    for (const match of constMatches) {
      const sym = match[2];
      if (sym) symbols.push(sym);
    }

    return [...new Set(symbols)];
  }

  /**
   * Delete entries by file path (for incremental indexing)
   */
  async deleteByFilePath(filePath: string) {
    await this.memoryLoaded;
    const entriesToDelete = this.memory.filter(e => e.metadata.filePath === filePath);
    if (entriesToDelete.length === 0) return 0;
    for (const entry of entriesToDelete) {
      this.removeFromIndices(entry.id);
      this.bm25Index.removeDocument(entry.id);
      sqliteService.deleteMemory(entry.id);
      this.memoryById.delete(entry.id);
    }
    this.memory = this.memory.filter(e => e.metadata.filePath !== filePath);
    await this.saveMemory();
    return entriesToDelete.length;
  }

  /**
   * Add links to an existing entry
   */
  async addLinks(entryId: string, links: Array<{ targetId: string; type: string }>) {
    await this.memoryLoaded;
    const entry = this.memoryById.get(entryId);
    if (!entry) return false;

    if (!entry.metadata.links) {
      entry.metadata.links = [];
    }
    entry.metadata.links.push(...links);
    sqliteService.insertMemory(entry.id, entry.vector, entry.metadata);
    await this.saveMemory();
    return true;
  }

  /**
   * Get the symbol index for external use
   */
  getSymbolIndex(): Map<string, string> {
    return this.symbolIndex;
  }

  private async saveMemory() {
    try {
      const MAX_ENTRIES = config.MEMORY_MAX_ENTRIES;

      if (this.memory.length > MAX_ENTRIES) {
        // Smart Eviction: Protect Anchors and Meta-Summaries
        const critical = this.memory.filter(m =>
          m.metadata.tier === 'meta-summary' ||
          m.metadata.isAnchor === true ||
          m.metadata.confidence === 'HIGH'
        );
        const disposable = this.memory.filter(m =>
          m.metadata.tier !== 'meta-summary' &&
          m.metadata.isAnchor !== true &&
          m.metadata.confidence !== 'HIGH'
        );

        let evicted: VectorEntry[] = [];
        if (critical.length >= MAX_ENTRIES) {
           // Overflowing critical entries must be evicted from SQLite/HNSW too,
           // otherwise they silently reappear on the next restart.
           evicted = [...disposable, ...critical.slice(0, critical.length - MAX_ENTRIES)];
           this.memory = critical.slice(-MAX_ENTRIES);
        } else {
           const slotsLeft = MAX_ENTRIES - critical.length;
           evicted = disposable.slice(0, disposable.length - slotsLeft);
           const keptDisposable = disposable.slice(-slotsLeft);
           this.memory = [...critical, ...keptDisposable];
        }
        
        // Remove evicted from SQLite and the HNSW index (rebuildIndices below
        // resets the other indices, but HNSW retains ids unless marked deleted
        // — stale ids would keep consuming searchFast's candidate budget).
        for (const e of evicted) {
          sqliteService.deleteMemory(e.id);
          if (this.hnswIndex && this.useHNSW) {
            this.hnswIndex.markDeleted(e.id);
          }
        }

        this.rebuildIndices();
      }

      this.updateMetrics();

      // Periodic backup. BackupManager snapshots dbPath (the legacy JSON
      // file); since V4 the live store is SQLite, so dump current memory to
      // that JSON file first — otherwise rotation re-archives a stale file.
      this.saveCounter++;
      if (this.saveCounter >= this.BACKUP_INTERVAL) {
        this.saveCounter = 0;
        AtomicFileSystem.writeJson(this.dbPath, this.memory)
          .then(() => this.backupManager.createBackup())
          .catch(e => logger.error('[VectorService] Backup creation failed', e));
      }

      // Debounced HNSW index persistence
      if (this.hnswIndex && this.useHNSW) {
        this.scheduleHnswSave();
      }
    } catch (error) {
      logger.error('Failed to save vector memory', error);
    }
  }

  // --- TYPED STORAGE METHODS ---

  async saveRule(rule: CrystallizedRule) {
    const entry = {
      ...rule,
      tier: 'crystallized' as MemoryTier,
      isAnchor: true,
      importance: 5,
      type: 'permanent_rule',
      id: `rule_${Date.now()}`,
      createdAt: new Date().toISOString()
    };
    return this.addEntry(rule.ruleText, entry);
  }

  async savePattern(pattern: SuccessPattern) {
    const entry = {
      ...pattern,
      tier: 'crystallized' as MemoryTier,
      type: 'solution_pattern',
      id: `pattern_${Date.now()}`,
      createdAt: new Date().toISOString()
    };
    return this.addEntry(`${pattern.problemDomain}\n${pattern.solutionCode}`, entry);
  }

  async saveInsight(insight: SupervisoryInsight) {
    const entry = {
      ...insight,
      tier: 'crystallized' as MemoryTier,
      isAnchor: true,
      type: 'architectural_decision',
      id: `insight_${Date.now()}`,
      createdAt: new Date().toISOString()
    };
    return this.addEntry(`${insight.decision}\n${insight.rationale}`, entry);
  }

  // --- CORE METHODS ---

  /**
   * Get embedding with fallback chain: Gemini → Ollama → zero vector
   */
  async getEmbedding(text: string): Promise<number[]> {
    await this.embeddingCacheLoaded; // Ensure cache is loaded
    if (!text || text.trim().length === 0) return new Array(768).fill(0);

    const cached = this.embeddingCache.get(text);
    if (cached?.vector) {
      cached.lastAccess = Date.now();
      memoryMetrics.recordCacheHit();
      return cached.vector;
    }

    // Handle case where cache entry exists but vector is missing
    if (cached) {
      this.embeddingCache.delete(text);
    }

    // Try Gemini first (fast API, <1s for chat queries; skip while the
    // circuit breaker is cooling down)
    if (this.geminiEmbedAvailable()) {
      try {
        const genAI = this.getGenAI();
        const model = genAI.getGenerativeModel(
          { model: "gemini-embedding-001" },
        );
        const result = await model.embedContent(text);
        // gemini-embedding-001 outputs 3072 dims; truncate to 768 (Matryoshka embeddings)
        const values = result.embedding.values.slice(0, 768);

        this.geminiEmbedFailedAt = null;
        memoryMetrics.recordCacheMiss();
        this.cacheEmbedding(text, values);

        return values;
      } catch (err: unknown) {
        this.geminiEmbedFailedAt = Date.now();
        logger.warn(`[VectorService] Gemini embedding failed (cooling down ${this.GEMINI_EMBED_RETRY_MS / 60_000} min), trying Ollama fallback:`, err instanceof Error ? err.message : String(err));
      }
    }

    // Fallback to Ollama (free, local, native 768 dims)
    try {
      const values = await this.ollama!.embed(text);
      memoryMetrics.recordCacheMiss();
      this.cacheEmbedding(text, values);
      return values;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[VectorService] Ollama embedding also failed:', msg);
    }

    // Last resort: zero vector
    return new Array(768).fill(0);
  }

  async batchGetEmbeddings(texts: string[]): Promise<number[][]> {
    await this.embeddingCacheLoaded.catch(() => undefined);
    const results: number[][] = new Array(texts.length);
    const missingIndices: number[] = [];
    const missingTexts: string[] = [];

    texts.forEach((text, i) => {
      if (!text || text.trim().length === 0) {
        results[i] = new Array(768).fill(0);
      } else {
        const cached = this.embeddingCache.get(text);
        if (cached) {
          cached.lastAccess = Date.now();
          results[i] = cached.vector;
        } else {
          missingIndices.push(i);
          missingTexts.push(text);
        }
      }
    });

    if (missingTexts.length > 0) {
      let ollamaBatchOk = false;

      // Try Ollama batch first (free, local, native 768 dims — single API call)
      try {
        const batchVectors = await this.ollama!.batchEmbed(missingTexts);
        for (let i = 0; i < missingTexts.length; i++) {
          const originalIndex = missingIndices[i]!;
          results[originalIndex] = batchVectors[i]!;
          this.cacheEmbedding(missingTexts[i]!, batchVectors[i]!);
        }
        ollamaBatchOk = true;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[VectorService] Ollama batch embedding failed, trying Gemini fallback:', msg);
      }

      // Fallback to Gemini batch (skip while the circuit breaker is cooling down)
      if (!ollamaBatchOk && this.geminiEmbedAvailable()) {
        try {
          const genAI = this.getGenAI();
          const model = genAI.getGenerativeModel(
            { model: "gemini-embedding-001" },
          );

          const batchSize = 100;
          for (let i = 0; i < missingTexts.length; i += batchSize) {
            // Skip items already embedded by Ollama
            const chunk: string[] = [];
            const chunkOriginalIndices: number[] = [];
            for (let j = i; j < Math.min(i + batchSize, missingTexts.length); j++) {
              const origIdx = missingIndices[j]!;
              if (!results[origIdx]) {
                chunk.push(missingTexts[j]!);
                chunkOriginalIndices.push(origIdx);
              }
            }
            if (chunk.length === 0) continue;

            const response = await model.batchEmbedContents({
              requests: chunk.map(t => ({ content: { role: 'user', parts: [{ text: t }] } }))
            });

            response.embeddings.forEach((emb, j) => {
              // gemini-embedding-001 outputs 3072 dims; truncate to 768 (Matryoshka)
              const values = emb.values.slice(0, 768);
              results[chunkOriginalIndices[j]!] = values;
              this.cacheEmbedding(chunk[j]!, values);
            });
          }
          this.geminiEmbedFailedAt = null;
        } catch (err: unknown) {
          this.geminiEmbedFailedAt = Date.now();
          logger.warn(`[VectorService] Gemini batch embedding also failed (cooling down ${this.GEMINI_EMBED_RETRY_MS / 60_000} min):`, err instanceof Error ? err.message : String(err));
        }
      }

      // Fill any remaining gaps with zero vectors
      {
        for (let i = 0; i < missingTexts.length; i++) {
          const originalIndex = missingIndices[i]!;
          if (!results[originalIndex]) {
            results[originalIndex] = new Array(768).fill(0);
          }
        }
      }
    }

    return results;
  }

  private cacheEmbedding(text: string, vector: number[]) {
    // lru-cache handles eviction internally in O(1); we just set.
    this.embeddingCache.set(text, { vector, lastAccess: Date.now(), dirty: true });
    memoryMetrics.updateCacheSize(this.embeddingCache.size);

    // Periodic persistence: only trigger if the counter threshold is reached AND there are dirty entries
    this.cacheWriteCounter++;
    if (this.cacheWriteCounter >= this.CACHE_PERSIST_THRESHOLD) {
      this.cacheWriteCounter = 0;
      const hasDirty = Array.from(this.embeddingCache.values()).some(v => v.dirty);
      if (hasDirty) {
        this.persistEmbeddingCache().catch(e => logger.error('[VectorService] Cache persist failed', e));
      }
    }
  }

  async addEntry(text: string, metadata: VectorMetadata) {
    if (!text) return;
    await this.memoryLoaded;
    await this.hnswReady;
    const vector = await this.getEmbedding(text);
    
    // Normalize links if present
    let normalizedLinks = metadata.links;
    if (Array.isArray(metadata.links)) {
      normalizedLinks = metadata.links.map((link: string | VectorLink) =>
        typeof link === 'string' ? { targetId: link, type: 'references' } : link
      );
    }

    const entry: VectorEntry = {
      id: metadata.id || Date.now().toString() + Math.random().toString(36).substr(2, 5),
      vector,
      metadata: { 
        ...metadata, 
        text, 
        tier: metadata.tier || 'episodic',
        importance: metadata.importance || 5,
        createdAt: metadata.createdAt || new Date().toISOString(),
        status: metadata.status || 'active',
        links: normalizedLinks
      }
    };

    this.trackEntry(entry);
    sqliteService.insertMemory(entry.id, entry.vector, entry.metadata);
    this.addToIndices(entry);
    if (this.hnswIndex && this.useHNSW) {
      this.hnswIndex.add(entry.id, entry.vector);
    }
    this.newEntriesSinceLastDream++;

    if (this.newEntriesSinceLastDream >= this.SATURATION_THRESHOLD) {
      this.triggerAmnesiaCycle();
    }

    await this.saveMemory();
    return entry.id;
  }

  async addEntriesBatch(entries: { text: string, metadata: VectorMetadata }[]) {
    if (entries.length === 0) return [];
    await this.memoryLoaded;
    await this.hnswReady;

    const embeddings = await this.batchGetEmbeddings(entries.map(e => e.text));
    const ids: string[] = [];
    const toPersist: VectorEntry[] = [];

    entries.forEach((e, i) => {
      // Normalize links if present
      let normalizedLinks = e.metadata.links;
      if (Array.isArray(e.metadata.links)) {
        normalizedLinks = e.metadata.links.map((link: string | VectorLink) =>
          typeof link === 'string' ? { targetId: link, type: 'references' } : link
        );
      }

      const entry: VectorEntry = {
        id: e.metadata.id || Date.now().toString() + Math.random().toString(36).substr(2, 5) + `_${i}`,
        vector: embeddings[i] ?? new Array(768).fill(0),
        metadata: {
          ...e.metadata,
          text: e.text,
          tier: e.metadata.tier || 'episodic',
          importance: e.metadata.importance || 5,
          createdAt: e.metadata.createdAt || new Date().toISOString(),
          status: e.metadata.status || 'active',
          links: normalizedLinks
        }
      };
      this.trackEntry(entry);
      toPersist.push(entry);
      this.addToIndices(entry);
      if (this.hnswIndex && this.useHNSW) {
        this.hnswIndex.add(entry.id, entry.vector);
      }
      ids.push(entry.id);
    });

    // Single transaction instead of N implicit fsyncs
    sqliteService.insertMemories(toPersist);

    this.newEntriesSinceLastDream += entries.length;
    if (this.newEntriesSinceLastDream >= this.SATURATION_THRESHOLD) {
      this.triggerAmnesiaCycle();
    }

    await this.saveMemory();

    return ids;
  }

  async indexProject(rootPath: string) {
    if (this.isIndexing) {
      logger.warn('Indexing already in progress.');
      return;
    }
    this.isIndexing = true;
    logger.info(`Starting project indexing: ${rootPath}`);

    try {
      const ignoredDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'generated_images', 'uploads', 'coverage', '.vitest-tmp']);
      const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.md', '.txt', '.py', '.json']);
      const MAX_FILE_BYTES = 1024 * 1024; // skip generated/minified blobs
      const BATCH_SIZE = 20;
      const pendingEntries: { text: string, metadata: VectorMetadata }[] = [];
      const addedIds: string[] = [];

      const flush = async (count: number) => {
        const batch = pendingEntries.splice(0, count);
        if (batch.length === 0) return;
        const ids = await this.addEntriesBatch(batch);
        addedIds.push(...ids);
      };

      const scan = async (dir: string) => {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue; // never follow links out of the project
          if (entry.isDirectory()) {
            const lower = entry.name.toLowerCase();
            if (ignoredDirs.has(entry.name) || lower.startsWith('.solvent_')) continue;
            if (isExcludedFromIndex(fullPath)) continue;
            await scan(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (!extensions.has(ext)) continue;
            // Never embed secrets (settings.json, .env*, .solvent_* stores, keys, lockfiles)
            if (isExcludedFromIndex(fullPath)) continue;

            const stat = await fs.stat(fullPath);
            if (stat.size > MAX_FILE_BYTES) continue;

            const content = await fs.readFile(fullPath, 'utf-8');
            if (content.trim().length > 10) {
              pendingEntries.push(...this.chunkFile(content, fullPath, stat.mtimeMs));
              while (pendingEntries.length >= BATCH_SIZE) {
                await flush(BATCH_SIZE);
              }
            }
          }
        }
      };

      await scan(rootPath);
      await flush(pendingEntries.length);

      // Second pass: resolve links for ALL newly added entries (not just the last batch) and persist them
      if (addedIds.length > 0) {
        logger.info('[VectorService] Resolving semantic relationships...');
        const linked: VectorEntry[] = [];
        for (const id of addedIds) {
          const entry = this.memoryById.get(id);
          if (entry && entry.metadata.type === 'code_block') {
            const links = this.findReferenceTargets(entry.metadata.text || '', id);
            if (links.length > 0) {
              entry.metadata.links = links;
              linked.push(entry);
            }
          }
        }
        if (linked.length > 0) {
          sqliteService.insertMemories(linked);
        }
      }

      logger.info(`Project indexing completed (${addedIds.length} chunks).`);
    } catch (error) {
      logger.error('Error during project indexing', error);
      // Propagate so callers (indexProjectJob, routes) mark the run as failed
      throw error;
    } finally {
      this.isIndexing = false;
    }
  }

  private findReferenceTargets(text: string, sourceId: string): { targetId: string, type: string }[] {
    const links: { targetId: string, type: string }[] = [];
    // Single tokenization pass instead of compiling a \b-regex per indexed
    // symbol (O(symbols × text) before). Symbols are plain identifiers, so
    // exact token membership is equivalent to the old \bsymbol\b test.
    const tokens = new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);

    for (const [symbol, targetId] of this.symbolIndex.entries()) {
      // Avoid self-references
      if (targetId === sourceId) continue;
      if (!tokens.has(symbol)) continue;

      // Rudimentary check for 'implements' or 'extends'
      const depRegex = new RegExp(`(extends|implements|new|import|from)\\s+${symbol}\\b`);
      if (depRegex.test(text)) {
        links.push({ targetId, type: 'depends_on' });
      } else {
        links.push({ targetId, type: 'references' });
      }
    }

    return links;
  }

  private chunkFile(content: string, filePath: string, mtimeMs?: number): { text: string, metadata: VectorMetadata }[] {
    const maxChunkSize = 1200;
    const overlapSize = 200;
    const relativePath = path.relative(process.cwd(), filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isCodeFile = ['.ts', '.tsx', '.js', '.jsx', '.py'].includes(ext);

    // File modification time for stale detection (passed in from the async scan; no blocking stat)
    const fileModifiedAt: number | undefined = mtimeMs;

    // For code files, try to split at declaration boundaries first
    let blocks: string[];
    if (isCodeFile) {
      // Split at top-level declarations (class, function, export, interface)
      const declPattern = /\n(?=(?:export\s+)?(?:class|function|interface|const|let|var|type|enum)\s)/g;
      const declBlocks = content.split(declPattern).filter(b => b.trim().length > 0);
      // Use declaration-based splitting if it produces reasonable chunks
      blocks = declBlocks.length > 1 ? declBlocks : content.split(/\n\n+/);
    } else {
      blocks = content.split(/\n\n+/);
    }

    const chunks: { text: string, metadata: VectorMetadata }[] = [];
    let currentChunk = "";

    for (const block of blocks) {
      if ((currentChunk + block).length > maxChunkSize && currentChunk.length > 0) {
        chunks.push({
          text: currentChunk,
          metadata: {
            filePath: relativePath,
            type: 'code_block',
            tier: 'episodic',
            symbols: this.extractSymbols(currentChunk),
            fileModifiedAt
          }
        });
        // Keep overlap from end of current chunk for context continuity
        currentChunk = currentChunk.slice(-overlapSize);
      }
      currentChunk += (currentChunk ? "\n\n" : "") + block;
    }

    if (currentChunk.trim().length > 0) {
      chunks.push({
        text: currentChunk,
        metadata: {
          filePath: relativePath,
          type: 'code_block',
          tier: 'episodic',
          symbols: this.extractSymbols(currentChunk),
          fileModifiedAt
        }
      });
    }

    return chunks;
  }

  private triggerAmnesiaCycle() {
    this.newEntriesSinceLastDream = 0;
    // Use task service to schedule maintenance instead of running inline
    import('./taskService').then(({ taskService }) => {
      taskService.scheduleMaintenance().catch((e: unknown) =>
        logger.error('[VectorService] Maintenance scheduling failed', e)
      );
    }).catch((e: unknown) =>
      logger.error('[VectorService] Failed to import taskService', e)
    );
  }

  async updateEntry(id: string, updates: Partial<VectorMetadata>) {
    await this.memoryLoaded;
    await this.hnswReady;
    const entry = this.memoryById.get(id);
    if (!entry) return false;

    const oldText = entry.metadata.text || '';
    const textChanged = typeof updates.text === 'string' && updates.text !== oldText;

    // Only touch secondary indices; the HNSW entry stays valid unless the vector changes.
    this.removeFromSecondaryIndices(id);

    entry.metadata = {
      ...entry.metadata,
      ...updates
    };

    if (textChanged) {
      entry.vector = await this.getEmbedding(entry.metadata.text || '');
      if (this.hnswIndex && this.useHNSW) {
        this.hnswIndex.add(entry.id, entry.vector); // add() replaces the old label
      }
      this.bm25Index.addDocument({ id: entry.id, text: entry.metadata.text || '' });
    }

    this.addToIndices(entry);
    sqliteService.insertMemory(entry.id, entry.vector, entry.metadata);
    await this.saveMemory();
    return true;
  }

  /** Soft-deletes every active entry in a single SQLite transaction. */
  async deprecateAll(reason: string): Promise<number> {
    await this.memoryLoaded;
    const deprecatedAt = new Date().toISOString();
    const changed: VectorEntry[] = [];
    for (const entry of this.memory) {
      if (entry.metadata.status === 'deprecated') continue;
      entry.metadata = {
        ...entry.metadata,
        status: 'deprecated',
        deprecationReason: reason,
        deprecatedAt,
      };
      changed.push(entry);
    }
    if (changed.length > 0) {
      sqliteService.insertMemories(changed);
      logger.info(`[Gardening] Deprecated ${changed.length} entries. Reason: ${reason}`);
      await this.saveMemory();
    }
    return changed.length;
  }

  async deprecateEntry(id: string, reason: string) {
    await this.memoryLoaded;
    const entry = this.memoryById.get(id);
    if (!entry) return false;

    entry.metadata = {
      ...entry.metadata,
      status: 'deprecated',
      deprecationReason: reason,
      deprecatedAt: new Date().toISOString()
    };

    logger.info(`[Gardening] Deprecated entry ${id}. Reason: ${reason}`);
    sqliteService.insertMemory(entry.id, entry.vector, entry.metadata);
    await this.saveMemory();
    return true;
  }

  async searchFast(query: string, limit: number = 5): Promise<(VectorEntry & { score: number })[]> {
    await this.memoryLoaded;
    await this.hnswReady;
    if (!this.hnswIndex || !this.useHNSW) {
      return this.search(query, limit);
    }

    const queryVector = await this.getEmbedding(query);
    const results = this.hnswIndex.search(queryVector, limit * 2);

    // Map back to full entries and apply filters
    const entries: (VectorEntry & { score: number })[] = [];
    for (const { id, distance } of results) {
      const entry = this.memoryById.get(id);
      if (entry && entry.metadata.status !== 'deprecated') {
        entries.push({ ...entry, score: 1 - distance }); // Convert distance to similarity
      }
    }

    return entries.slice(0, limit);
  }

  private matchesSearchFilter(
    entry: VectorEntry,
    filter?: { type?: string, tier?: MemoryTier, tags?: string[], includeDeprecated?: boolean }
  ): boolean {
    if (!filter?.includeDeprecated && entry.metadata.status === 'deprecated') return false;
    if (!filter) return true;
    if (filter.type && entry.metadata.type !== filter.type) return false;
    if (filter.tier && entry.metadata.tier !== filter.tier) return false;
    if (filter.tags && filter.tags.length > 0) {
      const tags = entry.metadata.tags;
      if (!Array.isArray(tags) || !filter.tags.some(t => tags.includes(t))) return false;
    }
    return true;
  }

  async search(query: string, limit: number = 5, filter?: { type?: string, tier?: MemoryTier, tags?: string[], includeDeprecated?: boolean }) {
    const startTime = Date.now();

    try {
      await this.memoryLoaded;
      const queryVector = await this.getEmbedding(query);

      // Narrow via secondary indices where possible, then apply EVERY filter unconditionally.
      let pool: VectorEntry[];
      if (filter?.type) {
        const ids = this.typeIndex.get(filter.type);
        pool = ids ? this.memory.filter(m => ids.has(m.id)) : [];
      } else if (filter?.tags && filter.tags.length > 0) {
        const candidateIds = new Set<string>();
        for (const tag of filter.tags) {
          this.tagIndex.get(tag)?.forEach(id => candidateIds.add(id));
        }
        pool = this.memory.filter(m => candidateIds.has(m.id));
      } else {
        pool = this.memory;
      }
      const candidates = pool.filter(m => this.matchesSearchFilter(m, filter));
      if (candidates.length === 0) {
        memoryMetrics.recordRetrieval(Date.now() - startTime, 0, 0);
        return [];
      }
      const candidateIdSet = new Set(candidates.map(c => c.id));

      const DECAY_LAMBDA = 0.05; // Relevance halves every ~14 days
      const RRF_K = 60;
      const KEYWORD_BONUS = 0.1;

      // Semantic score stays on the cosine scale so downstream thresholds
      // (0.55 / 0.6 / 0.75 / 0.8) keep their meaning.
      const semanticScore = new Map<string, number>();
      const semanticResults = candidates.map(entry => {
        const similarity = this.cosineSimilarity(queryVector, entry.vector);
        const createdAt = new Date(entry.metadata.createdAt || Date.now());
        const ageInDays = Math.max(0, (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));
        const isAnchor = entry.metadata.isAnchor === true || entry.metadata.tier === 'meta-summary';
        const decay = isAnchor ? 1.0 : Math.exp(-DECAY_LAMBDA * ageInDays);
        const boost = isAnchor ? 0.3 : 0;
        const score = (similarity * decay) + boost;
        semanticScore.set(entry.id, score);
        return { id: entry.id, score };
      })
      .sort((a, b) => b.score - a.score);

      // BM25 restricted to the filtered candidate set (no deprecated / off-filter leaks)
      const bm25Results = this.bm25Index
        .search(query, Math.max(50, limit * 3))
        .filter(r => candidateIdSet.has(r.id));
      const bm25RankBonus = new Map<string, number>();
      bm25Results.forEach((r, rank) => {
        // Normalized to (0, KEYWORD_BONUS]: rank 0 -> full bonus
        bm25RankBonus.set(r.id, KEYWORD_BONUS * ((RRF_K + 1) / (RRF_K + rank + 1)));
      });

      // RRF decides WHICH entries make the cut; the reported score is cosine-scale + keyword bonus.
      const fusedResults = reciprocalRankFusion(semanticResults, bm25Results, RRF_K);

      const results: (VectorEntry & { score: number })[] = [];
      for (const { id } of fusedResults.slice(0, limit)) {
        const entry = this.memoryById.get(id);
        if (entry) {
          const score = (semanticScore.get(id) ?? 0) + (bm25RankBonus.get(id) ?? 0);
          results.push({ ...entry, score });
        }
      }

      // --- GRAPH-AUGMENTED RETRIEVAL (One-hop expansion, filter-respecting) ---
      const seen = new Set(results.map(r => r.id));
      const expandedResults = [...results];
      for (const entry of results) {
        if (!Array.isArray(entry.metadata.links)) continue;
        for (const link of entry.metadata.links) {
          const linkId = typeof link === 'string' ? link : link?.targetId;
          if (!linkId || seen.has(linkId)) continue;
          const targetEntry = this.memoryById.get(linkId);
          if (targetEntry && this.matchesSearchFilter(targetEntry, filter)) {
            seen.add(linkId);
            // Add with slightly lower score than its parent
            expandedResults.push({ ...targetEntry, score: entry.score * 0.8 });
          }
        }
      }

      const finalResults = expandedResults.sort((a, b) => b.score - a.score).slice(0, limit + 2); // Allow small over-retrieval for context

      const latency = Date.now() - startTime;
      memoryMetrics.recordRetrieval(latency, candidates.length, finalResults.length);

      return finalResults;
    } catch (error) {
      logger.error('Vector search failed', error);
      return [];
    }
  }

  async findRelated(id: string, limit: number = 3) {
    await this.memoryLoaded;
    const target = this.memoryById.get(id);
    if (!target) return [];

    return this.memory
      .filter(m => m.id !== id)
      .map(entry => ({
        ...entry,
        score: this.cosineSimilarity(target.vector, entry.vector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  getRecentEntries(limit: number = 50) {
    return this.memory.slice(-limit);
  }

  getEntriesByIds(ids: string[]) {
    const out: VectorEntry[] = [];
    for (const id of ids) {
      const entry = this.memoryById.get(id);
      if (entry) out.push(entry);
    }
    return out;
  }

  getMemoryInternal() {
    return this.memory;
  }

  private updateMetrics() {
    const byTier: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const entry of this.memory) {
      const tier = entry.metadata.tier || 'unknown';
      const type = entry.metadata.type || 'unknown';
      byTier[tier] = (byTier[tier] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;
    }

    memoryMetrics.updateMemoryStats(
      this.memory.length,
      config.MEMORY_MAX_ENTRIES,
      byTier,
      byType
    );
  }

  /**
   * Get total number of entries in memory (used by BM25 to detect changes).
   */
  getMemorySize(): number {
    return this.memory.length;
  }

  /**
   * Get all entries as id+text pairs (used to build BM25 index).
   */
  getAllTexts(): Array<{ id: string; text: string }> {
    return this.memory
      .filter(e => e.metadata.status !== 'deprecated' && e.metadata.text)
      .map(e => ({ id: e.id, text: e.metadata.text! }));
  }

  /**
   * Get a single entry by ID.
   */
  getEntryById(id: string): (VectorEntry & { score: number }) | null {
    const entry = this.memoryById.get(id);
    if (!entry || entry.metadata.status === 'deprecated') return null;
    return { ...entry, score: 0 };
  }

  /**
   * Record that entries were retrieved — increments retrievalCount for reinforcement.
   */
  async recordRetrieval(ids: string[]): Promise<void> {
    await this.memoryLoaded;
    let changed = false;
    for (const id of ids) {
      const entry = this.memoryById.get(id);
      if (entry) {
        entry.metadata.retrievalCount = Number(entry.metadata.retrievalCount || 0) + 1;
        sqliteService.insertMemory(entry.id, entry.vector, entry.metadata);
        changed = true;
      }
    }
    if (changed) {
      // Batch save — piggyback on periodic save cycle rather than saving every retrieval
      this.saveCounter++;
      if (this.saveCounter % 10 === 0) {
        await this.saveMemory();
      }
    }
  }

  private scheduleHnswSave() {
    if (this.hnswSaveTimer) return;
    this.hnswSaveTimer = setTimeout(() => {
      this.hnswSaveTimer = null;
      if (this.hnswIndex) {
        this.hnswIndex.save(this.hnswIndexPath).catch(e =>
          logger.error('[VectorService] HNSW save failed', e)
        );
      }
    }, this.HNSW_SAVE_DEBOUNCE_MS);
  }

  async shutdown() {
    if (this.hnswSaveTimer) {
      clearTimeout(this.hnswSaveTimer);
      this.hnswSaveTimer = null;
    }
    if (this.hnswIndex && this.useHNSW) {
      await this.hnswIndex.save(this.hnswIndexPath);
    }
  }

  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i] ?? 0;
      const b = vecB[i] ?? 0;
      dotProduct += a * b;
      magA += a * a;
      magB += b * b;
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom === 0) return 0;
    return dotProduct / denom;
  }
}

export const vectorService = new VectorService();
