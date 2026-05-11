import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import Database from 'better-sqlite3';
import { SqliteService } from './sqliteService';

const dbPath = path.resolve(process.cwd(), '.vitest-tmp/sqlite-service-test.sqlite');

describe('SqliteService schema migration', () => {
  beforeEach(async () => {
    await fs.rm(dbPath, { force: true });
  });
  afterEach(async () => {
    await fs.rm(dbPath, { force: true });
  });

  it('creates a fresh schema and stores memory', () => {
    const service = new SqliteService(dbPath);
    // Float32-exact values so the BLOB round-trip is bitwise identical.
    service.insertMemory('fresh-1', [0.5, 0.25], { type: 'test', tags: ['fresh'] });
    expect(service.getMemory('fresh-1')).toMatchObject({
      id: 'fresh-1',
      vector: [0.5, 0.25],
      metadata: { type: 'test', tags: ['fresh'] },
    });
    service.db.close();
  });

  it('stores vectors as BLOB and round-trips through Float32', () => {
    const service = new SqliteService(dbPath);
    const vec = [0.5, 0.25, -0.125, 0]; // f32-exact
    service.insertMemory('blob-1', vec, { type: 'blob' });

    // Read raw row — vector_blob must be populated, vector TEXT must be the
    // placeholder. This pins the on-disk layout, not just the public API.
    const raw = service.db
      .prepare(`SELECT vector, vector_blob FROM memory_entries WHERE id = ?`)
      .get('blob-1') as { vector: string; vector_blob: Buffer | null };
    expect(raw.vector).toBe('[]');
    expect(raw.vector_blob).toBeInstanceOf(Buffer);
    expect(raw.vector_blob!.byteLength).toBe(vec.length * 4);

    expect(service.getMemory('blob-1')?.vector).toEqual(vec);
    service.db.close();
  });

  it('falls back to JSON vector for legacy rows with NULL vector_blob', () => {
    // Build a row that looks like a pre-V2 write: vector TEXT populated, blob null.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        vector TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        type TEXT,
        tags TEXT,
        created_at DATETIME
      );
      INSERT INTO memory_entries (id, vector, metadata) VALUES ('legacy-blob', '[0.5,0.25]', '{"type":"legacy"}');
    `);
    db.close();

    const service = new SqliteService(dbPath);
    // Migration adds vector_blob column; existing row should still decode.
    expect(service.getMemory('legacy-blob')).toMatchObject({
      id: 'legacy-blob',
      vector: [0.5, 0.25],
      metadata: { type: 'legacy' },
    });

    // After updating, the same row should re-emit as BLOB.
    service.insertMemory('legacy-blob', [0.75, -0.5], { type: 'legacy', tags: ['migrated'] });
    const raw = service.db
      .prepare(`SELECT vector, vector_blob FROM memory_entries WHERE id = ?`)
      .get('legacy-blob') as { vector: string; vector_blob: Buffer | null };
    expect(raw.vector).toBe('[]');
    expect(raw.vector_blob).toBeInstanceOf(Buffer);
    expect(service.getMemory('legacy-blob')?.vector).toEqual([0.75, -0.5]);
    service.db.close();
  });

  it('getAllMemoriesAsync decodes a mixed store (BLOB + legacy TEXT)', async () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        vector TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        type TEXT,
        tags TEXT,
        created_at DATETIME
      );
      INSERT INTO memory_entries (id, vector, metadata) VALUES ('legacy', '[0.5,0.25]', '{}');
    `);
    db.close();

    const service = new SqliteService(dbPath);
    service.insertMemory('modern', [0.125, -0.0625], {});

    const all = await service.getAllMemoriesAsync();
    const byId = new Map(all.map(e => [e.id, e.vector]));
    expect(byId.get('legacy')).toEqual([0.5, 0.25]);
    expect(byId.get('modern')).toEqual([0.125, -0.0625]);
    service.db.close();
  });

  it('adds missing columns to legacy tables without dropping data', () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY
      );
      INSERT INTO memory_entries (id) VALUES ('legacy-1');
    `);
    db.close();

    const service = new SqliteService(dbPath);
    service.insertMemory('legacy-2', [1], { type: 'migrated' });
    expect(service.getMemory('legacy-2')?.metadata).toMatchObject({ type: 'migrated' });
    expect(service.getMemory('legacy-1')).toMatchObject({ id: 'legacy-1', vector: [], metadata: {} });
    service.db.close();
  });

  it('refuses to start when an incompatible NOT NULL column without default is present', () => {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE memory_entries (
        id TEXT PRIMARY KEY,
        vector TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        legacy_required TEXT NOT NULL
      );
    `);
    db.close();

    expect(() => new SqliteService(dbPath)).toThrow(/legacy_required/);
  });
});
