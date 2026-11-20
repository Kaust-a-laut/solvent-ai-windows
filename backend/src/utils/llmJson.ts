/**
 * Parse JSON out of an LLM completion that was *asked* for JSON but may
 * still wrap it: reasoning models prepend `<think>…</think>`, many models
 * fence it in ```json … ```, and some add a sentence before or after.
 *
 * Throws (like JSON.parse) when no JSON object/array can be recovered.
 */
export function parseLlmJson<T = unknown>(text: string): T {
  let s = String(text ?? '');
  // Closed think blocks anywhere, then an unclosed leading one (truncated output).
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  s = s.replace(/^\s*<think>[\s\S]*$/i, (m) => (m.includes('{') ? m.slice(m.indexOf('{')) : ''));
  s = s.trim();

  const fenced = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(s);
  if (fenced?.[1]) s = fenced[1].trim();

  try {
    return JSON.parse(s) as T;
  } catch (firstErr) {
    // Fall back to the outermost {...} or [...] span.
    const start = s.search(/[[{]/);
    if (start !== -1) {
      const open = s[start]!;
      const close = open === '{' ? '}' : ']';
      const end = s.lastIndexOf(close);
      if (end > start) {
        return JSON.parse(s.slice(start, end + 1)) as T;
      }
    }
    throw firstErr;
  }
}
