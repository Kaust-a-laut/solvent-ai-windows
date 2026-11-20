import type { Request, Response } from 'express';

export interface SSEWriter {
  send: (payload: unknown) => void;
  end: () => void;
  signal: AbortSignal;
  /** True when the underlying socket signaled backpressure on the last write. */
  readonly isBackpressured: boolean;
  /**
   * Resolves when the underlying socket has drained (or immediately if it
   * isn't backpressured). Hot streaming consumers can `await sse.flushed()`
   * between events to avoid unbounded buffering when the client is slow.
   */
  flushed: () => Promise<void>;
}

export function createSSEWriter(req: Request, res: Response): SSEWriter {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const controller = new AbortController();
  let ended = false;
  let backpressured = false;
  let drainPromise: Promise<void> | null = null;

  const onDisconnect = () => {
    if (ended) return;
    ended = true;
    controller.abort();
    if (!res.writableEnded) {
      res.end();
    }
  };

  // On Node.js 16+, POST requests emit req 'close' as soon as the request body
  // finishes reading (req.complete === true), NOT when the client disconnects.
  // Detect real client disconnects via res 'close' (fired before sse.end()),
  // req 'aborted', or req 'close' when the request body was never completed.
  res.on('close', onDisconnect);
  req.on('aborted', onDisconnect);
  req.on('close', () => {
    if (!req.complete) onDisconnect();
  });

  function arm(): void {
    if (drainPromise) return;
    backpressured = true;
    drainPromise = new Promise<void>(resolve => {
      const settle = () => {
        res.off('drain', settle);
        res.off('close', settle);
        backpressured = false;
        drainPromise = null;
        resolve();
      };
      // Either drain or close ends the wait — close should never leave a
      // hanging promise behind.
      res.once('drain', settle);
      res.once('close', settle);
    });
  }

  return {
    send(payload) {
      if (controller.signal.aborted || ended) return;
      const ok = res.write(`data: ${JSON.stringify(payload)}\n\n`);
      if (!ok) arm();
    },
    end() {
      if (ended) return;
      ended = true;
      if (!controller.signal.aborted) res.end();
    },
    signal: controller.signal,
    get isBackpressured() {
      return backpressured;
    },
    flushed() {
      return drainPromise ?? Promise.resolve();
    },
  };
}
