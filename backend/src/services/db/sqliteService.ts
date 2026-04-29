import Database from 'better-sqlite3';
import path from 'path';
import { logger } from '../../utils/logger';

class SqliteService {
  public db: Database.Database;

  constructor() {
    const dbPath = path.resolve(__dirname, '../../../../.solvent_memory.sqlite');
    this.db = new Database(dbPath);
    this.initSchema();
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
      logger.info('[SqliteService] Schema initialized successfully.');
    } catch (error) {
      logger.error('[SqliteService] Failed to initialize schema', error);
      throw error;
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
}

export const sqliteService = new SqliteService();
