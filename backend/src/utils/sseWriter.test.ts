import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createSSEWriter } from './sseWriter';
import type { Request, Response } from 'express';

function makeMocks(writeReturn: boolean | ((p: string) => boolean)) {
  const req = new EventEmitter() as unknown as Request;
  const res = new EventEmitter() as unknown as Response;
  // Required headers stubs
  (res as unknown as { setHeader: (k: string, v: string) => void }).setHeader = vi.fn();
  (res as unknown as { flushHeaders?: () => void }).flushHeaders = vi.fn();
  (res as unknown as { end: () => void }).end = vi.fn();
  const calls: string[] = [];
  (res as unknown as { write: (p: string) => boolean }).write = (p: string) => {
    calls.push(p);
    return typeof writeReturn === 'function' ? writeReturn(p) : writeReturn;
  };
  return { req, res, calls };
}

describe('createSSEWriter — backpressure', () => {
  it('reports not backpressured when writes succeed', () => {
    const { req, res } = makeMocks(true);
    const sse = createSSEWriter(req, res);
    sse.send({ a: 1 });
    sse.send({ b: 2 });
    expect(sse.isBackpressured).toBe(false);
  });

  it('flips to backpressured when res.write returns false and resolves on drain', async () => {
    const { req, res } = makeMocks(false);
    const sse = createSSEWriter(req, res);
    sse.send({ a: 1 });
    expect(sse.isBackpressured).toBe(true);
    const flushedP = sse.flushed();

    // simulate kernel buffer draining
    (res as unknown as EventEmitter).emit('drain');
    await flushedP;

    expect(sse.isBackpressured).toBe(false);
    // After drain, flushed() resolves immediately again until next stall.
    await sse.flushed();
  });

  it('flushed() resolves on close as well so awaiters never hang', async () => {
    const { req, res } = makeMocks(false);
    const sse = createSSEWriter(req, res);
    sse.send({ a: 1 });
    const flushedP = sse.flushed();
    (res as unknown as EventEmitter).emit('close');
    await flushedP; // would hang without the close fallback
  });

  it('does not write after the request is closed', () => {
    const { req, res, calls } = makeMocks(true);
    const sse = createSSEWriter(req, res);
    (req as unknown as EventEmitter).emit('close');
    sse.send({ ignored: true });
    expect(calls).toHaveLength(0);
  });
});
