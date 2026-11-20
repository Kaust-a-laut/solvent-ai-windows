import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { JsonlAppender, rotatedPath } from './jsonlAppender';
import { redactSecretStrings, safeForAudit } from './redaction';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jsonl-appender-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('JsonlAppender', () => {
  it('keeps every line across rotations under concurrent appends', async () => {
    const file = path.join(dir, 'log.jsonl');
    const appender = new JsonlAppender(file, { maxBytes: 200, keep: 50 });
    await Promise.all(Array.from({ length: 60 }, (_, i) => appender.append(JSON.stringify({ i, pad: 'x'.repeat(20) }))));

    const files = [file, ...Array.from({ length: 50 }, (_, g) => rotatedPath(file, g + 1))];
    const seen: number[] = [];
    for (const f of files) {
      const content = await fs.readFile(f, 'utf-8').catch(() => '');
      for (const line of content.split('\n').filter(Boolean)) seen.push((JSON.parse(line) as { i: number }).i);
    }
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 60 }, (_, i) => i));
    expect((await fs.stat(rotatedPath(file, 1))).size).toBeGreaterThan(0);
  });

  it('drops generations beyond `keep`', async () => {
    const file = path.join(dir, 'small.jsonl');
    const appender = new JsonlAppender(file, { maxBytes: 10, keep: 2 });
    for (let i = 0; i < 6; i++) await appender.append(JSON.stringify({ i }));
    await expect(fs.access(rotatedPath(file, 3))).rejects.toThrow();
    await expect(fs.access(rotatedPath(file, 2))).resolves.toBeUndefined();
  });

  it('never rejects when the write fails', async () => {
    const appender = new JsonlAppender(path.join(dir, 'no-such-dir', 'x.jsonl'), { maxBytes: 100, keep: 1 });
    await expect(appender.append('{}')).resolves.toBeUndefined();
  });
});

describe('secret redaction for the audit log', () => {
  it('redacts env-style assignments and well-known token formats inside free text', () => {
    const env = 'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456\nPORT=3001\nDB_PASSWORD="hunter2hunter2"';
    const out = redactSecretStrings(env);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('PORT=3001');
    expect(redactSecretStrings('token ghp_' + 'a'.repeat(36))).not.toContain('a'.repeat(36));
  });

  it('applies to nested string values in safeForAudit', () => {
    const out = safeForAudit({ result: 'AWS key AKIAABCDEFGHIJKLMNOP here' }) as { result: string };
    expect(out.result).toBe('AWS key ***REDACTED*** here');
  });
});
