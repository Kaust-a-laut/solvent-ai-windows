import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from './logger';

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts api-key-shaped strings in messages', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('key=sk-abcdefghijklmnopqrstuvwxyz0123456789');
    expect(spy).toHaveBeenCalledOnce();
    const out = (spy.mock.calls[0]?.[0] ?? '') as string;
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
  });

  it('redacts sensitive context keys', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('hello', { apiKey: 'super-secret-value', user: 'alice' });
    const out = (spy.mock.calls[0]?.[0] ?? '') as string;
    expect(out).toContain('***REDACTED***');
    expect(out).not.toContain('super-secret-value');
    expect(out).toContain('alice');
  });

  it('accepts a thunk and only invokes it when the level emits', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const thunk = vi.fn(() => ({ heavy: 'snapshot' }));
    logger.debug('suppressed', thunk);
    expect(thunk).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();

    process.env.NODE_ENV = 'development';
    logger.debug('emitted', thunk);
    expect(thunk).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledOnce();

    process.env.NODE_ENV = prev;
  });

  it('survives a thunk that throws', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('hi', () => { throw new Error('boom'); });
    const out = (spy.mock.calls[0]?.[0] ?? '') as string;
    expect(out).toContain('<context thunk threw>');
  });
});
