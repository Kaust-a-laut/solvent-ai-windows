import { Job } from 'bullmq';
import { aiService } from '../services/aiService';
import { logger } from '../utils/logger';

export interface ImageGenJobData {
  prompt: string;
  model?: string;
}

export async function imageGenJob(job: Job<ImageGenJobData | { type?: string; data?: ImageGenJobData }>): Promise<unknown> {
  const raw = job.data as unknown as { data?: ImageGenJobData } & Partial<ImageGenJobData>;
  const payload = (raw?.data && typeof raw.data === 'object' ? raw.data : raw) as Partial<ImageGenJobData>;
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  const model = payload?.model;

  if (!prompt) {
    throw new Error('Image generation failed: missing prompt in job payload');
  }

  const promptPreview = prompt.substring(0, 50);
  logger.info(`[ImageGenJob] Starting image generation for prompt: ${promptPreview}...`);

  try {
    // Report initial progress
    await job.updateProgress(10);

    // Generate the image using aiService
    const result = await aiService.generateImage(prompt, model);

    // Report completion
    await job.updateProgress(100);

    logger.info(`[ImageGenJob] Completed image generation for prompt: ${promptPreview}...`);

    return {
      success: true,
      imageUrl: result.imageUrl,
      fileName: result.fileName,
      info: result.info,
      generatedAt: new Date().toISOString()
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`[ImageGenJob] Failed image generation for prompt: ${promptPreview}...`, error);

    // Throw error to mark job as failed
    throw new Error(`Image generation failed: ${err.message}`);
  }
}