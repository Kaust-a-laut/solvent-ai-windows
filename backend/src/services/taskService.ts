import { Queue, Worker, Job, JobsOptions, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { bullMqPrefix } from '../utils/sidecarMode';
import { EventEmitter } from 'events';

export enum TaskQueue {
  DEFAULT = 'default',
  INDEXING = 'indexing',
  MEMORY_GARDENING = 'memory_gardening',
  IMAGE_GEN = 'image_gen',
  ORCHESTRATION = 'orchestration'
}

export interface TaskPayload {
  type: string;
  data: Record<string, unknown>;
}

export interface TaskResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

// Stable per-queue event surface. The server's mission-progress bridge (and
// any other listener) attaches to this facade once; in Redis mode the real
// BullMQ QueueEvents is piped into it, and in standalone mode local jobs emit
// into it directly — so listeners survive the Redis→standalone transition.
export class TaskQueueEvents extends EventEmitter {
  constructor(public queueName: string) {
    super();
  }
  async close() {
    this.removeAllListeners();
  }
}

// Local mock Job interface for offline/standalone execution
export class LocalJob {
  public progressValue: number = 0;
  public returnvalue: any = undefined;
  public failedReason: string | undefined = undefined;

  constructor(
    public id: string,
    public name: string,
    public data: any,
    private queueName: TaskQueue,
    private onProgress: (progress: number) => void
  ) {}

  async updateProgress(progress: number) {
    this.progressValue = progress;
    this.onProgress(progress);
  }

  get progress(): number {
    return this.progressValue;
  }
}

export class TaskService {
  private redis!: Redis;
  private queues: Map<TaskQueue, Queue> = new Map();
  private workers: Map<TaskQueue, Worker> = new Map();
  private queueEvents: Map<TaskQueue, QueueEvents> = new Map();
  
  // Stable event facades returned by getQueueEvents() — survive mode changes.
  private eventFacades: Map<TaskQueue, TaskQueueEvents> = new Map();
  // Connections warming up for deferred QueueEvents creation (see getQueueEvents).
  private pendingQueueEventConns: Map<TaskQueue, Redis> = new Map();

  // Standalone mode fields
  private isStandalone = false;
  private localJobs: Map<string, { job: LocalJob; status: string; queueName: TaskQueue; result?: any; error?: string }> = new Map();
  private readonly MAX_LOCAL_JOBS = 200;

  constructor(redisUrl: string = 'redis://127.0.0.1:6379') {
    // Attempt standard Redis setup
    try {
      this.redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 1, // Don't spam retries infinitely in dev/standalone
        enableOfflineQueue: false
      });

      this.redis.on('error', (err) => {
        if (!this.isStandalone) {
          logger.warn(`[TaskService] Redis connection failed, falling back to offline standalone mode: ${err.message}`);
          this.activateStandaloneMode();
        }
      });

      // Initialize all queues
      Object.values(TaskQueue).forEach(queueName => {
        // Capped retries: the standalone fallback latches on the first main-
        // client error and never returns to Redis mode, so endless reconnect
        // attempts after that are pure waste (and log spam).
        const dupConn = this.redis.duplicate({
          retryStrategy: (times) => (times > 5 ? null : Math.min(times * 500, 2000)),
        });
        dupConn.on('error', () => {
          // Silent duplicate error events — handled by main client error transition
        });

        this.queues.set(queueName, new Queue(queueName, {
          connection: dupConn,
          prefix: bullMqPrefix,
          defaultJobOptions: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000,
            },
            removeOnComplete: true,
            removeOnFail: {
              age: 24 * 3600,
            },
          }
        }));
      });
    } catch (err: any) {
      logger.warn(`[TaskService] Failed to establish Redis client, launching in standalone mode: ${err.message}`);
      this.activateStandaloneMode();
    }
  }

  private activateStandaloneMode() {
    if (this.isStandalone) return;
    this.isStandalone = true;

    // Gracefully disconnect main Redis client
    if (this.redis) {
      try {
        this.redis.disconnect();
      } catch {}
    }

    // Force-disconnect partially initialized queues and QueueEvents.
    // close() waits for readiness and hangs forever when Redis never
    // connected, leaving BullMQ's internal clients reconnecting every ~2s
    // (BullMQ overrides any ioredis retryStrategy we pass); disconnect()
    // drops the sockets immediately. The facades stay alive; standalone
    // jobs keep emitting into them, so listeners attached before the
    // transition continue to receive events.
    for (const queue of this.queues.values()) {
      try {
        queue.disconnect().catch(() => {});
      } catch {}
    }
    this.queues.clear();

    for (const qe of this.queueEvents.values()) {
      try {
        qe.disconnect().catch(() => {});
      } catch {}
    }
    this.queueEvents.clear();

    // Drop connections still warming up for deferred QueueEvents creation.
    for (const conn of this.pendingQueueEventConns.values()) {
      try {
        conn.disconnect();
      } catch {}
    }
    this.pendingQueueEventConns.clear();
    logger.info('[TaskService] Offline Standalone Mode fully activated successfully.');
  }

  getQueue(queueName: TaskQueue): Queue {
    if (this.isStandalone) {
      throw new Error(`Queue unavailable in Standalone Mode`);
    }
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    return queue;
  }

  getQueueEvents(queueName: TaskQueue): TaskQueueEvents {
    let facade = this.eventFacades.get(queueName);
    if (!facade) {
      facade = new TaskQueueEvents(queueName);
      this.eventFacades.set(queueName, facade);
    }

    // Redis mode: create the BullMQ QueueEvents only once its connection is
    // actually ready, then pipe its events into the stable facade. BullMQ's
    // close()/disconnect() both await a client promise that never resolves
    // when Redis is unreachable, so a QueueEvents constructed against a dead
    // connection can never be stopped — its internal client reconnects every
    // ~2s forever. Deferring construction until 'ready' avoids that entirely;
    // the capped retryStrategy makes an unreachable Redis give up after ~5s.
    if (!this.isStandalone && !this.queueEvents.has(queueName) && !this.pendingQueueEventConns.has(queueName)) {
      try {
        // QueueEvents uses blocking Redis commands — BullMQ requires
        // maxRetriesPerRequest: null on its connection and throws otherwise
        // (the main client sets 1 for fast standalone fallback).
        const dupConn = this.redis.duplicate({
          maxRetriesPerRequest: null,
          retryStrategy: (times) => (times > 5 ? null : Math.min(times * 500, 2000)),
        });
        dupConn.on('error', () => {}); // Silent — main client handles the mode transition
        this.pendingQueueEventConns.set(queueName, dupConn);

        dupConn.once('ready', () => {
          this.pendingQueueEventConns.delete(queueName);
          if (this.isStandalone || this.queueEvents.has(queueName)) {
            dupConn.disconnect();
            return;
          }
          const qe = new QueueEvents(queueName, { connection: dupConn, prefix: bullMqPrefix });
          qe.on('error', (err) => {
            logger.debug(`[TaskService] QueueEvents ${queueName} connection error: ${err.message}`);
          });
          const pipe = facade;
          for (const event of ['progress', 'completed', 'failed'] as const) {
            (qe as unknown as EventEmitter).on(event, (...args: unknown[]) => {
              pipe.emit(event, ...args);
            });
          }
          this.queueEvents.set(queueName, qe);
        });

        dupConn.once('end', () => {
          // Retries exhausted without ever connecting — drop the pending slot.
          this.pendingQueueEventConns.delete(queueName);
        });
      } catch (err) {
        logger.warn(`[TaskService] Failed to duplicate connection for ${queueName} QueueEvents, falling back to standalone.`);
        this.activateStandaloneMode();
      }
    }
    return facade;
  }

  async dispatchJob(queueName: TaskQueue, jobName: string, payload: TaskPayload, opts?: JobsOptions): Promise<string> {
    if (this.isStandalone) {
      const jobId = 'local_' + Date.now().toString() + Math.random().toString(36).substr(2, 5);

      this.pruneLocalJobs();
      const events = this.getQueueEvents(queueName);
      const onProgress = (p: number) => {
        events.emit('progress', { jobId, data: p });
      };

      const localJob = new LocalJob(jobId, jobName, payload.data, queueName, onProgress);
      this.localJobs.set(jobId, {
        job: localJob,
        status: 'active',
        queueName
      });

      // Process dynamically in the background to avoid circular dependencies
      setImmediate(async () => {
        try {
          const processor = await this.getLocalProcessor(queueName);
          if (!processor) {
            throw new Error(`No local processor registered for queue ${queueName}`);
          }

          await localJob.updateProgress(5);
          const result = await processor(localJob);

          const entry = this.localJobs.get(jobId);
          if (entry) {
            entry.status = 'completed';
            entry.result = result;
          }

          await localJob.updateProgress(100);

          events.emit('completed', { jobId, returnvalue: result });
        } catch (err: any) {
          logger.error(`[TaskService] Local job ${jobName} failed:`, err);
          const entry = this.localJobs.get(jobId);
          if (entry) {
            entry.status = 'failed';
            entry.error = err.message || String(err);
          }

          events.emit('failed', { jobId, failedReason: err.message || String(err) });
        }
      });

      logger.info(`[TaskService] Local job ${jobName} dispatched in standalone fallback with ID ${jobId}`);
      return jobId;
    }

    const queue = this.getQueue(queueName);
    const job = await queue.add(jobName, payload, opts);
    logger.info(`[TaskService] Dispatched job ${jobName} to queue ${queueName} with ID ${job.id}`);
    return job.id!;
  }

  // Standalone jobs are kept for status queries; prune oldest finished ones
  // so the map doesn't grow unbounded across a long session.
  private pruneLocalJobs(): void {
    if (this.localJobs.size < this.MAX_LOCAL_JOBS) return;
    for (const [id, entry] of this.localJobs) {
      if (this.localJobs.size < this.MAX_LOCAL_JOBS) break;
      if (entry.status === 'completed' || entry.status === 'failed') {
        this.localJobs.delete(id);
      }
    }
  }

  private async getLocalProcessor(queueName: TaskQueue): Promise<Function | null> {
    try {
      switch (queueName) {
        case TaskQueue.INDEXING: {
          const { indexProjectJob } = await import('../jobs/indexProjectJob');
          return indexProjectJob;
        }
        case TaskQueue.MEMORY_GARDENING: {
          const { memoryMaintenanceJob } = await import('../jobs/memoryMaintenanceJob');
          return memoryMaintenanceJob;
        }
        case TaskQueue.IMAGE_GEN: {
          const { imageGenJob } = await import('../jobs/imageGenJob');
          return imageGenJob;
        }
        case TaskQueue.ORCHESTRATION: {
          const { orchestrationJob } = await import('../jobs/orchestrationJob');
          return orchestrationJob;
        }
        default:
          return null;
      }
    } catch (err) {
      logger.error(`[TaskService] Failed to load local job processor dynamically:`, err);
      return null;
    }
  }

  async dispatchIndexingJob(projectPath: string, opts?: JobsOptions): Promise<string> {
    return this.dispatchJob(
      TaskQueue.INDEXING,
      'index-project',
      { type: 'index-project', data: { projectPath } },
      opts
    );
  }

  async dispatchMemoryMaintenanceJob(opts?: JobsOptions): Promise<string> {
    return this.dispatchJob(
      TaskQueue.MEMORY_GARDENING,
      'memory-maintenance',
      { type: 'memory-maintenance', data: {} },
      opts
    );
  }

  async enqueueMemoryJob(jobType: 'consolidation' | 'extraction', data: Record<string, unknown>): Promise<string> {
    return this.dispatchJob(
      TaskQueue.MEMORY_GARDENING,
      `memory-${jobType}`,
      { type: `memory-${jobType}`, data },
      { attempts: 3, backoff: { type: 'exponential', delay: 2000 } }
    );
  }

  async dispatchImageGenerationJob(prompt: string, model?: string, opts?: JobsOptions): Promise<string> {
    return this.dispatchJob(
      TaskQueue.IMAGE_GEN,
      'image-generation',
      { type: 'image-generation', data: { prompt, model } },
      opts
    );
  }

  async dispatchOrchestrationJob(
    templateId: string,
    goal: string,
    template: unknown,
    options?: { providerOverride?: string; modelOverride?: string },
    opts?: JobsOptions
  ): Promise<string> {
    return this.dispatchJob(
      TaskQueue.ORCHESTRATION,
      'orchestration-mission',
      {
        type: 'orchestration-mission',
        data: {
          templateId,
          goal,
          template,
          providerOverride: options?.providerOverride,
          modelOverride: options?.modelOverride
        }
      },
      opts
    );
  }

  async getJobStatus(jobId: string): Promise<{ status: string; progress: number; result?: unknown; error?: string }> {
    if (this.isStandalone || jobId.startsWith('local_')) {
      const entry = this.localJobs.get(jobId);
      if (entry) {
        return {
          status: entry.status,
          progress: entry.job.progressValue,
          result: entry.result,
          error: entry.error
        };
      }
      return {
        status: 'unknown',
        progress: 0
      };
    }

    for (const queue of this.queues.values()) {
      const job = await queue.getJob(jobId);
      if (job) {
        const state = await job.getState();
        const progress = typeof job.progress === 'number' ? job.progress : (state === 'completed' || state === 'failed' ? 100 : 0);

        return {
          status: state,
          progress,
          result: state === 'completed' ? job.returnvalue : undefined,
          error: state === 'failed' ? job.failedReason : undefined,
        };
      }
    }
    
    return {
      status: 'unknown',
      progress: 0
    };
  }

  async scheduleMaintenance(opts?: JobsOptions): Promise<string> {
    return this.dispatchJob(
      TaskQueue.MEMORY_GARDENING,
      'scheduled-maintenance',
      { type: 'scheduled-maintenance', data: {} },
      { 
        ...opts,
        delay: 5000
      }
    );
  }

  async close(): Promise<void> {
    logger.info('[TaskService] Closing all workers and connections...');
    
    for (const facade of this.eventFacades.values()) {
      await facade.close();
    }
    this.eventFacades.clear();

    if (this.isStandalone) {
      this.localJobs.clear();
      logger.info('[TaskService] Standalone task state cleared.');
      return;
    }

    for (const worker of this.workers.values()) {
      await worker.close();
    }

    for (const queueEvents of this.queueEvents.values()) {
      await queueEvents.close();
    }

    for (const queue of this.queues.values()) {
      await queue.close();
    }

    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        this.redis.disconnect();
      }
    }
    
    logger.info('[TaskService] All connections closed.');
  }
}

export const taskService = new TaskService();