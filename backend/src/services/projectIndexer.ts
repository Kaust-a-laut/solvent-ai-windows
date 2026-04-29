import fs from 'fs/promises';
import path from 'path';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache', 'out', '.turbo',
  '.solvent_sessions', '__pycache__', '.pytest_cache', '.mypy_cache',
]);
const EXPORT_REGEX =
  /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/;
const MAX_SYMBOL_FILES = 3000;  // 10x increase — handles medium-sized projects
const MAX_EXPORTS = 500;        // 10x increase — captures more symbols
const MAX_FILES_PER_DIR = 50;   // more files per directory
const MAX_DEPTH = 6;            // deeper tree traversal

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

  // Build the queryable symbol DB in the background (non-blocking)
  void buildSymbolIndex(projectRoot);

  return parts.join('\n');
}

// ── Symbol Database (queryable by the agent) ──

export interface SymbolEntry {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum' | 'other';
  file: string;  // relative to project root
  line: number;
  signature: string;
}

const KIND_REGEX = /^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|type|interface|enum)\s+(\w+)/;

// In-memory symbol DB per project root. Rebuilt on each indexProject call.
const symbolDB: Map<string, SymbolEntry[]> = new Map();

/** Check if the symbol index has been built for a project root. */
export function hasSymbolIndex(projectRoot: string): boolean {
  return symbolDB.has(projectRoot);
}

/**
 * Build (or rebuild) the symbol index for a project.
 * Called automatically by indexProject, but can be called standalone.
 */
export async function buildSymbolIndex(projectRoot: string): Promise<SymbolEntry[]> {
  const { allFiles } = await scanDir(projectRoot, 0);
  const entries: SymbolEntry[] = [];
  let scanned = 0;

  for (const f of allFiles) {
    if (scanned >= MAX_SYMBOL_FILES || entries.length >= MAX_EXPORTS) break;
    if (!/\.(ts|tsx|js|jsx)$/.test(f)) continue;
    try {
      const content = await fs.readFile(f, 'utf-8');
      const relPath = path.relative(projectRoot, f);
      content.split('\n').forEach((line, idx) => {
        const m = line.match(KIND_REGEX);
        if (m && entries.length < MAX_EXPORTS) {
          const rawKind = m[1]!;
          const kind = (['function','class','interface','type','const','enum'].includes(rawKind)
            ? rawKind : 'other') as SymbolEntry['kind'];
          entries.push({
            name: m[2]!,
            kind,
            file: relPath,
            line: idx + 1,
            signature: line.trim().slice(0, 100),
          });
        }
      });
      scanned++;
    } catch { /* skip */ }
  }

  symbolDB.set(projectRoot, entries);
  return entries;
}

/**
 * Query the symbol index with fuzzy matching on name and optional filters.
 * Returns up to `limit` results sorted by relevance.
 */
export function querySymbols(
  projectRoot: string,
  query: string,
  options?: { kind?: string; file?: string; limit?: number }
): SymbolEntry[] {
  const entries = symbolDB.get(projectRoot) ?? [];
  const q = query.toLowerCase();
  const limit = options?.limit ?? 20;

  let filtered = entries;

  // Filter by kind
  if (options?.kind) {
    filtered = filtered.filter(e => e.kind === options.kind);
  }

  // Filter by file substring
  if (options?.file) {
    const fq = options.file.toLowerCase();
    filtered = filtered.filter(e => e.file.toLowerCase().includes(fq));
  }

  // Score by name match quality
  const scored = filtered.map(e => {
    const nameLower = e.name.toLowerCase();
    let score = 0;
    if (nameLower === q) score = 100;          // exact match
    else if (nameLower.startsWith(q)) score = 80; // prefix match
    else if (nameLower.includes(q)) score = 50;   // substring match
    else {
      // Fuzzy: count matching characters in order
      let qi = 0;
      for (let ni = 0; ni < nameLower.length && qi < q.length; ni++) {
        if (nameLower[ni] === q[qi]) { qi++; score += 1; }
      }
    }
    return { entry: e, score };
  });

  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.entry);
}
