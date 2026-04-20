import fs from 'fs/promises';
import path from 'path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', 'out', '.turbo',
]);
const EXPORT_REGEX =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/;
const MAX_SYMBOL_FILES = 300;
const MAX_EXPORTS = 50;
const MAX_FILES_PER_DIR = 15;
const MAX_DEPTH = 4;

interface ScanResult {
  tree: string;
  allFiles: string[];
}

async function scanDir(dir: string, depth: number): Promise<ScanResult> {
  if (depth > MAX_DEPTH) return { tree: '', allFiles: [] };

  let tree = '';
  const allFiles: string[] = [];
  const indent = '  '.repeat(depth);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { tree: '', allFiles: [] };
  }

  const dirs = entries.filter((e) => e.isDirectory() && !IGNORE_DIRS.has(e.name));
  const files = entries.filter((e) => e.isFile());

  for (const d of dirs.slice(0, 20)) {
    const childPath = path.join(dir, d.name);
    if (depth < MAX_DEPTH - 1) {
      const child = await scanDir(childPath, depth + 1);
      tree += `${indent}${d.name}/\n${child.tree}`;
      allFiles.push(...child.allFiles);
    } else {
      const count = await fs.readdir(childPath).then((e) => e.length).catch(() => 0);
      tree += `${indent}${d.name}/ (${count} files)\n`;
    }
  }

  for (const f of files.slice(0, MAX_FILES_PER_DIR)) {
    allFiles.push(path.join(dir, f.name));
    tree += `${indent}${f.name}\n`;
  }
  if (files.length > MAX_FILES_PER_DIR) {
    tree += `${indent}... (${files.length - MAX_FILES_PER_DIR} more)\n`;
  }

  return { tree, allFiles };
}

function detectFramework(deps: Record<string, string>): string {
  if (deps.next) return 'Next.js';
  if (deps['@remix-run/react']) return 'Remix';
  if (deps.react) return 'React';
  if (deps.vue) return 'Vue';
  if (deps.svelte) return 'Svelte';
  if (deps.express) return 'Express';
  if (deps.fastify) return 'Fastify';
  return 'Node.js';
}

export async function indexProject(projectRoot: string): Promise<string> {
  const parts: string[] = [];

  // Package info
  try {
    const raw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as {
      name?: string; scripts?: Record<string, string>;
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const framework = detectFramework(allDeps);
    const topDeps = Object.keys(pkg.dependencies ?? {}).slice(0, 8).join(', ');
    parts.push(`Project: ${pkg.name ?? 'unknown'} | ${framework}`);
    parts.push(`Scripts: ${Object.keys(pkg.scripts ?? {}).join(', ') || '(none)'}`);
    parts.push(`Key deps: ${topDeps || '(none)'}`);
  } catch {
    parts.push('Project: (no package.json)');
  }

  // File tree
  const { tree, allFiles } = await scanDir(projectRoot, 0);
  parts.push('\nFile tree:');
  parts.push(tree.trimEnd());

  // Key exports
  const symbols: string[] = [];
  let scanned = 0;
  for (const f of allFiles) {
    if (scanned >= MAX_SYMBOL_FILES || symbols.length >= MAX_EXPORTS) break;
    if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
    try {
      const content = await fs.readFile(f, 'utf-8');
      content.split('\n').forEach((line, idx) => {
        const m = line.match(EXPORT_REGEX);
        if (m && symbols.length < MAX_EXPORTS) {
          symbols.push(`  ${m[1]} → ${path.relative(projectRoot, f)}:${idx + 1}`);
        }
      });
      scanned++;
    } catch {
      // skip unreadable files
    }
  }

  if (symbols.length > 0) {
    parts.push('\nKey exports:');
    parts.push(symbols.join('\n'));
  }

  return parts.join('\n');
}
