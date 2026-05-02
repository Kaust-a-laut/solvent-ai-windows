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
    service.insertMemory('fresh-1', [0.1, 0.2], { type: 'test', tags: ['fresh'] });
    expect(service.getMemory('fresh-1')).toMatchObject({
      id: 'fresh-1',
      vector: [0.1, 0.2],
      metadata: { type: 'test', tags: ['fresh'] },
    });
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
