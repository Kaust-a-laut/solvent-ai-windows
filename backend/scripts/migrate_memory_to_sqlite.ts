import fs from 'fs';
import path from 'path';
import { sqliteService } from '../src/services/db/sqliteService';

async function migrate() {
  const jsonPath = path.resolve(__dirname, '../../../.solvent_memory.json');
  if (!fs.existsSync(jsonPath)) {
    console.log('No .solvent_memory.json found, skipping migration.');
    return;
  }

  const raw = fs.readFileSync(jsonPath, 'utf8');
  const memory = JSON.parse(raw);

  console.log(`Migrating ${memory.length} entries...`);

  let count = 0;
  for (const entry of memory) {
    if (entry.id && entry.vector && entry.metadata) {
      try {
        sqliteService.insertMemory(entry.id, entry.vector, entry.metadata);
        count++;
      } catch (e) {
        console.error(`Failed to migrate entry ${entry.id}`, e);
      }
    }
  }

  console.log(`Migrated ${count} entries to SQLite.`);
}

migrate().catch(console.error);
