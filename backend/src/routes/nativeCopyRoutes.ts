import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from '../utils/logger';
import { nativeCopyManager } from '../services/nativeCopyManager';

const router = Router();

/**
 * Defense-in-depth: sidecar spawn is high-impact. Even though the session
 * secret middleware is already applied upstream, we gate this route group
 * to localhost-only to prevent a leaked secret from being used to spawn
 * arbitrary child processes from a remote origin.
 */
function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || '';
  const ok = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!ok) {
    logger.warn(`[NativeCopy] Non-localhost access denied: ip=${ip} path=${req.path}`);
    res.status(403).json({ error: 'Forbidden (localhost only)' });
    return;
  }
  next();
}

router.use(localhostOnly);

const startSchema = z.object({
  projectPath: z.string().min(1).max(512),
  port: z.number().int().min(1024).max(65535).optional(),
});

router.post('/start', async (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
    return;
  }
  try {
    const { port, pid } = await nativeCopyManager.start(
      parsed.data.projectPath,
      parsed.data.port
    );
    res.json({ ok: true, port, pid });
  } catch (err) {
    const message = (err as Error).message;
    logger.error(`[NativeCopy] Start failed: ${message}`);
    res.status(400).json({ error: message });
  }
});

router.post('/stop', async (_req, res) => {
  try {
    await nativeCopyManager.stop();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/status', (_req, res) => {
  res.json(nativeCopyManager.status());
});

/**
 * SSE log stream. Client opens EventSource and receives `log` events for
 * each new line. Closes naturally on client disconnect.
 */
router.get('/logs', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let lastTs = 0;
  const sinceParam = Number(req.query.since);
  if (Number.isFinite(sinceParam) && sinceParam > 0) lastTs = sinceParam;

  const push = () => {
    const lines = nativeCopyManager.logsSince(lastTs);
    for (const line of lines) {
      if (line.ts > lastTs) lastTs = line.ts;
      res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
    }
    const status = nativeCopyManager.status();
    res.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
  };

  push();
  const interval = setInterval(push, 1000);

  req.on('close', () => {
    clearInterval(interval);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  });
});

export default router;
