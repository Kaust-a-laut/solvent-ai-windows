import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TaskService, TaskQueue } from './taskService';

// Mock the dynamic processor imports so they don't load the real job modules during tests
vi.mock('../jobs/indexProjectJob', () => ({
  indexProjectJob: vi.fn(async (job) => {
    await job.updateProgress(50);
    return { success: true, processed: job.data };
  })
}));

// The Redis client fails asynchronously; poll until the service flips over
// instead of sleeping a fixed amount (flaky on slow machines).
async function waitForStandalone(svc: TaskService, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((svc as any).isStandalone) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('Standalone mode was not activated within timeout');
}

describe('TaskService Standalone Fallback', () => {
  let taskServiceInstance: TaskService;

  beforeEach(() => {
    // Instantiate a separate TaskService targeting a bad Redis URL to force standalone
    taskServiceInstance = new TaskService('redis://127.0.0.1:9999');
  });

  afterEach(async () => {
    await taskServiceInstance.close();
  });

  it('correctly activates standalone mode on bad Redis connection', async () => {
    await waitForStandalone(taskServiceInstance);
    expect((taskServiceInstance as any).isStandalone).toBe(true);
  });

  it('correctly dispatches a job and runs processor locally in standalone mode', async () => {
    await waitForStandalone(taskServiceInstance);
    const qEvents = taskServiceInstance.getQueueEvents(TaskQueue.INDEXING);

    // Set up promises to listen for the lifecycle events
    const completedPromise = new Promise<{ jobId: string; returnvalue: any }>((resolve) => {
      qEvents.on('completed', (data: { jobId: string; returnvalue: any }) => {
        resolve(data);
      });
    });

    const progressPromise = new Promise<{ jobId: string; data: number }>((resolve) => {
      qEvents.on('progress', (data: { jobId: string; data: number }) => {
        if (data.data === 50) {
          resolve(data);
        }
      });
    });

    const jobId = await taskServiceInstance.dispatchJob(
      TaskQueue.INDEXING,
      'test-job',
      { type: 'test-job', data: { path: '/test/path' } }
    );

    expect(jobId.startsWith('local_')).toBe(true);

    const statusBefore = await taskServiceInstance.getJobStatus(jobId);
    expect(statusBefore.status).toBe('active');

    // Wait for progress and completion
    const progressData = await progressPromise;
    expect(progressData.jobId).toBe(jobId);
    expect(progressData.data).toBe(50);

    const completionData = await completedPromise;
    expect(completionData.jobId).toBe(jobId);
    expect(completionData.returnvalue.success).toBe(true);
    expect(completionData.returnvalue.processed.path).toBe('/test/path');

    const statusAfter = await taskServiceInstance.getJobStatus(jobId);
    expect(statusAfter.status).toBe('completed');
    expect(statusAfter.progress).toBe(100);
    expect((statusAfter.result as any).success).toBe(true);
  });

  it('keeps listeners attached across the Redis→standalone transition', async () => {
    // Attach to the facade BEFORE standalone mode activates (mirrors what
    // server.ts does at startup with the mission-progress bridge).
    const qEvents = taskServiceInstance.getQueueEvents(TaskQueue.INDEXING);
    const completedPromise = new Promise<{ jobId: string }>((resolve) => {
      qEvents.on('completed', (data: { jobId: string }) => resolve(data));
    });

    await waitForStandalone(taskServiceInstance);

    const jobId = await taskServiceInstance.dispatchJob(
      TaskQueue.INDEXING,
      'bridge-job',
      { type: 'bridge-job', data: {} }
    );

    const completed = await completedPromise;
    expect(completed.jobId).toBe(jobId);
  });
});
