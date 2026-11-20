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

  const mk = (id: string, updatedAt: number, mode = 'chat', content: unknown = `hello ${id}`) => ({
    id,
    mode,
    title: `Title ${id}`,
    messages: [{ id: `${id}-m1`, role: 'user' as const, content: content as string, image: 'data:image/png;base64,AAAA', timestamp: 1 }],
    createdAt: 1,
    updatedAt,
    metadata: { modelsUsed: [], messageCount: 1, tokenEstimate: 0, tags: [] },
  });

  it('keeps message bodies and images out of index.json', async () => {
    const service = new ConversationStorageService({ baseDir: testSessionDir });
    await service.saveSession(mk('slim', 10));
    const index = JSON.parse(await fs.readFile(path.join(testSessionDir, 'index.json'), 'utf-8'));
    expect(index[0].messages).toBeUndefined();
    expect(JSON.stringify(index)).not.toContain('base64');
    expect(index[0].metadata.messageCount).toBe(1);
    expect(index[0].preview).toBe('hello slim');
  });

  it('reads an old-format index that still embeds messages', async () => {
    await fs.mkdir(testSessionDir, { recursive: true });
    await fs.writeFile(path.join(testSessionDir, 'index.json'), JSON.stringify([mk('old', 5)]));
    const service = new ConversationStorageService({ baseDir: testSessionDir });
    const list = await service.listSessions();
    expect(list).toHaveLength(1);
    expect((list[0] as unknown as { messages?: unknown }).messages).toBeUndefined();
  });

  it('does not lose index entries under concurrent saves', async () => {
    const service = new ConversationStorageService({ baseDir: testSessionDir });
    await Promise.all(Array.from({ length: 15 }, (_, i) => service.saveSession(mk(`c${i}`, i + 1))));
    expect(await service.listSessions()).toHaveLength(15);
  });

  it('sorts newest-first even when filtering by mode', async () => {
    const service = new ConversationStorageService({ baseDir: testSessionDir });
    await service.saveSession(mk('a', 1, 'coding'));
    await service.saveSession(mk('b', 3, 'coding'));
    await service.saveSession(mk('c', 2, 'coding'));
    expect((await service.listSessions('coding')).map(s => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('overwrites a corrupt existing session file instead of failing forever', async () => {
    await fs.mkdir(testSessionDir, { recursive: true });
    await fs.writeFile(path.join(testSessionDir, 'broken.json'), '{not json');
    const service = new ConversationStorageService({ baseDir: testSessionDir });
    await service.saveSession(mk('broken', 1));
    expect((await service.loadSession('broken'))?.title).toBe('Title broken');
  });

  it('search skips non-string message content and finds matches from session files', async () => {
    const service = new ConversationStorageService({ baseDir: testSessionDir });
    await service.saveSession(mk('weird', 1, 'chat', { parts: ['x'] }));
    await service.saveSession(mk('match', 2, 'chat', 'the needle is here'));
    const results = await service.searchSessions('needle');
    expect(results).toHaveLength(1);
    expect(results[0]!.session.id).toBe('match');
    expect(results[0]!.match.content).toContain('needle');
  });
});
