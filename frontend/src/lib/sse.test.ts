import { describe, it, expect } from 'vitest';
import { streamSSE } from './sse';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i]));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const payload of streamSSE(stream)) out.push(payload);
  return out;
}

describe('streamSSE', () => {
  it('extracts one payload per data: line', async () => {
    const stream = streamFromChunks(['data: {"a":1}\n\ndata: {"a":2}\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('reassembles a data: line split across multiple chunks', async () => {
    const stream = streamFromChunks(['data: {"a":', '1}\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it('ignores blank lines and non-data lines', async () => {
    const stream = streamFromChunks(['event: ping\n\ndata: {"a":1}\n\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it('skips empty data: payloads', async () => {
    const stream = streamFromChunks(['data:\n\ndata: {"a":1}\n\n']);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it('flushes a trailing data: line with no final newline', async () => {
    const stream = streamFromChunks(['data: {"a":1}']);
    expect(await collect(stream)).toEqual(['{"a":1}']);
  });

  it('accepts both "data:x" and "data: x" forms', async () => {
    const stream = streamFromChunks(['data:{"a":1}\ndata: {"a":2}\n']);
    expect(await collect(stream)).toEqual(['{"a":1}', '{"a":2}']);
  });

  it('yields nothing for an empty stream', async () => {
    const stream = streamFromChunks([]);
    expect(await collect(stream)).toEqual([]);
  });
});
