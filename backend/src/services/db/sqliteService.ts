import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export class SqliteMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqliteMigrationError';
  }
}

export class SqliteService {
  public db: Database.Database;

  private insertMemoryStmt!: Database.Statement;
  private upsertEmbeddingStmt!: Database.Statement;
  private deleteMemoryStmt!: Database.Statement;
  private deleteEmbeddingStmt!: Database.Statement;

  constructor(dbPath = config.SOLVENT_SQLITE_PATH || path.resolve(__dirname, '../../../../.solvent_memory.sqlite')) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    try {
      // WAL: readers don't block the writer and fsyncs batch up.
      // synchronous=NORMAL is the recommended WAL pairing — an OS crash can
      // lose the last transactions but cannot corrupt the database.
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.initSchema();
      this.prepareStatements();
    } catch (error) {
      // Release the file handle so callers can retry, inspect, or delete the
      // db file. Without this, the constructor throws but better-sqlite3
      // keeps the handle open and the file stays locked.
      try { this.db.close(); } catch { /* ignore */ }
      throw error;
    }
  }

  private initSchema() {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_entries (
          id TEXT PRIMARY KEY,
          vector TEXT NOT NULL,
          metadata TEXT NOT NULL,
          type TEXT,
          tags TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      this.migrateMemoryEntries();
      // Indices on the columns vectorService filters/sorts by. Cheap to create
      // and IF NOT EXISTS makes the call idempotent across migrations.
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_entries_type ON memory_entries(type)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_entries_created_at ON memory_entries(created_at)`);
      // V4: embedding cache, replacing the legacy .solvent_embedding_cache.json
      // full-file rewrite with per-row upserts.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS embedding_cache (
          text_key TEXT PRIMARY KEY,
          vector BLOB NOT NULL,
          last_access INTEGER NOT NULL
        );
      `);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_access ON embedding_cache(last_access)`);
      logger.info('[SqliteService] Schema initialized successfully.');
    } catch (error) {
      logger.error('[SqliteService] Failed to initialize schema', error);
      throw error;
    }
  }

  private migrateMemoryEntries() {
    interface ColumnInfo {
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }
    const columns = this.db.prepare(`PRAGMA table_info(memory_entries)`).all() as ColumnInfo[];
    const names = new Set(columns.map(column => column.name));
    if (!names.has('id')) {
      throw new SqliteMigrationError('memory_entries table is missing required id column');
    }

    const expected = new Set(['id', 'vector', 'vector_blob', 'metadata', 'type', 'tags', 'created_at']);
    const blockingExtras = columns.filter(col =>
      !expected.has(col.name) && col.notnull === 1 && col.dflt_value === null && col.pk === 0
    );
    if (blockingExtras.length > 0) {
      const names = blockingExtras.map(col => col.name).join(', ');
      throw new SqliteMigrationError(
        `memory_entries has incompatible NOT NULL column(s) without defaults: ${names}. ` +
        `insertMemory does not populate these and runtime inserts would fail. ` +
        `Migrate or drop the column manually before restarting.`
      );
    }

    const migrations: Array<[string, string]> = [
      ['vector', `ALTER TABLE memory_entries ADD COLUMN vector TEXT NOT NULL DEFAULT '[]'`],
      ['metadata', `ALTER TABLE memory_entries ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`],
      ['type', `ALTER TABLE memory_entries ADD COLUMN type TEXT`],
      ['tags', `ALTER TABLE memory_entries ADD COLUMN tags TEXT`],
      ['created_at', `ALTER TABLE memory_entries ADD COLUMN created_at DATETIME`],
      // V2: binary vector column. New rows write only here; legacy rows keep
      // their JSON in `vector` and are re-emitted as BLOB the next time they
      // are touched (recordRetrieval / updateEntry / deprecateEntry / addLinks).
      ['vector_blob', `ALTER TABLE memory_entries ADD COLUMN vector_blob BLOB`],
    ];

    for (const [column, sql] of migrations) {
      if (names.has(column)) continue;
      try {
        this.db.exec(sql);
      } catch (err) {
        // Concurrent SqliteService instances (e.g. vitest worker pool) can
        // race here: both see the column missing in PRAGMA, both try to ALTER.
        // SQLite has no `ALTER TABLE … IF NOT EXISTS`, so swallow the
        // duplicate-column error and trust that the other writer succeeded.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    }
  }

  // Safely decode a Float32 BLOB into number[], copying into an aligned
  // ArrayBuffer whenever Node's slab-pooled Buffer has byteOffset % 4 !== 0.
  private decodeFloat32Blob(blob: Buffer): number[] {
    if (blob.byteLength === 0) return [];
    if (blob.byteLength % 4 !== 0) {
      throw new Error(`Invalid float32 vector BLOB byteLength: ${blob.byteLength}`);
    }
    if (blob.byteOffset % 4 === 0) {
      const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      return Array.from(f32);
    }
    const aligned = new ArrayBuffer(blob.byteLength);
    new Uint8Array(aligned).set(blob);
    return Array.from(new Float32Array(aligned));
  }

  // Prefer the BLOB column when present; fall back to JSON for legacy rows
  // written before V2.
  private decodeVector(row: { vector: string; vector_blob: Buffer | null }): number[] {
    const blob = row.vector_blob;
    if (blob && blob.byteLength > 0) {
      return this.decodeFloat32Blob(blob);
    }
    return JSON.parse(row.vector) as number[];
  }

  private encodeVector(vector: number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  // Statements are prepared once (SQL parse is the dominant cost of these
  // hot-path calls). Must run after initSchema so the tables exist.
  private prepareStatements() {
    this.insertMemoryStmt = this.db.prepare(`
      INSERT INTO memory_entries (id, vector, vector_blob, metadata, type, tags)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        vector = excluded.vector,
        vector_blob = excluded.vector_blob,
        metadata = excluded.metadata,
        type = excluded.type,
        tags = excluded.tags
    `);
    this.upsertEmbeddingStmt = this.db.prepare(`
      INSERT INTO embedding_cache (text_key, vector, last_access)
      VALUES (?, ?, ?)
      ON CONFLICT(text_key) DO UPDATE SET
        vector = excluded.vector,
        last_access = excluded.last_access
    `);
    this.deleteMemoryStmt = this.db.prepare(`DELETE FROM memory_entries WHERE id = ?`);
    this.deleteEmbeddingStmt = this.db.prepare(`DELETE FROM embedding_cache WHERE text_key = ?`);
  }

  public insertMemory(id: string, vector: number[], metadata: unknown) {
    const metadataStr = JSON.stringify(metadata);
    const meta = metadata as Record<string, unknown>;
    const type = typeof meta?.type === 'string' ? meta.type : '';
    const tags = JSON.stringify(Array.isArray(meta?.tags) ? meta.tags : []);
    const vectorBlob = this.encodeVector(vector);

    // `vector` TEXT column still satisfies its NOT NULL constraint with a
    // placeholder. Future cleanup phase can drop the column once all
    // legacy rows have been re-written through this path. A single statement
    // runs in its own implicit transaction — no explicit wrapper needed.
    this.insertMemoryStmt.run(id, '[]', vectorBlob, metadataStr, type, tags);
  }

  public insertMemories(entries: Array<{ id: string; vector: number[]; metadata: unknown }>): void {
    if (entries.length === 0) return;
    const tx = this.db.transaction((rows: Array<{ id: string; vector: number[]; metadata: unknown }>) => {
      for (const r of rows) {
        const meta = r.metadata as Record<string, unknown>;
        const type = typeof meta?.type === 'string' ? meta.type : '';
        const tags = JSON.stringify(Array.isArray(meta?.tags) ? meta.tags : []);
        this.insertMemoryStmt.run(r.id, '[]', this.encodeVector(r.vector), JSON.stringify(r.metadata), type, tags);
      }
    });
    tx(entries);
  }

  public deleteMemory(id: string) {
    this.deleteMemoryStmt.run(id);
  }

  public getMemory(id: string) {
    const row = this.db.prepare(`SELECT id, vector, vector_blob, metadata FROM memory_entries WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      vector: this.decodeVector(row),
      metadata: JSON.parse(row.metadata)
    };
  }

  public getAllMemories() {
    const stmt = this.db.prepare(`SELECT id, vector, vector_blob, metadata FROM memory_entries`);
    const results = stmt.all() as any[];
    return results.map(r => ({
      id: r.id,
      vector: this.decodeVector(r),
      metadata: JSON.parse(r.metadata)
    }));
  }

  /**
   * Async variant that yields to the event loop every {@link chunkSize} rows
   * during decoding. With ~10k entries the synchronous variant blocks for
   * hundreds of ms during startup; this version keeps the loop responsive at
   * the cost of a few extra microtask hops.
   *
   * Uses `iterate()` so we never materialize the full row set into memory at
   * once — relevant when memory_entries grows past ~50k.
   *
   * Decoding prefers the BLOB column; legacy JSON `vector` is the fallback.
   */
  // --- embedding_cache (V4) ---

  public upsertEmbedding(text: string, vector: number[], lastAccess: number): void {
    this.upsertEmbeddingStmt.run(text, this.encodeVector(vector), lastAccess);
  }

  // Batch variant — wraps a single transaction around N upserts. Use this for
  // the persist cycle so we don't pay N fsyncs.
  public upsertEmbeddings(entries: Array<{ text: string; vector: number[]; lastAccess: number }>): void {
    if (entries.length === 0) return;
    const tx = this.db.transaction((rows: Array<{ text: string; vector: number[]; lastAccess: number }>) => {
      for (const r of rows) this.upsertEmbeddingStmt.run(r.text, this.encodeVector(r.vector), r.lastAccess);
    });
    tx(entries);
  }

  public deleteEmbedding(text: string): void {
    this.deleteEmbeddingStmt.run(text);
  }

  public countEmbeddings(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as c FROM embedding_cache`).get() as { c: number };
    return row.c;
  }

  // Async chunked load via keyset pagination (rowid) so each SQLite statement
  // completes and closes its cursor BEFORE yielding via setImmediate — never
  // leaving the better-sqlite3 connection busy across event-loop ticks.
  public async getAllEmbeddingsAsync(chunkSize: number = 500): Promise<Array<{ text: string; vector: number[]; lastAccess: number }>> {
    const stmt = this.db.prepare(
      `SELECT rowid, text_key, vector, last_access FROM embedding_cache WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`
    );
    const out: Array<{ text: string; vector: number[]; lastAccess: number }> = [];
    const batchSize = Math.max(1, Math.floor(chunkSize));
    let lastRowId = 0;

    for (;;) {
      const rows = stmt.all(lastRowId, batchSize) as Array<{
        rowid: number;
        text_key: string;
        vector: Buffer;
        last_access: number;
      }>;
      if (rows.length === 0) break;

      for (const row of rows) {
        out.push({
          text: row.text_key,
          vector: this.decodeFloat32Blob(row.vector),
          lastAccess: row.last_access,
        });
        lastRowId = row.rowid;
      }

      if (rows.length < batchSize) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return out;
  }

  // --- memory_entries async loader ---

  public async getAllMemoriesAsync(chunkSize: number = 500): Promise<Array<{ id: string; vector: number[]; metadata: unknown }>> {
    const stmt = this.db.prepare(
      `SELECT rowid, id, vector, vector_blob, metadata FROM memory_entries WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`
    );
    const out: Array<{ id: string; vector: number[]; metadata: unknown }> = [];
    const batchSize = Math.max(1, Math.floor(chunkSize));
    let lastRowId = 0;

    for (;;) {
      const rows = stmt.all(lastRowId, batchSize) as Array<{
        rowid: number;
        id: string;
        vector: string;
        vector_blob: Buffer | null;
        metadata: string;
      }>;
      if (rows.length === 0) break;

      for (const row of rows) {
        out.push({
          id: row.id,
          vector: this.decodeVector(row),
          metadata: JSON.parse(row.metadata),
        });
        lastRowId = row.rowid;
      }

      if (rows.length < batchSize) break;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    return out;
  }
}

export const sqliteService = new SqliteService();
