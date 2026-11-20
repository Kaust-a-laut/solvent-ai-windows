import { Worker, QueueEvents, Queue, Processor } from 'bullmq';
import { indexProjectJob } from './jobs/indexProjectJob';
import { memoryMaintenanceJob } from './jobs/memoryMaintenanceJob';
import { imageGenJob } from './jobs/imageGenJob';
import { orchestrationJob } from './jobs/orchestrationJob';
import { TaskQueue } from './services/taskService';
import Redis from 'ioredis';
import { logger } from './utils/logger';
import { pluginManager } from './services/pluginManager';
import { bullMqPrefix, isSidecar } from './utils/sidecarMode';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Health-monitoring Redis connection — BullMQ requires maxRetriesPerRequest: null
// and dedicated connections per Worker / QueueEvents consumer.
const redisConnection = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

function createBullMqConnection(): Redis {
  const conn = redisConnection.duplicate({ maxRetriesPerRequest: null });
  conn.on('error', () => {
    // Handled by main client logging and per-consumer error listeners
  });
  return conn;
}

let redisDegraded = false;
redisConnection.on('error', (err) => {
  if (!redisDegraded) {
    redisDegraded = true;
    logger.warn(`[Worker] Redis unreachable — worker idle until it recovers (jobs queued via the server's standalone fallback will run once this process reconnects). ${err.message}`);
  }
});

if (isSidecar) {
  logger.info(`[Worker] Sidecar mode — BullMQ prefix="${bullMqPrefix}"`);
}

// --- Lazy Worker Activation ---
// Workers activate when a job arrives (or if waiting jobs already exist on
// startup/reconnect), then idle after 60s with zero active jobs.

const IDLE_TIMEOUT_MS = 60_000;

interface LazyWorkerHandle {
  worker: Worker | null;
  queueEvents: QueueEvents;
  queueProbe: Queue;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closingPromise: Promise<void> | null;
  pendingReactivate: boolean;
  activeJobs: number;
  queue: string;
  ensureWorker: () => void;
}

const lazyHandles: LazyWorkerHandle[] = [];
let shuttingDown = false;

function createLazyWorker(
  queue: string,
  processor: Processor,
  opts: { concurrency: number }
): LazyWorkerHandle {
  const queueEvents = new QueueEvents(queue, {
    connection: createBullMqConnection(),
    prefix: bullMqPrefix,
  });
  queueEvents.on('error', (err) => {
    logger.debug(`[LazyWorker] QueueEvents error for "${queue}": ${err.message}`);
  });

  const queueProbe = new Queue(queue, {
    connection: createBullMqConnection(),
    prefix: bullMqPrefix,
  });
  queueProbe.on('error', () => {
    // Probe errors are non-fatal
  });

  const handle: LazyWorkerHandle = {
    worker: null,
    queueEvents,
    queueProbe,
    idleTimer: null,
    closingPromise: null,
    pendingReactivate: false,
    activeJobs: 0,
    queue,
    ensureWorker: () => {},
  };

  const scheduleIdle = () => {
    if (shuttingDown || handle.activeJobs > 0) return;
    if (handle.idleTimer) clearTimeout(handle.idleTimer);
    handle.idleTimer = setTimeout(async () => {
      handle.idleTimer = null;
      if (shuttingDown || handle.activeJobs > 0 || !handle.worker || handle.closingPromise) return;
      logger.info(`[LazyWorker] Idling worker for queue "${queue}" after ${IDLE_TIMEOUT_MS / 1000}s inactivity`);
      const workerToClose = handle.worker;
      handle.closingPromise = workerToClose.close()
        .catch((err) => {
          logger.warn(`[LazyWorker] Error idling worker "${queue}": ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          if (handle.worker === workerToClose) {
            handle.worker = null;
          }
          handle.closingPromise = null;
          if (handle.pendingReactivate && !shuttingDown) {
            handle.pendingReactivate = false;
            ensureWorker();
          }
        });
      await handle.closingPromise;
    }, IDLE_TIMEOUT_MS);
  };

  const ensureWorker = () => {
    if (shuttingDown) return;
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer);
      handle.idleTimer = null;
    }

    if (handle.closingPromise) {
      handle.pendingReactivate = true;
      return;
    }

    if (!handle.worker) {
      logger.info(`[LazyWorker] Activating worker for queue "${queue}"`);
      const worker = new Worker(queue, processor, {
        connection: createBullMqConnection(),
        prefix: bullMqPrefix,
        concurrency: opts.concurrency,
      });

      worker.on('error', (err) => {
        logger.warn(`[LazyWorker] Worker error for "${queue}": ${err.message}`);
      });

      worker.on('active', () => {
        handle.activeJobs++;
        if (handle.idleTimer) {
          clearTimeout(handle.idleTimer);
          handle.idleTimer = null;
        }
      });

      worker.on('completed', () => {
        handle.activeJobs = Math.max(0, handle.activeJobs - 1);
        scheduleIdle();
      });

      worker.on('failed', () => {
        handle.activeJobs = Math.max(0, handle.activeJobs - 1);
        scheduleIdle();
      });

      handle.worker = worker;
    }
  };

  handle.ensureWorker = ensureWorker;

  // Listen for waiting jobs to activate the worker on demand
  queueEvents.on('waiting', () => {
    ensureWorker();
  });

  lazyHandles.push(handle);
  return handle;
}

async function checkPendingJobs(): Promise<void> {
  if (shuttingDown) return;
  await Promise.allSettled(lazyHandles.map(async (handle) => {
    try {
      const counts = await handle.queueProbe.getJobCounts('waiting', 'delayed', 'paused');
      if ((counts.waiting ?? 0) > 0 || (counts.delayed ?? 0) > 0) {
        handle.ensureWorker();
      }
    } catch {
      // Redis may not be ready yet
    }
  }));
}

redisConnection.on('ready', () => {
  if (redisDegraded) {
    redisDegraded = false;
    logger.info('[Worker] Redis connection restored — resuming queue processing.');
  }
  void checkPendingJobs();
});

async function startWorkers(): Promise<void> {
  try {
    await pluginManager.initialize();
    logger.info('[Worker] Plugin system initialized successfully');
  } catch (error) {
    logger.error('[Worker] Failed to initialize plugin system:', error);
  }

  // Create lazy workers for each queue after plugins are ready
  const indexingHandle = createLazyWorker(TaskQueue.INDEXING, indexProjectJob, {
    concurrency: 1,
  });

  const memoryGardeningHandle = createLazyWorker(TaskQueue.MEMORY_GARDENING, memoryMaintenanceJob, {
    concurrency: 2,
  });

  const imageGenHandle = createLazyWorker(TaskQueue.IMAGE_GEN, imageGenJob, {
    concurrency: 3,
  });

  const orchestrationHandle = createLazyWorker(TaskQueue.ORCHESTRATION, orchestrationJob, {
    concurrency: 2,
  });

  createLazyWorker(TaskQueue.DEFAULT, async (job) => {
    logger.warn(`[DefaultWorker] Received job of type: ${job.data?.type ?? job.name}. No handler defined.`);
    return { success: true, message: 'No handler for this job type' };
  }, {
    concurrency: 5,
  });

  // BullMQ v5 QueueEvents passes `{ jobId, returnvalue }` / `{ jobId, failedReason }`
  const logQueueEvents = (label: string, handle: LazyWorkerHandle) => {
    handle.queueEvents.on('completed', ({ jobId }) => {
      logger.info(`[Worker] ${label} job ${jobId} completed`);
    });
    handle.queueEvents.on('failed', ({ jobId, failedReason }) => {
      logger.error(`[Worker] ${label} job ${jobId} failed: ${failedReason}`);
    });
  };

  logQueueEvents('Indexing', indexingHandle);
  logQueueEvents('Memory gardening', memoryGardeningHandle);
  logQueueEvents('Image generation', imageGenHandle);
  logQueueEvents('Orchestration', orchestrationHandle);

  logger.info('[Worker] Lazy workers registered and listening for jobs...');

  // Pick up any jobs already waiting in Redis before worker startup
  await checkPendingJobs();
}

void startWorkers();

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Worker] ${signal} received, shutting down workers...`);

  const closePromises: Promise<unknown>[] = [];
  for (const handle of lazyHandles) {
    if (handle.idleTimer) {
      clearTimeout(handle.idleTimer);
      handle.idleTimer = null;
    }
    if (handle.closingPromise) closePromises.push(handle.closingPromise);
    if (handle.worker) closePromises.push(handle.worker.close());
    closePromises.push(handle.queueEvents.close());
    closePromises.push(handle.queueProbe.close());
  }
  closePromises.push(redisConnection.quit().catch(() => redisConnection.disconnect()));

  await Promise.allSettled(closePromises);
  logger.info('[Worker] All workers shut down successfully');
  process.exit(0);
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
