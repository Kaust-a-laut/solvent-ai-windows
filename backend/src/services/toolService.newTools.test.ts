import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { toolService } from './toolService';
import fs from 'fs/promises';
import path from 'path';
import { PROJECT_ROOT } from '../utils/fileSystem';

const TEST_DIR = path.join(PROJECT_ROOT, 'projects', '__test_tools__');

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe('get_file_outline', () => {
  it('returns exported symbols with line numbers', async () => {
    const file = path.join(TEST_DIR, 'outline.ts');
    await fs.writeFile(file, [
      'export function greet() {}',
      'const internal = () => {}',
      'export const MyComp = () => null',
      'export class Foo {}',
    ].join('\n'));

    const result = await toolService.executeTool('get_file_outline', {
      path: 'projects/__test_tools__/outline.ts',
    }) as string;

    expect(result).toContain('1:');
    expect(result).toContain('greet');
    expect(result).toContain('3:');
    expect(result).toContain('MyComp');
    expect(result).toContain('Foo');
    expect(result).not.toContain('internal');
  });
});

describe('grep_files', () => {
  beforeAll(async () => {
    await fs.writeFile(path.join(TEST_DIR, 'a.ts'), 'export const SECRET = 42;\n');
    await fs.writeFile(path.join(TEST_DIR, 'b.ts'), 'import { SECRET } from "./a";\n');
  });

  it('finds pattern across files', async () => {
    const result = await toolService.executeTool('grep_files', {
      pattern: 'SECRET',
      path: 'projects/__test_tools__',
    }) as string;

    expect(result).toContain('SECRET');
    expect(result).toMatch(/a\.ts/);
    expect(result).toMatch(/b\.ts/);
  });

  it('returns no-match message when nothing found', async () => {
    const result = await toolService.executeTool('grep_files', {
      pattern: 'XYZNOTFOUND12345',
      path: 'projects/__test_tools__',
    }) as string;

    expect(result).toContain('No matches');
  });
});

describe('edit_file', () => {
  beforeEach(async () => {
    await fs.writeFile(path.join(TEST_DIR, 'edit.ts'), 'const x = 1;\nconst y = 2;\n');
  });

  it('replaces unique string in file', async () => {
    await toolService.executeTool('edit_file', {
      path: 'projects/__test_tools__/edit.ts',
      old_content: 'const x = 1;',
      new_content: 'const x = 99;',
    });

    const content = await fs.readFile(path.join(TEST_DIR, 'edit.ts'), 'utf-8');
    expect(content).toBe('const x = 99;\nconst y = 2;\n');
  });

  it('throws when old_content not found', async () => {
    await expect(
      toolService.executeTool('edit_file', {
        path: 'projects/__test_tools__/edit.ts',
        old_content: 'NOTFOUND',
        new_content: 'anything',
      })
    ).rejects.toThrow('Could not find');
  });

  it('throws when old_content appears more than once', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'edit.ts'), 'foo\nfoo\n');
    await expect(
      toolService.executeTool('edit_file', {
        path: 'projects/__test_tools__/edit.ts',
        old_content: 'foo',
        new_content: 'bar',
      })
    ).rejects.toThrow('appears 2 times');
  });
});

describe('create_file', () => {
  it('creates a new file with content', async () => {
    await toolService.executeTool('create_file', {
      path: 'projects/__test_tools__/brand_new.ts',
      content: 'export const x = 1;\n',
    });
    const content = await fs.readFile(path.join(TEST_DIR, 'brand_new.ts'), 'utf-8');
    expect(content).toBe('export const x = 1;\n');
  });

  it('throws when file already exists', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'existing.ts'), 'already here\n');
    await expect(
      toolService.executeTool('create_file', {
        path: 'projects/__test_tools__/existing.ts',
        content: 'overwrite\n',
      })
    ).rejects.toThrow('already exists');
  });
});

describe('delete_file', () => {
  it('removes the file', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'to_delete.ts'), 'bye\n');
    await toolService.executeTool('delete_file', { path: 'projects/__test_tools__/to_delete.ts' });
    await expect(fs.access(path.join(TEST_DIR, 'to_delete.ts'))).rejects.toThrow();
  });
});

describe('move_file', () => {
  it('renames a file', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'move_src.ts'), 'content\n');
    await toolService.executeTool('move_file', {
      from: 'projects/__test_tools__/move_src.ts',
      to: 'projects/__test_tools__/move_dst.ts',
    });
    await expect(fs.access(path.join(TEST_DIR, 'move_src.ts'))).rejects.toThrow();
    const content = await fs.readFile(path.join(TEST_DIR, 'move_dst.ts'), 'utf-8');
    expect(content).toBe('content\n');
  });
});

describe('replace_in_files', () => {
  it('replaces string across multiple files', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'r1.ts'), 'OldName is here\n');
    await fs.writeFile(path.join(TEST_DIR, 'r2.ts'), 'import OldName from "./r1"\n');

    const result = await toolService.executeTool('replace_in_files', {
      pattern: 'OldName',
      replacement: 'NewName',
      path: 'projects/__test_tools__',
      glob: '*.ts',
    }) as { filesModified: number; files: string[] };

    expect(result.filesModified).toBe(2);
    const c1 = await fs.readFile(path.join(TEST_DIR, 'r1.ts'), 'utf-8');
    expect(c1).toContain('NewName');
    expect(c1).not.toContain('OldName');
  });
});

describe('run_tests', () => {
  it('returns stdout and exitCode', async () => {
    const result = await toolService.executeTool('run_tests', {
      cwd: 'projects/__test_tools__',
    }) as { stdout: string; exitCode: number };

    expect(result).toHaveProperty('stdout');
    expect(result).toHaveProperty('exitCode');
    expect(typeof result.stdout).toBe('string');
    expect(typeof result.exitCode).toBe('number');
  });
});

describe('get_errors', () => {
  it('returns errors array and count', async () => {
    const result = await toolService.executeTool('get_errors', {
      cwd: 'projects/__test_tools__',
    }) as { errors: unknown[]; count: number };

    expect(Array.isArray(result.errors)).toBe(true);
    expect(typeof result.count).toBe('number');
  });
});

describe('git_status', () => {
  it('returns a string', async () => {
    const result = await toolService.executeTool('git_status', {});
    expect(typeof result).toBe('string');
  });
});

describe('get_project_info', () => {
  it('returns name and scripts from package.json', async () => {
    const result = await toolService.executeTool('get_project_info', {}) as Record<string, unknown>;
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('scripts');
    expect(result).toHaveProperty('framework');
  });
});
