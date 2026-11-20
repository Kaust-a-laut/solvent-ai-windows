export class ProviderSemaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  private readonly maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = Number.isFinite(maxConcurrent) && maxConcurrent >= 1
      ? Math.floor(maxConcurrent)
      : 1;
  }

  get pending(): number {
    return this.queue.length;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}
