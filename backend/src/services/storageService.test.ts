import { describe, it, expect, beforeEach } from 'vitest';
import { StorageService } from './storageService';

describe('StorageService', () => {
  let storage: StorageService;

  beforeEach(() => {
    storage = new StorageService(); // Defaults to memory
  });

  it('should set and get values with TTL', async () => {
    await storage.set('test-key', { foo: 'bar' }, 1); // 1 sec TTL
    const val = await storage.get<{foo: string}>('test-key');
    expect(val?.foo).toBe('bar');
  });

  it('should increment counters', async () => {
    await storage.incr('counter');
    const val = await storage.incr('counter');
    expect(val).toBe(2);
  });
});
describe('StorageService TTL handling', () => {
  it('incr preserves the remaining TTL instead of making the key permanent', async () => {
    const storage = new StorageService();
    await storage.set('win', 1, 1); // 1s window
    expect(await storage.incr('win')).toBe(2);
    const entry = (storage as unknown as { memory: Map<string, { exp: number }> }).memory.get('win');
    expect(entry!.exp).toBeGreaterThan(0);
  });

  it('incr restarts from 0 once the key has expired', async () => {
    const storage = new StorageService();
    await storage.set('gone', 5, 1);
    (storage as unknown as { memory: Map<string, { val: unknown; exp: number }> }).memory.set('gone', { val: 5, exp: Date.now() - 1 });
    expect(await storage.incr('gone')).toBe(1);
  });
});
