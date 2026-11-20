import { Router } from 'express';
import { z } from 'zod';
import { memoryMetrics } from '../utils/memoryMetrics';
import { vectorService } from '../services/vectorService';

const router = Router();

const MAX_MEMORY_SAMPLE_LIMIT = 100;
const DEFAULT_MEMORY_SAMPLE_LIMIT = 10;

const memorySampleQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_MEMORY_SAMPLE_LIMIT)
    .catch(DEFAULT_MEMORY_SAMPLE_LIMIT).default(DEFAULT_MEMORY_SAMPLE_LIMIT),
});

router.get('/memory-stats', (_req, res) => {
  const stats = memoryMetrics.getStats();
  res.json(stats);
});

router.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(memoryMetrics.toPrometheus());
});

router.get('/memory-sample', (req, res) => {
  const { limit } = memorySampleQuerySchema.parse(req.query);
  const entries = vectorService.getRecentEntries(limit);

  // Redact vectors for readability
  const sanitized = entries.map(e => ({
    id: e.id,
    metadata: e.metadata,
    vectorDim: e.vector?.length || 0
  }));

  res.json(sanitized);
});

router.post('/reset-metrics', (_req, res) => {
  memoryMetrics.reset();
  res.json({ success: true, message: 'Metrics reset' });
});

// GET /traces was removed — superseded by the more capable
// AIController.getTraces (mounted at GET /api/v1/debug/traces), which is the
// only endpoint the frontend (DebugTab.tsx) actually calls and additionally
// supports query/mode/since/outcome filtering and localhost-gating.

export default router;
