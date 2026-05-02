import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPrivateIp, UrlSafetyError } from './urlSafety';

vi.mock('dns/promises', () => ({
  default: { lookup: vi.fn() },
  lookup: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { get: vi.fn() },
}));

import dns from 'dns/promises';
import axios from 'axios';
import { assertSafeUrl, safeAxiosGet } from './urlSafety';

const mockedLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;
const mockedGet = (axios as unknown as { get: ReturnType<typeof vi.fn> }).get;

describe('isPrivateIp', () => {
  it('flags loopback / private / link-local v4', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('10.0.0.5')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
  });

  it('flags loopback / unique-local / link-local v6', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fd12:3456:789a::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('does not flag public addresses', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedGet.mockReset();
  });

  it('rejects non-http(s) protocols', async () => {
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toBeInstanceOf(UrlSafetyError);
    await expect(assertSafeUrl('ftp://example.com/x')).rejects.toBeInstanceOf(UrlSafetyError);
  });

  it('rejects literal private hostnames without ever calling DNS', async () => {
    await expect(assertSafeUrl('http://localhost/')).rejects.toBeInstanceOf(UrlSafetyError);
    await expect(assertSafeUrl('http://127.0.0.1/')).rejects.toBeInstanceOf(UrlSafetyError);
    await expect(assertSafeUrl('http://[::1]/')).rejects.toBeInstanceOf(UrlSafetyError);
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it('rejects hostnames that resolve to private space (DNS rebinding)', async () => {
    mockedLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    await expect(assertSafeUrl('http://attacker.example.com/')).rejects.toBeInstanceOf(UrlSafetyError);
  });

  it('accepts hostnames that resolve to public space', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertSafeUrl('http://example.com/')).resolves.toBeInstanceOf(URL);
  });
});

describe('safeAxiosGet redirect handling', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedGet.mockReset();
  });

  it('blocks redirects whose target resolves to a private IP', async () => {
    mockedLookup.mockImplementation(async (host: string) => {
      if (host === 'public.example.com') return [{ address: '93.184.216.34', family: 4 }];
      if (host === 'rebinding.example.com') return [{ address: '127.0.0.1', family: 4 }];
      throw new Error('unexpected host');
    });
    mockedGet.mockResolvedValueOnce({
      status: 302,
      headers: { location: 'http://rebinding.example.com/admin' },
    });

    await expect(safeAxiosGet('http://public.example.com/')).rejects.toBeInstanceOf(UrlSafetyError);
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it('returns the body for a public, non-redirecting URL', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockedGet.mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });

    const response = await safeAxiosGet('http://public.example.com/');
    expect(response.status).toBe(200);
    expect(response.data).toBe('ok');
  });

  it('pins the agent lookup to the resolved address (DNS rebinding defense)', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    mockedGet.mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' });

    await safeAxiosGet('http://public.example.com/');

    const callOpts = mockedGet.mock.calls[0]?.[1] as {
      httpAgent?: { options?: { lookup?: unknown } };
      httpsAgent?: { options?: { lookup?: unknown } };
    };
    expect(callOpts.httpAgent).toBeDefined();
    expect(callOpts.httpsAgent).toBeDefined();

    const pinned = await new Promise<{ addr: string; family: number }>((resolve, reject) => {
      const lookup = callOpts.httpAgent!.options!.lookup as (
        host: string,
        cb: (err: NodeJS.ErrnoException | null, addr: string, family: number) => void,
      ) => void;
      lookup('attacker-rebind.example', (err, addr, family) => {
        if (err) reject(err);
        else resolve({ addr, family });
      });
    });
    expect(pinned.addr).toBe('93.184.216.34');
    expect(pinned.family).toBe(4);
  });
});
