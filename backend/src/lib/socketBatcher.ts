import { Server } from 'socket.io';

export class SocketBatcher {
  private pending: Map<string, unknown[]> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private io: Server;
  private batchWindowMs: number;

  constructor(io: Server, batchWindowMs = 100) {
    this.io = io;
    this.batchWindowMs = batchWindowMs;
  }

  emit(event: string, data: unknown) {
    const queue = this.pending.get(event) || [];
    queue.push(data);
    this.pending.set(event, queue);
    this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.flush();
    }, this.batchWindowMs);
  }

  private flush() {
    this.timer = null;
    for (const [event, items] of this.pending.entries()) {
      if (items.length === 1) {
        this.io.emit(event, items[0]);
      } else {
        // Coalesce burst updates per jobId when present so listeners subscribed
        // to `event` receive the latest state without missing updates under an
        // unlisted `:batch` event name.
        const byJobId = new Map<string, unknown>();
        const unkeyed: unknown[] = [];
        for (const item of items) {
          if (item && typeof item === 'object' && 'jobId' in item && typeof (item as { jobId: unknown }).jobId === 'string') {
            byJobId.set((item as { jobId: string }).jobId, item);
          } else {
            unkeyed.push(item);
          }
        }
        for (const latest of byJobId.values()) {
          this.io.emit(event, latest);
        }
        for (const item of unkeyed) {
          this.io.emit(event, item);
        }
      }
    }
    this.pending.clear();
  }

  emitImmediate(event: string, data: unknown) {
    this.io.emit(event, data);
  }

  destroy() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }
}
