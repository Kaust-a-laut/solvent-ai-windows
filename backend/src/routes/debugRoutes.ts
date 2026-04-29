import { Router } from 'express';
import { memoryMetrics } from '../utils/memoryMetrics';
import { vectorService } from '../services/vectorService';
import fs from 'fs/promises';
import path from 'path';

const router = Router();

router.get('/memory-stats', (_req, res) => {
  const stats = memoryMetrics.getStats();
  res.json(stats);
});

router.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain');
  res.send(memoryMetrics.toPrometheus());
});

router.get('/memory-sample', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 10;
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

router.get('/traces', async (_req, res) => {
  try {
    const tracePath = path.resolve(__dirname, '../../../../.solvent_retrieval_traces.jsonl');
    const content = await fs.readFile(tracePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    const traces = lines.map(line => JSON.parse(line));
    res.json(traces.reverse().slice(0, 100)); // Return last 100 traces
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      res.json([]);
    } else {
      res.status(500).json({ error: 'Failed to read traces' });
    }
  }
});

export default router;
