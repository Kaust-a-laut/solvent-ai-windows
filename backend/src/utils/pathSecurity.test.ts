import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { PathSecurityError, isPathInside, resolveSecurePath } from './pathSecurity';

const ROOT = path.resolve(process.cwd(), '.vitest-tmp/path-root');
const SIBLING = path.resolve(process.cwd(), '.vitest-tmp/path-root-sibling');

describe('pathSecurity', () => {
  beforeEach(async () => {
    await fs.rm(path.resolve(process.cwd(), '.vitest-tmp/path-root'), { recursive: true, force: true });
    await fs.rm(SIBLING, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, 'nested'), { recursive: true });
    await fs.mkdir(SIBLING, { recursive: true });
    await fs.writeFile(path.join(ROOT, 'nested', 'ok.txt'), 'ok');
  });

  afterEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.rm(SIBLING, { recursive: true, force: true });
  });

  it('allows valid nested paths', async () => {
    await expect(resolveSecurePath('nested/ok.txt', ROOT, [ROOT]))
      .resolves.toBe(path.join(ROOT, 'nested', 'ok.txt'));
  });

  it('rejects traversal and sibling-prefix paths', async () => {
    await expect(resolveSecurePath('../path-root-sibling', ROOT, [ROOT]))
      .rejects.toBeInstanceOf(PathSecurityError);
    expect(isPathInside(SIBLING, ROOT)).toBe(false);
  });

  it('rejects absolute paths outside the permitted root', async () => {
    await expect(resolveSecurePath(SIBLING, ROOT, [ROOT]))
      .rejects.toBeInstanceOf(PathSecurityError);
  });

  it('rejects symlinks that resolve outside the permitted root when supported', async () => {
    const link = path.join(ROOT, 'escape-link');
    try {
      await fs.symlink(SIBLING, link, 'junction');
    } catch {
      return;
    }
    await expect(resolveSecurePath('escape-link', ROOT, [ROOT]))
      .rejects.toBeInstanceOf(PathSecurityError);
  });

  it('rejects writes through a symlinked parent even when the leaf does not exist', async () => {
    const link = path.join(ROOT, 'escape-dir');
    try {
      await fs.symlink(SIBLING, link, 'junction');
    } catch {
      return;
    }
    // The leaf does not exist; the previous implementation fell back to the
    // lexical path and allowed the write. The fix walks up to the existing
    // symlink and resolves that.
    await expect(resolveSecurePath('escape-dir/new-file.txt', ROOT, [ROOT]))
      .rejects.toBeInstanceOf(PathSecurityError);
    await expect(resolveSecurePath('escape-dir/new-sub/new-file.txt', ROOT, [ROOT]))
      .rejects.toBeInstanceOf(PathSecurityError);
  });
});
