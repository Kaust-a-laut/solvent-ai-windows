import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import multer from 'multer';
import { z } from 'zod';

import mammoth from 'mammoth';
import { config } from '../config';
import { handleRouteError } from '../utils/routeErrors';
import { logger } from '../utils/logger';
import { PathSecurityError, resolveSecureChildPath, resolveSecurePath } from '../utils/pathSecurity';

const router = Router();
// Allow dynamic project root, but default to a dedicated 'projects' or empty directory
const rootDir = path.resolve(process.env.PROJECT_ROOT || path.resolve(__dirname, '../../../projects'));
const uploadDir = path.resolve(
  process.env.SOLVENT_DATA_DIR
    ? path.join(process.env.SOLVENT_DATA_DIR, 'uploads')
    : path.resolve(__dirname, '../../uploads')
);

// Security: Define permitted root paths for file access
// SOLVENT_INTERNAL_DEV bypass is removed for security - all access must go through secure path validation
const permittedRoots: string[] = [
  rootDir,
  uploadDir,
].map(p => path.resolve(p));

// Auto-create projects and uploads directories on server boot (catch errors so read-only roots never cause unhandled rejections)
void fs.mkdir(rootDir, { recursive: true }).catch((err) => {
  logger.warn('[fileRoutes] Failed to ensure projects directory:', err);
});
void fs.mkdir(uploadDir, { recursive: true }).catch((err) => {
  logger.warn('[fileRoutes] Failed to ensure uploads directory:', err);
});

router.get('/projects', async (_req, res) => {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const dirEntries = entries.filter(e => e.isDirectory());
    const statsList = await Promise.all(dirEntries.map(async (entry) => {
      try {
        const stats = await fs.stat(path.join(rootDir, entry.name));
        return {
          name: entry.name,
          path: entry.name,
          lastModified: stats.mtimeMs,
        };
      } catch {
        return null;
      }
    }));

    const subdirs = statsList
      .filter((item): item is { name: string; path: string; lastModified: number } => item !== null)
      .sort((a, b) => b.lastModified - a.lastModified);
    res.json(subdirs);
  } catch {
    res.status(500).json({ error: 'Failed to list projects' });
  }
});

// Multer configuration
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    // Strip directory components and sanitize special/Windows-illegal filename characters
    const rawBase = path.basename(file.originalname);
    const safeName = rawBase.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'upload';
    const uniqueName = `${Date.now()}-${randomUUID().slice(0, 8)}-${safeName}`;
    cb(null, uniqueName);
  },
});

// Allowlist of extensions we actually need to accept: text-extraction formats
// (see the extension switch in POST /upload below) plus the raster image types
// used for chat attachments and preview screenshots. Deliberately excludes
// .html/.svg/.js-as-served-content and any other type that a browser would
// execute or render as a document when loaded directly from the /files static
// mount (see server.ts's Content-Disposition/nosniff headers for defense in depth).
const ALLOWED_UPLOAD_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.txt', '.ts', '.js', '.py', '.json', '.md', '.tsx', '.jsx',
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
]);

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
      const err = new Error(`Unsupported file type: ${extension || '(none)'}`) as Error & { status?: number };
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

const uploadSingleFile: import('express').RequestHandler = (req, res, next) => {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    const multerErr = err as { code?: string; status?: number; message?: string };
    if (multerErr.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Uploaded file exceeds 50MB size limit' });
    }
    return res.status(multerErr.status || 400).json({ error: multerErr.message || 'File upload failed' });
  });
};

router.post('/upload', uploadSingleFile, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = req.file.path;
  try {
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
    // Clean up orphaned upload on extraction failure
    await fs.unlink(filePath).catch(() => {});
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
  } catch {
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
    if (req.query.project !== undefined) {
      if (typeof req.query.project !== 'string') {
        return res.status(400).json({ error: 'Invalid project parameter' });
      }
      targetDir = await resolveSecureChildPath(root, req.query.project, permittedRoots);
      projectBase = path.relative(root, targetDir).replace(/\\/g, '/');
    }
    // Pass normalized projectBase so returned paths include the project folder prefix
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

const MAX_RAW_FILE_BYTES = 100 * 1024 * 1024; // 100MB safety cap

router.get('/raw', async (req, res) => {
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'Path required' });
  }
  const root = permittedRoots[0];
  if (!root) return res.status(500).json({ error: 'No permitted roots configured' });
  try {
    const fullPath = await getSecurePath(filePath, root);
    const stats = await fs.stat(fullPath);
    if (!stats.isFile()) {
      return res.status(400).json({ error: 'Path is not a regular file' });
    }
    if (stats.size > MAX_RAW_FILE_BYTES) {
      return res.status(413).json({ error: 'File too large' });
    }
    const ext = path.extname(fullPath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', String(stats.size));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Defense-in-depth against inline SVG / active content script execution
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    const stream = createReadStream(fullPath);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        handleRouteError({ res, error: err, context: 'file-raw-stream' });
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
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
  const filePath = req.query.path;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'Path required' });
  }
  const root = permittedRoots[0];
  if (!root) return res.status(500).json({ error: 'No permitted roots configured' });
  try {
    const fullPath = await getSecurePath(filePath, root);
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

const writeFileSchema = z.object({
  path: z.string().trim().min(1, 'Path required').max(4096),
  content: z.string(),
});

router.post('/write', async (req, res) => {
  const parsed = writeFileSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Path and string content required' });
  }
  const { path: filePath, content } = parsed.data;
  logger.debug(`[file/write] Received: ${filePath}`);
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
