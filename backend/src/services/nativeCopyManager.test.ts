import { describe, it, expect } from 'vitest';
import { nativeCopyManager, findListeningPids } from './nativeCopyManager';

describe('nativeCopyManager', () => {
  it.each([0, 80, 70000, 3002.5, NaN, '3002 & calc' as unknown as number])(
    'rejects invalid port %s before doing anything',
    async (port) => {
      await expect(nativeCopyManager.start('projects/does-not-exist', port)).rejects.toThrow(/Invalid port/);
      await expect(nativeCopyManager.forceReclaimPort(port)).rejects.toThrow(/Invalid port/);
      await expect(findListeningPids(port)).rejects.toThrow(/Invalid port/);
    }
  );

  it('serializes concurrent start() calls', async () => {
    const first = nativeCopyManager.start('projects/__no_such_sidecar__', 3002);
    const second = nativeCopyManager.start('projects/__no_such_sidecar__', 3002);
    await expect(second).rejects.toThrow(/already in progress/);
    await expect(first).rejects.toThrow(/Backend directory missing/);
  });

  it('refuses project paths that escape the workspace', async () => {
    await expect(nativeCopyManager.start('../outside', 3002)).rejects.toThrow(/escapes workspace/);
  });
});
