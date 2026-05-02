import { ZodIssue } from 'zod';

const SENSITIVE_KEY_RE = /apikey|api_keys|api-key|secret|token|authorization|password|credential/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => redactSensitive(item));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_RE.test(key) ? '***REDACTED***' : redactSensitive(nested);
    }
    return output;
  }
  return value;
}

export function requestBodySummary(body: unknown, issues: ZodIssue[] = []): Record<string, unknown> {
  const keys = body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body as Record<string, unknown>)
    : [];
  const payloadSize = Buffer.byteLength(JSON.stringify(redactSensitive(body ?? null)));
  return {
    keys,
    payloadSize,
    issuePaths: issues.map(issue => issue.path.join('.')).filter(Boolean),
  };
}

const DEFAULT_MAX_FIELD_BYTES = 2048;

function truncateValue(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > maxBytes) {
      return value.slice(0, maxBytes) + `…[truncated, original ${Buffer.byteLength(value)} bytes]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => truncateValue(item, maxBytes));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateValue(v, maxBytes);
    }
    return out;
  }
  return value;
}

export function safeForAudit(value: unknown, maxBytes: number = DEFAULT_MAX_FIELD_BYTES): unknown {
  return truncateValue(redactSensitive(value), maxBytes);
}
