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
// Upper bound on how much of a single string is scanned for secrets — the
// value is truncated to maxBytes afterwards anyway.
const SECRET_SCAN_CHARS = 256 * 1024;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{20,}/g, // OpenAI / Anthropic / Stripe-style
  /\bAKIA[0-9A-Z]{16}\b/g,                                          // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,                                // GitHub tokens
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,                                // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                                      // Google API keys
  /\bhf_[A-Za-z0-9]{30,}\b/g,                                        // Hugging Face tokens
  /\bgsk_[A-Za-z0-9]{30,}\b/g,                                       // Groq keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
];

// `SOME_API_KEY=value` / `"secret": "value"` / `password: value` lines (e.g. .env contents).
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',]{4,})/gi;

/**
 * Replace secret-looking values inside free text — env-file contents read
 * by read_file, tokens pasted into commands, keys echoed in tool output —
 * which key-name based redaction (redactSensitive) can't see.
 */
export function redactSecretStrings(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, '***REDACTED***');
  out = out.replace(SECRET_ASSIGNMENT, (_m, key: string, sep: string) => `${key}${sep}***REDACTED***`);
  return out;
}

function truncateValue(value: unknown, maxBytes: number, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    const byteLen = Buffer.byteLength(value);
    const scanned = redactSecretStrings(value.length > SECRET_SCAN_CHARS ? value.slice(0, SECRET_SCAN_CHARS) : value);
    if (byteLen > maxBytes || value.length > SECRET_SCAN_CHARS) {
      return scanned.slice(0, maxBytes) + `…[truncated, original ${byteLen} bytes]`;
    }
    return scanned;
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
