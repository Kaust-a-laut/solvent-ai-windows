import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/cypress/**', '**/.{idea,git,cache,output,temp}/**'],
    // The runShell `find` test legitimately walks the repo tree and routinely
    // takes 5–6 s on a cold filesystem cache. Default 5 s flakes on CI runners.
    testTimeout: 15_000,
    env: {
      BACKEND_INTERNAL_SECRET: 'test_secret_key_for_testing_purposes_only_1234567890',
      SOLVENT_SQLITE_PATH: './.vitest-tmp/solvent_memory.sqlite',
      SOLVENT_VECTOR_MEMORY_PATH: './.vitest-tmp/solvent_memory.json',
      SOLVENT_EMBEDDING_CACHE_PATH: './.vitest-tmp/solvent_embedding_cache.json',
      SOLVENT_HNSW_PATH: './.vitest-tmp/solvent_hnsw.bin',
      SOLVENT_BACKUP_DIR: './.vitest-tmp/backups',
      SOLVENT_ENABLE_HTTP_SHELL: 'false',
      // Matches the shipped .env default; the approval-gate tests flip it off.
      AUTO_APPROVE: 'true'
    }
  },
});
