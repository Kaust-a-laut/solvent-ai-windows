import { Router, Request, Response } from 'express';
import path from 'path';
import { z } from 'zod';
import { vectorService } from '../services/vectorService';
import { logger } from '../utils/logger';

const router = Router();

const MAX_MEMORY_LOAD = 2000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const MAX_CONTENT_LENGTH = 100 * 1024; // 100KB
const MAX_SEARCH_LENGTH = 200;

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

function badRequest(res: Response, error: z.ZodError) {
  return res.status(400).json({
    error: 'Invalid request',
    details: error.errors.map(issue => ({ path: issue.path, message: issue.message })),
  });
}

// GET /api/v1/memory/stats
router.get('/memory/stats', (_req: Request, res: Response) => {
  const allEntries = vectorService.getRecentEntries(MAX_MEMORY_LOAD);
  const active = allEntries.filter(e => !e.metadata?.deprecated);

  const byTier: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const e of active) {
    const tier = e.metadata?.tier || 'unknown';
    const type = e.metadata?.type || 'unknown';
    byTier[tier] = (byTier[tier] || 0) + 1;
    byType[type] = (byType[type] || 0) + 1;
  }

  res.json({ total: active.length, byTier, byType });
});

// GET /api/v1/memory/entries?limit=20&offset=0&tier=&search=
router.get('/memory/entries', (req: Request, res: Response) => {
  const parsed = entriesQuerySchema.safeParse(req.query);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { limit, offset, tier, type } = parsed.data;
  const search = parsed.data.search?.toLowerCase();

  let entries = vectorService.getRecentEntries(MAX_MEMORY_LOAD).filter(e => !e.metadata?.deprecated);

  if (tier) entries = entries.filter(e => e.metadata?.tier === tier);
  if (type) entries = entries.filter(e => e.metadata?.type === type);
  if (search) {
    entries = entries.filter(e => {
      const content = String(e.metadata?.content || e.metadata?.summary || '').toLowerCase();
      return content.includes(search);
    });
  }

  const total = entries.length;
  const page = entries.slice(offset, offset + limit).map(e => ({
    id: e.id,
    type: e.metadata?.type || null,
    tier: e.metadata?.tier || null,
    content: e.metadata?.content || e.metadata?.summary || '',
    importance: e.metadata?.importance ?? null,
    confidence: e.metadata?.confidence ?? null,
    timestamp: e.metadata?.timestamp || e.metadata?.lastUpdated || null,
    tags: e.metadata?.tags || [],
  }));

  res.json({ entries: page, total, limit, offset });
});

// POST /api/v1/memory/search — semantic search via embeddings
router.post('/memory/search', async (req: Request, res: Response) => {
  const parsed = memorySearchSchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const { query, limit } = parsed.data;

  const results = await vectorService.search(query, limit);
  const formattedResults = results.map((r: { id: string; score: number; metadata?: Record<string, unknown> }) => ({
    id: r.id,
    score: r.score,
    text: r.metadata?.content || r.metadata?.summary || '',
    metadata: {
      type: r.metadata?.type || null,
      tier: r.metadata?.tier || null,
      importance: r.metadata?.importance ?? null,
      confidence: r.metadata?.confidence ?? null,
      timestamp: r.metadata?.timestamp || r.metadata?.lastUpdated || null,
      tags: r.metadata?.tags || [],
    },
  }));

  res.json({ results: formattedResults });
});

// PATCH /api/v1/memory/entries/:id — update entry content
router.patch('/memory/entries/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const parsed = patchEntrySchema.safeParse(req.body);
  if (!parsed.success) return badRequest(res, parsed.error);
  const ok = await vectorService.updateEntry(id!, { content: parsed.data.content, lastUpdated: new Date().toISOString() });
  if (!ok) return res.status(404).json({ error: 'Entry not found' });
  res.json({ success: true });
});

// DELETE /api/v1/memory/entries/:id — soft-delete one entry
router.delete('/memory/entries/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const ok = await vectorService.deprecateEntry(id!, 'Deleted by user');
  if (!ok) return res.status(404).json({ error: 'Entry not found' });
  res.json({ success: true });
});

// DELETE /api/v1/memory — soft-delete all entries (clear)
router.delete('/memory', async (_req: Request, res: Response) => {
  const active = vectorService.getRecentEntries(MAX_MEMORY_LOAD).filter(e => !e.metadata?.deprecated);
  await Promise.all(active.map(e => vectorService.deprecateEntry(e.id, 'Cleared by user')));
  res.json({ success: true, cleared: active.length });
});

// POST /api/v1/index — trigger project re-index (was missing, called by frontend)
router.post('/index', (_req: Request, res: Response) => {
  const projectRoot = path.join(__dirname, '../../..');
  // Fire-and-forget: indexProject can take minutes on large repos
  vectorService.indexProject(projectRoot).catch((err: Error) => {
    logger.error(`[Memory] Re-index failed: ${err.message}`);
  });
  res.json({ success: true, message: 'Re-indexing started in background' });
});

export default router;
