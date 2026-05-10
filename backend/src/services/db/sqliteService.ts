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

    const expected = new Set(['id', 'vector', 'metadata', 'type', 'tags', 'created_at']);
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
    ];

    for (const [column, sql] of migrations) {
      if (!names.has(column)) {
        this.db.exec(sql);
      }
    }
  }

  public insertMemory(id: string, vector: number[], metadata: unknown) {
    const transaction = this.db.transaction(() => {
      const metadataStr = JSON.stringify(metadata);
      const vectorStr = JSON.stringify(vector);
      const meta = metadata as any;
      const type = meta.type || '';
      const tags = JSON.stringify(meta.tags || []);
      
      const insertEntry = this.db.prepare(`
        INSERT INTO memory_entries (id, vector, metadata, type, tags)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          vector = excluded.vector,
          metadata = excluded.metadata,
          type = excluded.type,
          tags = excluded.tags
      `);
      
      insertEntry.run(id, vectorStr, metadataStr, type, tags);
    });
    
    transaction();
  }

  public deleteMemory(id: string) {
    this.db.prepare(`DELETE FROM memory_entries WHERE id = ?`).run(id);
  }

  public getMemory(id: string) {
    const row = this.db.prepare(`SELECT * FROM memory_entries WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      vector: JSON.parse(row.vector),
      metadata: JSON.parse(row.metadata)
    };
  }

  public getAllMemories() {
    const stmt = this.db.prepare(`SELECT id, vector, metadata FROM memory_entries`);
    const results = stmt.all() as any[];
    return results.map(r => ({
      id: r.id,
      vector: JSON.parse(r.vector),
      metadata: JSON.parse(r.metadata)
    }));
  }

  /**
   * Async variant that yields to the event loop every {@link chunkSize} rows
   * during JSON parsing. With ~10k entries the synchronous variant blocks for
   * hundreds of ms during startup; this version keeps the loop responsive at
   * the cost of a few extra microtask hops.
   *
   * Uses `iterate()` so we never materialize the full row set into memory at
   * once — relevant when memory_entries grows past ~50k.
   */
  public async getAllMemoriesAsync(chunkSize: number = 500): Promise<Array<{ id: string; vector: number[]; metadata: unknown }>> {
    const stmt = this.db.prepare(`SELECT id, vector, metadata FROM memory_entries`);
    const out: Array<{ id: string; vector: number[]; metadata: unknown }> = [];
    let i = 0;
    for (const row of stmt.iterate() as IterableIterator<{ id: string; vector: string; metadata: string }>) {
      out.push({
        id: row.id,
        vector: JSON.parse(row.vector),
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
