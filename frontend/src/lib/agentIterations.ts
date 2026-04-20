import type { AgentMessage, AgentIteration, ToolEvent } from '../store/codingSlice';

/**
 * Reconstruct per-iteration groupings from an AgentMessage.
 *
 * When `msg.iterations` is populated, it is returned verbatim (authoritative).
 * Otherwise tool events are grouped by their `iteration` index — the final
 * content is attached to the last bucket, or a solo bucket is created if
 * there were no tools at all.
 */
export function reconstructIterations(msg: AgentMessage): AgentIteration[] {
  if (msg.iterations && msg.iterations.length > 0) return msg.iterations;

  const map = new Map<number, ToolEvent[]>();
  for (const e of msg.toolEvents ?? []) {
    const list = map.get(e.iteration) ?? [];
    list.push(e);
    map.set(e.iteration, list);
  }
  const indices = Array.from(map.keys()).sort((a, b) => a - b);
  const result: AgentIteration[] = indices.map(i => ({ index: i, text: '', toolEvents: map.get(i)! }));

  if (result.length > 0) {
    result[result.length - 1]!.text = msg.content;
  } else {
    result.push({ index: 0, text: msg.content, toolEvents: [] });
  }
  return result;
}
