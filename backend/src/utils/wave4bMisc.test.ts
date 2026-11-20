import { describe, it, expect } from 'vitest';
import { extractImageFromDataUrl } from './messageUtils';
import { getModelContextLimit } from '../constants/models';
import { PreviewStashStore } from '../services/previewStashStore';
import { FileService } from '../services/fileService';
import { CoreMemory } from '../services/coreMemory';
import path from 'path';
import os from 'os';

describe('extractImageFromDataUrl', () => {
  it('splits on the first ;base64, and strips whitespace in the payload', () => {
    expect(extractImageFromDataUrl('data:image/png;base64,AAA\nBBB\r\nCCC')).toEqual({ mimeType: 'image/png', data: 'AAABBBCCC' });
  });
  it('rejects non data URLs', () => {
    expect(extractImageFromDataUrl('https://x/y.png')).toBeNull();
    expect(extractImageFromDataUrl('data:;base64,AAA')).toBeNull();
  });
});

describe('getModelContextLimit', () => {
  it('ignores inherited Object.prototype keys', () => {
    expect(typeof getModelContextLimit('constructor')).toBe('number');
    expect(getModelContextLimit('toString')).toBe(getModelContextLimit(''));
  });
  it('strips :free / :cloud suffixes before lookup', () => {
    expect(getModelContextLimit('qwen3.6-plus:free')).toBe(getModelContextLimit('qwen3.6-plus'));
  });
  it('knows newer families', () => {
    expect(getModelContextLimit('anthropic/claude-sonnet-4.5')).toBe(200_000);
    expect(getModelContextLimit('meta-llama/llama-4-maverick')).toBe(131_072);
    expect(getModelContextLimit('some-host/kimi-k3')).toBe(262_144);
  });
});

describe('PreviewStashStore', () => {
  it('caps the number of sessions, evicting the oldest', () => {
    const store = new PreviewStashStore(60_000, 60_000, 3);
    const stash = { entries: [], bodyHTML: null, bodyHash: null, updatedAt: 0 };
    for (const id of ['a', 'b', 'c', 'd']) store.set(id, stash);
    expect(store.get('a')).toBeNull();
    expect(store.get('d')).not.toBeNull();
    store.destroy();
  });
});

describe('FileService.validateFileName', () => {
  const svc = new FileService();
  const validate = (n: string) => (svc as unknown as { validateFileName(n: string): string }).validateFileName(n);
  it.each(['../x', '..', '.', 'a/b.png', 'a\\b.png', '/etc/passwd'])('rejects %s', (name) => {
    expect(() => validate(name)).toThrow(/Invalid filename/);
  });
  it('keeps valid names verbatim (no character mangling)', () => {
    expect(path.basename(validate('my photo (1).png'))).toBe('my photo (1).png');
  });
});

describe('CoreMemory key limits', () => {
  it('does not let prototype keys bypass the length limit', () => {
    const mem = new CoreMemory(path.join(os.tmpdir(), `core-${Date.now()}.json`), 50, { default: 10 });
    expect(() => mem.set('constructor', 'x'.repeat(50))).toThrow(/exceeds max length/);
  });
});
