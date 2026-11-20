import { Router, Request, Response } from 'express';
import path from 'path';
import { z } from 'zod';
import { vectorService } from '../services/vectorService';
import { logger } from '../utils/logger';
import { handleRouteError } from '../utils/routeErrors';

const router = Router();

const MAX_MEMORY_LOAD = 50_000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_CONTENT_LENGTH = 100 * 1024; // 100KB
const MAX_SEARCH_LENGTH = 200;

function isEntryDeprecated(metadata?: Record<string, unknown>): boolean {
  return metadata?.status === 'deprecated' || Boolean(metadata?.deprecated);
}

function getEntryContent(metadata?: Record<string, unknown>): string {
  const raw = metadata?.text ?? metadata?.content ?? metadata?.summary ?? '';
  return typeof raw === 'string' ? raw : String(raw);
}

function getEntryTimestamp(metadata?: Record<string, unknown>): unknown {
  return metadata?.timestamp ?? metadata?.lastUpdated ?? metadata?.createdAt ?? null;
}

// Coercing schemas so query strings parse cleanly into numbers; .catch keeps
// existing behavior of falling back to a default when malformed input arrives.
const entriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).catch(DEFAULT_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).catch(0).default(0),
  tier: z.string().min(1).max(64).optional(),
  type: z.string().min(1).max(64).optional(),
  search: z.string().max(MAX_SEARCH_LENGTH).optional(),
});

const memorySearchSchema = z.object({
  query: z.string().min(1).max(MAX_SEARCH_LENGTH),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(10),
}).strict();

const patchEntrySchema = z.object({
  content: z.string().trim().min(1).max(MAX_CONTENT_LENGTH),
}).strict();

const deprecateSchema = z.object({
  id: z.string().min(1).max(256),
  reason: z.string().max(500).optional(),
}).strict();

function badRequest(res: Response, error: z.ZodError) {
  return res.status(400).json({
    error: 'Invalid request',
    details: error.errors.map(issue => ({ path: issue.path, message: issue.message })),
  });
}

// GET /api/v1/memory/stats
router.get('/memory/stats', async (_req: Request, res: Response) => {
  try {
    if (typeof vectorService.waitUntilReady === 'function') {
      await vectorService.waitUntilReady();
    }
    const allEntries = vectorService.getRecentEntries(MAX_MEMORY_LOAD);
    const active = allEntries.filter(e => !isEntryDeprecated(e.metadata));

    const byTier: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const e of active) {
      const tier = String(e.metadata?.tier || 'unknown');
      const type = String(e.metadata?.type || 'unknown');
      byTier[tier] = (byTier[tier] || 0) + 1;
      byType[type] = (byType[type] || 0) + 1;
    }

    res.json({ total: active.length, byTier, byType });
  } catch (error) {
    handleRouteError({ res, error, context: 'memory-stats' });
  }
});

// GET /api/v1/memory/entries?limit=20&offset=0&tier=&search=
router.get('/memory/entries', async (req: Request, res: Response) => {
  try {
    const parsed = entriesQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    const { limit, offset, tier, type } = parsed.data;
    const search = parsed.data.search?.toLowerCase();

    if (typeof vectorService.waitUntilReady === 'function') {
      await vectorService.waitUntilReady();
    }
    let entries = vectorService.getRecentEntries(MAX_MEMORY_LOAD).filter(e => !isEntryDeprecated(e.metadata));

    if (tier) entries = entries.filter(e => e.metadata?.tier === tier);
    if (type) entries = entries.filter(e => e.metadata?.type === type);
    if (search) {
      entries = entries.filter(e => getEntryContent(e.metadata).toLowerCase().includes(search));
    }

    const total = entries.length;
    const page = entries.slice(offset, offset + limit).map(e => ({
      id: e.id,
      type: e.metadata?.type || null,
      tier: e.metadata?.tier || null,
      content: getEntryContent(e.metadata),
      importance: e.metadata?.importance ?? null,
      confidence: e.metadata?.confidence ?? null,
      timestamp: getEntryTimestamp(e.metadata),
      tags: e.metadata?.tags || [],
    }));

    res.json({ entries: page, total, limit, offset });
  } catch (error) {
    handleRouteError({ res, error, context: 'memory-entries' });
  }
});

// POST /api/v1/memory/search — semantic search via embeddings
router.post('/memory/search', async (req: Request, res: Response) => {
  try {
    const parsed = memorySearchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    const { query, limit } = parsed.data;

    const results = await vectorService.search(query, limit);
    const formattedResults = results.map((r: { id: string; score: number; metadata?: Record<string, unknown> }) => ({
      id: r.id,
      score: r.score,
      text: getEntryContent(r.metadata),
      metadata: {
        type: r.metadata?.type || null,
        tier: r.metadata?.tier || null,
        importance: r.metadata?.importance ?? null,
        confidence: r.metadata?.confidence ?? null,
        timestamp: getEntryTimestamp(r.metadata),
        tags: r.metadata?.tags || [],
      },
    }));

    res.json({ results: formattedResults });
  } catch (error) {
    handleRouteError({ res, error, context: 'memory-search' });
  }
});

// PATCH /api/v1/memory/entries/:id — update entry content
router.patch('/memory/entries/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Entry id is required' });
    const parsed = patchEntrySchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    const ok = await vectorService.updateEntry(id, {
      text: parsed.data.content,
      content: parsed.data.content,
      lastUpdated: new Date().toISOString(),
    });
    if (!ok) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (error) {
    handleRouteError({ res, error, context: 'memory-patch' });
  }
});

// DELETE /api/v1/memory/entries/:id — soft-delete one entry
router.delete('/memory/entries/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: 'Entry id is required' });
    const ok = await vectorService.deprecateEntry(id, 'Deleted by user');
    if (!ok) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (error) {
    handleRouteError({ res, error, context: 'memory-delete-entry' });
  }
});

// POST /api/v1/memory/deprecate — soft-delete endpoint used by legacy/HUD callers
router.post('/memory/deprecate', async (req: Request, res: Response) => {
  try {
    const parsed = deprecateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    const ok = await vectorService.deprecateEntry(parsed.data.id, parsed.data.reason || 'Deprecated by user');
    if (!ok) return res.status(404).json({ error: 'Entry not found' });
    res.json({ success: true });
  } catch (error) {
    handleRouteError({ res, error, context: 'memory-deprecate' });
  }
});

// DELETE /api/v1/memory — soft-delete all entries (clear)
router.delete('/memory', async (_req: Request, res: Response) => {
  try {
    let cleared: number;
    if (typeof vectorService.deprecateAll === 'function') {
      cleared = await vectorService.deprecateAll('Cleared by user');
    } else {
      const active = vectorService.getRecentEntries(MAX_MEMORY_LOAD).filter(e => !isEntryDeprecated(e.metadata));
      cleared = 0;
      for (const entry of active) {
        const ok = await vectorService.deprecateEntry(entry.id, 'Cleared by user');
        if (ok) cleared++;
      }
    }
    res.json({ success: true, cleared });
  } catch (error) {
    handleRouteError({ res, error, context: 'memory-clear' });
  }
});

// POST /api/v1/index — trigger project re-index
router.post('/index', (_req: Request, res: Response) => {
  const projectRoot = process.env.PROJECT_ROOT || path.join(__dirname, '../../../projects');
  // Fire-and-forget: indexProject can take minutes on large repos
  vectorService.indexProject(projectRoot).catch((err: Error) => {
    logger.error(`[Memory] Re-index failed: ${err.message}`);
  });
  res.json({ success: true, message: 'Re-indexing started in background' });
});

export default router;
