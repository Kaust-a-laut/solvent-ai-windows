import { describe, it, expect } from 'vitest';
import { redactSensitive, requestBodySummary, safeForAudit } from './redaction';

describe('redaction helpers', () => {
  it('redacts sensitive nested keys', () => {
    expect(redactSensitive({
      apiKeys: { gemini: 'secret-value' },
      nested: { token: 'abc', safe: 'visible' },
    })).toEqual({
      apiKeys: '***REDACTED***',
      nested: { token: '***REDACTED***', safe: 'visible' },
    });
  });

  it('summarizes request bodies without exposing values', () => {
    const summary = requestBodySummary({ provider: 'x', apiKey: 'secret' });
    expect(summary.keys).toEqual(['provider', 'apiKey']);
    expect(JSON.stringify(summary)).not.toContain('secret');
  });

  it('safeForAudit redacts and truncates large fields', () => {
    const huge = 'x'.repeat(10_000);
    const result = safeForAudit({ apiKey: 'secret', body: huge }, 256) as Record<string, unknown>;
    expect(result.apiKey).toBe('***REDACTED***');
    expect(typeof result.body).toBe('string');
    expect((result.body as string).length).toBeLessThan(huge.length);
    expect((result.body as string)).toContain('truncated');
  });
});
