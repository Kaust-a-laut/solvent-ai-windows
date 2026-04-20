import type { Request, Response } from 'express';

export interface SSEWriter {
  send: (payload: unknown) => void;
  end: () => void;
  signal: AbortSignal;
}

export function createSSEWriter(req: Request, res: Response): SSEWriter {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const controller = new AbortController();
  let ended = false;

  req.on('close', () => {
    controller.abort();
    if (!ended) {
      ended = true;
      res.end();
    }
  });

  return {
    send(payload) {
      if (controller.signal.aborted || ended) return;
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    },
    end() {
      if (ended) return;
      ended = true;
      if (!controller.signal.aborted) res.end();
    },
    signal: controller.signal,
  };
}
