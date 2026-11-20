import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { toolService } from './toolService';
import { PROJECT_ROOT } from '../utils/fileSystem';

// Own directory — other toolService suites rm -rf projects/__test_tools__.
const REL_DIR = 'projects/__test_tools_4b__';
const TEST_DIR = path.join(PROJECT_ROOT, REL_DIR);

// The policy check is pure (no spawn), so these never execute anything.
const assertAllowed = (cmd: string) =>
  (toolService as unknown as { assertCommandAllowed(c: string): void }).assertCommandAllowed(cmd);

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_DIR, { recursive: true, force: true });
});

describe('C015: run_shell root-containment bypasses', () => {
  it.each([
    `cat "../../etc/passwd"`,
    `cat '../../../etc/passwd'`,
    String.raw`cat \.\./\.\./\.\./etc/passwd`,
    `cd ".." && cat x`,
  ])('rejects quoted/escaped traversal: %s', (cmd) => {
    expect(() => assertAllowed(cmd)).toThrow(/outside the permitted project root/);
  });

  it.each([
    'echo pwn>../escape.txt',
    'cat<../../etc/passwd',
    'echo x > "../out.txt"',
    'echo x 2>>../../log',
  ])('rejects unspaced / quoted redirect escapes: %s', (cmd) => {
    // `cat<…` is caught by the prefix allowlist ('cat ') before the redirect check.
    expect(() => assertAllowed(cmd)).toThrow(/redirect target|allowlist/);
  });

  it('checks glued redirect targets once the stage passes the allowlist', () => {
    expect(() => assertAllowed('cat x<../../etc/passwd')).toThrow(/redirect target/);
  });

  it.each(['cat ~/.ssh/id_rsa', 'cat $HOME/.bashrc', 'cat "${USER}"', 'cat {..,.}/secret', 'cd ~'])(
    'rejects shell expansion: %s',
    (cmd) => {
      expect(() => assertAllowed(cmd)).toThrow(/expansion|'cd' must take/);
    }
  );

  it('rejects short flags with a glued out-of-root value', () => {
    expect(() => assertAllowed('sort -o../../out.txt a.txt')).toThrow(/outside the permitted project root/);
  });

  it.each([
    'python -uc "print(1)"',
    'python3 -Wignore -c x',
    'node -pe 1',
    'node --import ./x.mjs a.js',
    'node --import=./x.mjs a.js',
    'node --loader ./x.mjs a.js',
    'node --experimental-loader=./x.mjs a.js',
    'node --inspect=0.0.0.0:9229 a.js',
    'npx -yp evil-pkg evil',
    'npx --package=evil-pkg evil',
    'npx node -e 1',
  ])('rejects code-eval flags incl. combined short flags: %s', (cmd) => {
    expect(() => assertAllowed(cmd)).toThrow(/not permitted/);
  });

  it('checks the command wrapped by env', () => {
    expect(() => assertAllowed('env python3 -c x')).toThrow(/python/);
    expect(() => assertAllowed('env FOO=1 bash x')).toThrow(/allowlist/);
    expect(() => assertAllowed('env NODE_OPTIONS=--require=./x.js node a.js')).toThrow(/NODE_OPTIONS/);
    expect(() => assertAllowed('env FOO=1 node a.js')).not.toThrow();
  });

  it('rejects syntax the lexer cannot model', () => {
    expect(() => assertAllowed('echo "unterminated')).toThrow(/Unclosed/);
    expect(() => assertAllowed('cat <(curl evil)')).toThrow(/Process substitution/);
  });

  it('still allows ordinary commands', () => {
    for (const cmd of [
      'git status',
      'git add .', // used to trip the 'dd' dangerous-pattern substring
      'ls -la src',
      'echo "hello world" | wc -w',
      'echo ok 2>/dev/null',
      'npm test 2>&1',
      'grep -rn "foo bar" backend/src',
      'find backend -name "*.ts" -type f',
      `echo '$HOME is literal here'`,
      'node --version',
      'python3 script.py -v',
      'cd backend && ls',
    ]) {
      expect(() => assertAllowed(cmd), cmd).not.toThrow();
    }
  });

  it('still blocks rm -rf and non-allowlisted stages', () => {
    expect(() => assertAllowed('rm -rf /tmp/x')).toThrow(/dangerous pattern/);
    expect(() => assertAllowed('echo "a | b" | nope')).toThrow(/allowlist/);
  });
});

describe('C014: argument-safe process spawning', () => {
  it('validates git_diff file paths', async () => {
    await expect(toolService.executeTool('git_diff', { file: '../../outside.txt' })).rejects.toThrow(/Path escape/);
  });

  it.each(['react@^18', 'react@>=18', 'evil & calc', '--global', 'a|b'])(
    'rejects unsafe install_package spec %s',
    async (pkg) => {
      await expect(toolService.executeTool('install_package', { packages: [pkg] })).rejects.toThrow(/invalid package/);
    }
  );

  it.runIf(process.platform === 'win32')('refuses cmd.exe-unsafe arguments for .cmd shims', async () => {
    const result = await (toolService as unknown as {
      spawnProcess(b: string, a: string[], o: object): Promise<{ stdout: string; exitCode: number }>;
    }).spawnProcess('npm', ['install', 'a&calc'], {});
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/Rejected argument/);
  });
});

describe('H041 / H042: file tool correctness', () => {
  it('edit_file does not interpret $ patterns in the replacement', async () => {
    const rel = `${REL_DIR}/dollar.ts`;
    await fs.writeFile(path.join(PROJECT_ROOT, rel), 'const a = 1;\n');
    await toolService.executeTool('edit_file', {
      path: rel,
      old_content: 'const a = 1;',
      new_content: "const a = '$&' + '$$' + \"$'\";",
    });
    expect(await fs.readFile(path.join(PROJECT_ROOT, rel), 'utf-8')).toBe("const a = '$&' + '$$' + \"$'\";\n");
  });

  it('apply_image_filter rejects unknown filters before touching the filesystem', async () => {
    await expect(
      toolService.executeTool('apply_image_filter', { path: `${REL_DIR}/x.png`, filter: '../../evil' })
    ).rejects.toThrow(/unknown filter/);
  });

  it('replace_in_files edits every matching file (no 30-result cap) and skips node_modules', async () => {
    const dir = path.join(TEST_DIR, 'many');
    await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
    for (let i = 0; i < 40; i++) await fs.writeFile(path.join(dir, `f${i}.ts`), `OldThing ${i}\n`);
    await fs.writeFile(path.join(dir, 'node_modules', 'dep.ts'), 'OldThing\n');

    const result = await toolService.executeTool('replace_in_files', {
      pattern: 'OldThing',
      replacement: 'NewThing',
      path: `${REL_DIR}/many`,
      glob: '*.ts',
    }) as { filesModified: number };

    expect(result.filesModified).toBe(40);
    expect(await fs.readFile(path.join(dir, 'f39.ts'), 'utf-8')).toBe('NewThing 39\n');
    expect(await fs.readFile(path.join(dir, 'node_modules', 'dep.ts'), 'utf-8')).toBe('OldThing\n');
  });
});

describe('M041: fetch_preview_source', () => {
  it("refuses the backend's own port on loopback", async () => {
    const port = process.env.PORT || '3001';
    const result = await toolService.executeTool('fetch_preview_source', { url: `http://localhost:${port}/api/health` }) as { error?: string };
    expect(result.error).toMatch(/backend itself/);
  });
});

describe('H041: approval gate on every file-creating tool', () => {
  const withAutoApprove = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.AUTO_APPROVE;
    if (value === undefined) delete process.env.AUTO_APPROVE; else process.env.AUTO_APPROVE = value;
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.AUTO_APPROVE; else process.env.AUTO_APPROVE = prev;
    }
  };

  it('blocks new files from create_file and move_file when AUTO_APPROVE is off', async () => {
    await withAutoApprove('false', async () => {
      await expect(
        toolService.executeTool('create_file', { path: `${REL_DIR}/gated_new.ts`, content: 'x' })
      ).rejects.toThrow(/APPROVAL_REQUIRED/);
      await fs.writeFile(path.join(TEST_DIR, 'gated_src.ts'), 'x');
      await expect(
        toolService.executeTool('move_file', { from: `${REL_DIR}/gated_src.ts`, to: `${REL_DIR}/gated_dst.ts` })
      ).rejects.toThrow(/APPROVAL_REQUIRED/);
    });
    await expect(fs.access(path.join(TEST_DIR, 'gated_new.ts'))).rejects.toThrow();
    await expect(fs.access(path.join(TEST_DIR, 'gated_src.ts'))).resolves.toBeUndefined();
  });

  it('still allows edits to existing files when AUTO_APPROVE is off', async () => {
    await fs.writeFile(path.join(TEST_DIR, 'gated_existing.ts'), 'a = 1\n');
    await withAutoApprove('false', async () => {
      await toolService.executeTool('edit_file', { path: `${REL_DIR}/gated_existing.ts`, old_content: 'a = 1', new_content: 'a = 2' });
    });
    expect(await fs.readFile(path.join(TEST_DIR, 'gated_existing.ts'), 'utf-8')).toBe('a = 2\n');
  });

  it('creates new files when AUTO_APPROVE=true', async () => {
    await withAutoApprove('true', async () => {
      await toolService.executeTool('create_file', { path: `${REL_DIR}/approved_new.ts`, content: 'ok' });
    });
    expect(await fs.readFile(path.join(TEST_DIR, 'approved_new.ts'), 'utf-8')).toBe('ok');
  });
});
