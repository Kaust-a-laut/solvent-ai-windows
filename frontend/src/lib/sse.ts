/**
 * Shared SSE payload extractor for the app's hand-rolled `fetch` + ReadableStream
 * SSE consumers (ChatService.streamMessage, AgentChatPanel, waterfallSlice,
 * collaborateSlice). Owns only the read/decode/line-split/buffer boilerplate —
 * every call site previously reimplemented this loop with minor drift. Callers
 * keep their own JSON.parse and event-type switch exactly as before; this just
 * yields each `data:` line's raw (trimmed, non-empty) payload string in order.
 *
 * All four backend SSE endpoints emit one JSON object per `data:` line, so
 * extracting on `\n` boundaries (rather than waiting for the full blank-line-
 * terminated `\n\n` event block) is equivalent but yields sooner — a payload
 * is complete the moment its line is complete.
 */
export async function* streamSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const extractPayload = (line: string): string | null => {
    if (!line.startsWith('data:')) return null;
    const payload = line.slice('data:'.length).trim();
    return payload || null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const payload = extractPayload(line);
        if (payload) yield payload;
      }
    }
    // Flush a trailing line that never got a final '\n' before the stream closed.
    const trailing = extractPayload(buffer.trim());
    if (trailing) yield trailing;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
