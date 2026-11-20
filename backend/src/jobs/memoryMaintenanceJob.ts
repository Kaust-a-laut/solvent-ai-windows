import { Job } from 'bullmq';
import { memoryConsolidationService } from '../services/memoryConsolidationService';
import { logger } from '../utils/logger';

export interface MemoryMaintenanceJobData {
  type?: string;
  data?: unknown;
}

export async function memoryMaintenanceJob(job: Job<MemoryMaintenanceJobData>): Promise<unknown> {
  const jobType = job.data?.type || job.name;
  // BullMQ passes `{ type, data }` while standalone TaskService passes `data` directly
  const payload = (
    job.data && typeof job.data === 'object' && 'data' in job.data && job.data.data && typeof job.data.data === 'object'
      ? job.data.data
      : job.data
  ) as Record<string, unknown> | undefined;

  // Route to the appropriate handler based on job type
  switch (jobType) {
    case 'memory-consolidation': {
      const mode = payload?.mode as string | undefined;
      const messages = (payload?.messages ?? []) as import('../types/ai').ChatMessage[];
      logger.info(`[MemoryMaintenanceJob] Running consolidation for mode: ${mode}`);
      await memoryConsolidationService.consolidateSession(mode ?? 'default', messages);
      return { success: true, type: 'consolidation', completedAt: new Date().toISOString() };
    }

    case 'memory-extraction': {
      const content = payload?.content as string | undefined;
      logger.info('[MemoryMaintenanceJob] Running knowledge extraction');
      await memoryConsolidationService.extractKnowledge(content ?? '');
      return { success: true, type: 'extraction', completedAt: new Date().toISOString() };
    }

    default: {
      // Original maintenance flow (runAmnesiaCycle already runs compressOlderMemories internally)
      logger.info('[MemoryMaintenanceJob] Starting memory maintenance...');

      try {
        await job.updateProgress(10);
        await memoryConsolidationService.runAmnesiaCycle();
        await job.updateProgress(100);

        logger.info('[MemoryMaintenanceJob] Completed memory maintenance');
        return {
          success: true,
          message: 'Memory maintenance completed successfully',
          completedAt: new Date().toISOString()
        };
      } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('[MemoryMaintenanceJob] Failed memory maintenance', error);
        throw new Error(`Memory maintenance failed: ${err.message}`);
      }
    }
  }
}