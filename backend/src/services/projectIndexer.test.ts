import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { indexProject } from './projectIndexer';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'indexer-test-'));
  await fs.writeFile(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      scripts: { dev: 'vite', build: 'tsc && vite build' },
      dependencies: { react: '^18.0.0', 'framer-motion': '^10.0.0' },
      devDependencies: { typescript: '^5.0.0' },
    })
  );
  await fs.mkdir(path.join(tmpDir, 'src', 'components'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'src', 'components', 'Button.tsx'),
    [
      'import React from "react";',
      'export const Button = () => <button />;',
      'export function helper() {}',
    ].join('\n')
  );
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('indexProject', () => {
  it('includes project name and framework', async () => {
    const map = await indexProject(tmpDir);
    expect(map).toContain('test-project');
    expect(map).toContain('React');
  });

  it('includes script names', async () => {
    const map = await indexProject(tmpDir);
    expect(map).toContain('dev');
    expect(map).toContain('build');
  });

  it('lists key exports with file reference', async () => {
    const map = await indexProject(tmpDir);
    expect(map).toContain('Button');
    expect(map).toContain('Button.tsx');
  });

  it('includes file tree entries', async () => {
    const map = await indexProject(tmpDir);
    expect(map).toContain('src');
    expect(map).toContain('components');
  });

  it('result is under 3KB', async () => {
    const map = await indexProject(tmpDir);
    expect(Buffer.byteLength(map, 'utf-8')).toBeLessThan(3072);
  });
});

describe('symbol DB (built during indexProject)', () => {
  it('stores /-separated paths so file filters work on every platform', async () => {
    const { querySymbols, hasSymbolIndex } = await import('./projectIndexer');
    await indexProject(tmpDir);
    expect(hasSymbolIndex(tmpDir)).toBe(true);
    const hits = querySymbols(tmpDir, 'Button', { file: 'src/components/' });
    expect(hits[0]?.file).toBe('src/components/Button.tsx');
    expect(hits[0]?.kind).toBe('const');
  });
});
