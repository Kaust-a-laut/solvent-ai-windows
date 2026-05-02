import { describe, it, expect, vi, beforeEach } from 'vitest';

// SSRF guard would otherwise reject the test URLs before the mocked axios is
// even called. We replace safeAxiosGet with a thin shim around the mocked
// axios.get so the original happy/error-path assertions still apply.
const mockAxiosGet = vi.fn();
vi.mock('axios', () => ({ default: { get: mockAxiosGet }, get: mockAxiosGet }));
vi.mock('../utils/urlSafety', () => ({
  UrlSafetyError: class UrlSafetyError extends Error {},
  safeAxiosGet: (url: string, opts: unknown) => mockAxiosGet(url, opts),
  assertSafeUrl: vi.fn(),
}));

describe('toolService fetch_preview_source', () => {
  beforeEach(() => {
    mockAxiosGet.mockReset();
  });

  it('returns html content for a valid URL', async () => {
    mockAxiosGet.mockResolvedValue({
      data: '<html><body><h1>Hello</h1></body></html>',
    });

    const { toolService } = await import('./toolService');
    const result = await toolService.executeTool('fetch_preview_source', { url: 'http://example.com/' }) as Record<string, unknown>;
    expect(result.html).toContain('<h1>Hello</h1>');
    expect(result.url).toBe('http://example.com/');
  });

  it('returns error object when fetch fails', async () => {
    mockAxiosGet.mockRejectedValue(new Error('Connection refused'));

    const { toolService } = await import('./toolService');
    const result = await toolService.executeTool('fetch_preview_source', { url: 'http://example.com/' }) as Record<string, unknown>;
    expect(result.error).toContain('Connection refused');
  });

  it('rejects non-http URLs', async () => {
    const { toolService } = await import('./toolService');
    const result = await toolService.executeTool('fetch_preview_source', { url: 'file:///etc/passwd' }) as Record<string, unknown>;
    expect(result.error).toContain('Invalid URL');
  });
});
