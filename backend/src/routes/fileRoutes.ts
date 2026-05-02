import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';

import mammoth from 'mammoth';
import { config } from '../config';
import { handleRouteError } from '../utils/routeErrors';
import { logger } from '../utils/logger';
import { PathSecurityError, resolveSecureChildPath, resolveSecurePath } from '../utils/pathSecurity';

const router = Router();
// Allow dynamic project root, but default to a dedicated 'projects' or empty directory
const rootDir = process.env.PROJECT_ROOT || path.resolve(__dirname, '../../../projects');

// Security: Define permitted root paths for file access
// SOLVENT_INTERNAL_DEV bypass is removed for security - all access must go through secure path validation
const permittedRoots: string[] = [
  path.resolve(rootDir),
  path.resolve(__dirname, '../../uploads')
].map(p => path.resolve(p)); // Ensure all paths are resolved

// Auto-create projects directory on server boot
void fs.mkdir(path.resolve(__dirname, '../../../projects'), { recursive: true });

router.get('/projects', async (_req, res) => {
  try {
    const projectsDir = path.resolve(__dirname, '../../../projects');
    const entries = await fs.readdir(projectsDir, { withFileTypes: true });
    const subdirs: Array<{ name: string; path: string; lastModified: number }> = [];

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(projectsDir, entry.name);
        const stats = await fs.stat(fullPath);
        subdirs.push({
          name: entry.name,
          path: entry.name,
          lastModified: stats.mtimeMs
        });
      }
    }

    subdirs.sort((a, b) => b.lastModified - a.lastModified);
    res.json(subdirs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Multer configuration
const uploadDir = path.resolve(__dirname, '../../uploads');
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    // Strip directory components from the original name to prevent path traversal
    const safeName = path.basename(file.originalname);
    const uniqueName = `${Date.now()}-${safeName}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const filePath = req.file.path;
    const extension = path.extname(req.file.originalname).toLowerCase();
    let content = '';

    // Extract text content based on file type
    if (extension === '.pdf') {
      const dataBuffer = await fs.readFile(filePath);
      const { default: pdf } = await import('pdf-parse');
      const data = await (pdf as (buffer: Buffer) => Promise<{ text: string }>)(dataBuffer);
      content = data.text;
    } else if (['.docx', '.doc'].includes(extension)) {
      const result = await mammoth.extractRawText({ path: filePath });
      content = result.value;
    } else if (['.txt', '.ts', '.js', '.py', '.json', '.md', '.tsx', '.jsx'].includes(extension)) {
      content = await fs.readFile(filePath, 'utf-8');
    }

    res.json({
      status: 'success',
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: `/files/${req.file.filename}`,
      content: content.substring(0, 50000) // Limit content size for prompt safety
    });
  } catch (error) {
    handleRouteError({ res, error, context: 'file-upload' });
  }
});

async function getFileTree(dir: string, base: string = ''): Promise<Array<{ name: string; type: string; path?: string; children?: Array<unknown> }>> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const nodes = [];

    for (const entry of entries) {
      if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;

      // Always emit forward-slash paths — consumers (WebContainer, toWcPath)
      // split on '/' only, so backslashes from path.join on Windows break sync.
      const relPath = (base ? base + '/' + entry.name : entry.name).replace(/\\/g, '/');
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        nodes.push({
          name: entry.name,
          type: 'directory',
          path: relPath,
          children: await getFileTree(fullPath, relPath)
        });
      } else {
        nodes.push({
          name: entry.name,
          type: 'file',
          path: relPath
        });
      }
    }

    return nodes.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });
  } catch (e) {
    return [];
  }
}

router.get('/list', async (req, res) => {
  try {
    const root = permittedRoots[0];
    if (!root) {
      return res.status(500).json({ error: 'No permitted roots configured' });
    }
    let targetDir = root;
    let projectBase = '';
    if (req.query.project) {
      const projectName = req.query.project as string;
      targetDir = await resolveSecureChildPath(root, projectName, permittedRoots);
      projectBase = projectName;
      await fs.mkdir(targetDir, { recursive: true });
    }
    // Pass projectBase so returned paths include the project folder prefix
    // (e.g. "myApp/src/index.ts" not just "src/index.ts"), keeping list/read/write consistent.
    const tree = await getFileTree(targetDir, projectBase);
    res.json(tree);
  } catch (error) {
    if (error instanceof PathSecurityError) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * Validates and resolves a user-provided path to a secure absolute path.
 * 
 * Security measures:
 * 1. Resolves the path to an absolute path
 * 2. Resolves symlinks to their real paths (prevents symlink attacks)
 * 3. Validates the path starts with a permitted root (with trailing separator to prevent prefix attacks)
 * 4. Checks against an allowlist of permitted root directories
 * 
 * @param userPath - The user-provided relative path
 * @param root - The root directory to resolve against
 * @returns The validated absolute path
 * @throws {Error} If the path is outside permitted roots or doesn't exist
 */
async function getSecurePath(userPath: string, root: string): Promise<string> {
  return resolveSecurePath(userPath, root, permittedRoots);
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
};

router.get('/raw', async (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  const root = permittedRoots[0];
  if (!root) return res.status(500).json({ error: 'No permitted roots configured' });
  try {
    const fullPath = await getSecurePath(filePath as string, root);
    const data = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(data);
  } catch (error: unknown) {
    const err = error as { message?: string; code?: string };
    if (error instanceof PathSecurityError || err.message?.includes('Access denied')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    handleRouteError({ res, error, context: 'file-raw' });
  }
});

router.get('/read', async (req, res) => {
  const { path: filePath } = req.query;
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  const root = permittedRoots[0];
  if (!root) return res.status(500).json({ error: 'No permitted roots configured' });
  try {
    const fullPath = await getSecurePath(filePath as string, root);
    const content = await fs.readFile(fullPath, 'utf-8');
    res.json({ content });
  } catch (error: unknown) {
    const err = error as { message?: string; code?: string };
    if (error instanceof PathSecurityError || err.message?.includes('Access denied')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'File not found' });
    }
    handleRouteError({ res, error, context: 'file-read' });
  }
});

router.post('/write', async (req, res) => {
  const { path: filePath, content } = req.body;
  logger.debug(`[file/write] Received: ${filePath}`);
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  const root = permittedRoots[0];
  logger.debug(`[file/write] Root: ${root}`);
  if (!root) return res.status(500).json({ error: 'No permitted roots configured' });
  try {
    const fullPath = await getSecurePath(filePath, root);
    logger.debug(`[file/write] Full path: ${fullPath}`);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
    logger.debug(`[file/write] Success: ${fullPath}`);
    res.json({ status: 'success' });
  } catch (error: unknown) {
    logger.error(`[file/write] Error: ${error instanceof Error ? error.message : String(error)}`);
    const err = error as { message?: string };
    if (error instanceof PathSecurityError || err.message?.includes('Access denied')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    handleRouteError({ res, error, context: 'file-write' });
  }
});

router.post('/shell', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Command required' });
  if (!config.SOLVENT_ENABLE_HTTP_SHELL) {
    return res.status(403).json({ error: 'HTTP shell execution is disabled' });
  }
  try {
    const { toolService } = await import('../services/toolService');
    const commandText = String(command);
    const commandPrefix = commandText.trim().split(/\s+/)[0] || '';
    logger.warn('[file/shell] Accepted HTTP shell command', {
      requestId: req.id,
      commandPrefix,
      cwd: process.cwd(),
    });
    const result = await toolService.executeTool('run_shell', { command });
    logger.warn('[file/shell] HTTP shell command completed', {
      requestId: req.id,
      commandPrefix,
      status: 'success',
    });
    res.json(result);
  } catch (error) {
    logger.warn('[file/shell] HTTP shell command failed', {
      requestId: req.id,
      status: 'failed',
    });
    handleRouteError({ res, error, context: 'file-shell' });
  }
});

router.get('/index', async (req, res) => {
  try {
    const { indexProject } = await import('../services/projectIndexer');
    const project = req.query.project as string | undefined;
    const targetDir = await resolveSecureChildPath(rootDir, project, permittedRoots);

    const map = await indexProject(targetDir);
    return res.json({ map });
  } catch (err: unknown) {
    if (err instanceof PathSecurityError) {
      return res.status(403).json({ error: 'Access denied' });
    }
    return handleRouteError({ res, error: err, context: 'file-index' });
  }
});

export default router;
