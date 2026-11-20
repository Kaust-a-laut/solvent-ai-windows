import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import v8 from 'node:v8';
import axios from 'axios';
import { config } from '../config';
import { storageService } from '../services/storageService';
import { modelAvailabilityService } from '../services/modelAvailabilityService';

const router = Router();

interface HealthCheckResult {
  status: 'ok' | 'unhealthy';
  checks: {
    storage: { status: 'ok' | 'unhealthy'; message?: string };
    ollama: { status: 'ok' | 'unhealthy' | 'disabled'; message?: string };
    memory: { status: 'ok' | 'unhealthy'; message?: string };
  };
  timestamp: string;
}

router.get('/health', async (req: Request, res: Response) => {
  res.setHeader('x-request-id', req.id || '');
  const result: HealthCheckResult = {
    status: 'ok',
    checks: {
      storage: { status: 'ok' },
      ollama: { status: config.ENABLE_OLLAMA ? 'ok' : 'disabled' },
      memory: { status: 'ok' },
    },
    timestamp: new Date().toISOString(),
  };

  // Verify storageService is functional with an isolated per-request key
  try {
    const testKey = `__health_check__:${req.id || randomUUID()}`;
    await storageService.set(testKey, true, 10);
    const val = await storageService.get<boolean>(testKey);
    if (val !== true) {
      throw new Error('Storage read-back mismatch');
    }
    await storageService.del(testKey);
  } catch (error) {
    result.checks.storage.status = 'unhealthy';
    result.checks.storage.message = error instanceof Error ? error.message : 'Storage check failed';
    result.status = 'unhealthy';
  }

  if (config.ENABLE_OLLAMA) {
    try {
      await axios.get(`${config.OLLAMA_HOST}/api/tags`, { timeout: 5000 });
    } catch (error) {
      result.checks.ollama.status = 'unhealthy';
      result.checks.ollama.message = error instanceof Error ? error.message : 'Ollama unavailable';
      result.status = 'unhealthy';
    }
  } else {
    result.checks.ollama.message = 'Ollama disabled via ENABLE_OLLAMA=false';
  }

  // Compare heapUsed against V8's actual heap_size_limit, not dynamic heapTotal
  // (heapTotal routinely sits at 90-97% before V8 grows or runs GC).
  const heapUsed = process.memoryUsage().heapUsed;
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  if (heapLimit > 0 && heapUsed >= heapLimit * 0.9) {
    result.checks.memory.status = 'unhealthy';
    result.checks.memory.message = `Heap usage: ${Math.round((heapUsed / heapLimit) * 100)}% of limit`;
    result.status = 'unhealthy';
  }

  res.status(result.status === 'ok' ? 200 : 503).json(result);
});

router.get('/ready', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ready', timestamp: new Date().toISOString() });
});

// Model availability for waterfall presets — scanned on startup
router.get('/health/models', (_req: Request, res: Response) => {
  const scan = modelAvailabilityService.getLastScan();
  if (!scan) {
    return res.json({ status: 'pending', message: 'Scan not yet completed' });
  }
  res.json(scan);
});

export default router;
