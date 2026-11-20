import { Request, Response } from 'express';
import { harnessOptimizer } from '../services/harnessOptimizer';
import { createSSEWriter } from '../utils/sseWriter';
import { z } from 'zod';

export class HarnessController {
  static async startRun(req: Request, res: Response) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      res.status(403).json({ error: 'This endpoint is only accessible from localhost.' });
      return;
    }

    const schema = z.object({
      maxIterations: z.number().min(1).max(50).optional(),
      candidatesPerIteration: z.number().min(1).max(5).optional(),
      searchSetQuery: z.string().optional(),
      minTraceCount: z.number().min(5).max(100).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    try {
      const run = await harnessOptimizer.startRun(parsed.data);
      res.json(run);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(500).json({ error: err.message });
    }
  }

  static async cancelRun(req: Request, res: Response) {
    const id = req.params.id as string;
    const cancelled = harnessOptimizer.cancelRun(id);
    if (!cancelled) {
      res.status(400).json({ error: 'Run not found or not running' });
      return;
    }
    res.json({ success: true });
  }

  static async getRun(req: Request, res: Response) {
    const id = req.params.id as string;
    const run = harnessOptimizer.getRun(id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }
    res.json(run);
  }

  static async listRuns(_req: Request, res: Response) {
    res.json(harnessOptimizer.listRuns());
  }

  static async streamRun(req: Request, res: Response) {
    const id = req.params.id as string;
    const run = harnessOptimizer.getRun(id);
    if (!run) {
      res.status(404).json({ error: 'Run not found' });
      return;
    }

    const sse = createSSEWriter(req, res);
    sse.send(run);

    // If the run already finished before the client subscribed, terminate immediately
    if (run.status !== 'running') {
      if (!res.writableEnded) res.write(`data: [DONE]\n\n`);
      sse.end();
      return;
    }

    const unsubscribe = harnessOptimizer.onRunUpdate(id, (updatedRun) => {
      if (sse.signal.aborted) {
        unsubscribe();
        return;
      }
      sse.send(updatedRun);
      if (updatedRun.status !== 'running') {
        unsubscribe();
        // Literal [DONE] sentinel (not JSON) — preserves existing wire contract
        if (!res.writableEnded) res.write(`data: [DONE]\n\n`);
        sse.end();
      }
    });

    sse.signal.addEventListener('abort', unsubscribe, { once: true });
  }
}
