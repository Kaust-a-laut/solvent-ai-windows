import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConversationStorageService } from './conversationStorageService';
import fs from 'fs/promises';
import path from 'path';

describe('ConversationStorageService', () => {
  const testSessionDir = path.join(__dirname, '../../../.vitest-tmp/conversation-storage');

  beforeEach(async () => {
    await fs.rm(testSessionDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(testSessionDir, { recursive: true, force: true });
  });

  it('should reject stale session updates', async () => {
    const service = new ConversationStorageService({ baseDir: testSessionDir });

    const session1 = {
      id: 'test-1',
      mode: 'chat',
      title: 'Test',
      messages: [],
      createdAt: Date.now(),
      updatedAt: 1000,
      metadata: { modelsUsed: [], messageCount: 0, tokenEstimate: 0, tags: [] }
    };

    const session2 = { ...session1, updatedAt: 2000, messages: [{ id: '1', role: 'user' as const, content: 'new', timestamp: Date.now() }] };
    const staleSession = { ...session1, updatedAt: 500, messages: [{ id: '1', role: 'user' as const, content: 'old', timestamp: Date.now() }] };

    await service.saveSession(session2);
    await service.saveSession(staleSession);

    const loaded = await service.loadSession('test-1');
    expect(loaded?.messages).toHaveLength(1);
    expect(loaded?.messages[0]!.content).toBe('new');
  });

  it('writes nothing under the default sessions dir when baseDir is provided', async () => {
    const defaultDir = path.resolve(__dirname, '../../../.solvent_sessions');
    const beforeEntries = await fs.readdir(defaultDir).catch(() => [] as string[]);

    const service = new ConversationStorageService({ baseDir: testSessionDir });
    await service.saveSession({
      id: 'isolated-1',
      mode: 'chat',
      title: 'isolated',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: { modelsUsed: [], messageCount: 0, tokenEstimate: 0, tags: [] },
    });

    const afterEntries = await fs.readdir(defaultDir).catch(() => [] as string[]);
    expect(afterEntries).toEqual(beforeEntries);
  });
});
