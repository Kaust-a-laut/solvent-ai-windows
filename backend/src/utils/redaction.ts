import { ZodIssue } from 'zod';

const SENSITIVE_KEY_RE = /api[_-]?keys?|secret|token|authorization|password|credential/i;

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map(item => redactSensitive(item, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_RE.test(key) ? '***REDACTED***' : redactSensitive(nested, seen);
    }
    return output;
  }
  return value;
}

export function requestBodySummary(body: unknown, issues: ZodIssue[] = []): Record<string, unknown> {
  const keys = body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body as Record<string, unknown>)
    : [];
  let payloadSize = 0;
  try {
    payloadSize = Buffer.byteLength(JSON.stringify(redactSensitive(body ?? null)) ?? '');
  } catch {
    payloadSize = -1;
  }
  return {
    keys,
    payloadSize,
    issuePaths: issues.map(issue => issue.path.join('.')).filter(Boolean),
  };
}

const DEFAULT_MAX_FIELD_BYTES = 2048;

function truncateValue(value: unknown, maxBytes: number, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    const byteLen = Buffer.byteLength(value);
    if (byteLen > maxBytes) {
      return value.slice(0, maxBytes) + `…[truncated, original ${byteLen} bytes]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    return value.map(item => truncateValue(item, maxBytes, seen));
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateValue(v, maxBytes, seen);
    }
    return out;
  }
  return value;
}

export function safeForAudit(value: unknown, maxBytes: number = DEFAULT_MAX_FIELD_BYTES): unknown {
  return truncateValue(redactSensitive(value), maxBytes);
}
