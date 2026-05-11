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

  constructor(dbPath = config.SOLVENT_SQLITE_PATH || path.resolve(__dirname, '../../../../.solvent_memory.sqlite')) {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new Database(dbPath);
    try {
      this.initSchema();
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

  // Prefer the BLOB column when present; fall back to JSON for legacy rows
  // written before V2. Float32Array view wraps the Buffer in place, then
  // Array.from copies into a plain number[] so the slice doesn't outlive the
  // backing Buffer that better-sqlite3 hands us.
  private decodeVector(row: { vector: string; vector_blob: Buffer | null }): number[] {
    const blob = row.vector_blob;
    if (blob && blob.byteLength > 0) {
      const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
      return Array.from(f32);
    }
    return JSON.parse(row.vector) as number[];
  }

  private encodeVector(vector: number[]): Buffer {
    return Buffer.from(new Float32Array(vector).buffer);
  }

  public insertMemory(id: string, vector: number[], metadata: unknown) {
    const transaction = this.db.transaction(() => {
      const metadataStr = JSON.stringify(metadata);
      const meta = metadata as any;
      const type = meta.type || '';
      const tags = JSON.stringify(meta.tags || []);
      const vectorBlob = this.encodeVector(vector);

      // `vector` TEXT column still satisfies its NOT NULL constraint with a
      // placeholder. Future cleanup phase can drop the column once all
      // legacy rows have been re-written through this path.
      const insertEntry = this.db.prepare(`
        INSERT INTO memory_entries (id, vector, vector_blob, metadata, type, tags)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          vector = excluded.vector,
          vector_blob = excluded.vector_blob,
          metadata = excluded.metadata,
          type = excluded.type,
          tags = excluded.tags
      `);

      insertEntry.run(id, '[]', vectorBlob, metadataStr, type, tags);
    });

    transaction();
  }

  public deleteMemory(id: string) {
    this.db.prepare(`DELETE FROM memory_entries WHERE id = ?`).run(id);
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
  public async getAllMemoriesAsync(chunkSize: number = 500): Promise<Array<{ id: string; vector: number[]; metadata: unknown }>> {
    const stmt = this.db.prepare(`SELECT id, vector, vector_blob, metadata FROM memory_entries`);
    const out: Array<{ id: string; vector: number[]; metadata: unknown }> = [];
    let i = 0;
    for (const row of stmt.iterate() as IterableIterator<{ id: string; vector: string; vector_blob: Buffer | null; metadata: string }>) {
      out.push({
        id: row.id,
        vector: this.decodeVector(row),
        metadata: JSON.parse(row.metadata),
      });
      if (++i % chunkSize === 0) {
        // Yield to other I/O / timers — event loop stays responsive even on
        // large stores.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    return out;
  }
}

export const sqliteService = new SqliteService();
