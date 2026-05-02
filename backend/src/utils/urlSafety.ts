import dns from 'dns/promises';
import net, { LookupFunction } from 'net';
import http from 'http';
import https from 'https';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

export class UrlSafetyError extends Error {
  constructor(message = 'Cannot access private/local addresses') {
    super(message);
    this.name = 'UrlSafetyError';
  }
}

const PRIVATE_IPV4_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^255\.255\.255\.255$/,
];

const PRIVATE_IPV6_PATTERNS = [
  /^::1$/,
  /^::$/,
  /^fc/i,
  /^fd/i,
  /^fe80/i,
  /^::ffff:127\./i,
  /^::ffff:10\./i,
  /^::ffff:192\.168\./i,
  /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
];

const PRIVATE_HOST_LITERAL_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^solvent-bridge$/i,
];

export function isPrivateIp(addr: string): boolean {
  if (net.isIPv4(addr)) {
    return PRIVATE_IPV4_PATTERNS.some(p => p.test(addr));
  }
  if (net.isIPv6(addr)) {
    return PRIVATE_IPV6_PATTERNS.some(p => p.test(addr));
  }
  return false;
}

function unwrapHostname(hostname: string): string {
  // Node's URL exposes IPv6 hostnames as bracketed (e.g. "[::1]"); net.isIP
  // wants the raw form.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isPrivateHostnameLiteral(hostname: string): boolean {
  if (PRIVATE_HOST_LITERAL_PATTERNS.some(p => p.test(hostname))) return true;
  const unwrapped = unwrapHostname(hostname);
  if (net.isIP(unwrapped)) return isPrivateIp(unwrapped);
  return false;
}

export interface SafeUrlResolution {
  url: URL;
  address: string;
  family: 4 | 6;
}

async function resolveSafeUrl(url: string): Promise<SafeUrlResolution> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlSafetyError('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UrlSafetyError(`Unsupported protocol: ${parsed.protocol}`);
  }

  if (isPrivateHostnameLiteral(parsed.hostname)) {
    throw new UrlSafetyError();
  }

  // Resolve and check every returned address. We reject if ANY answer is
  // private — we cannot predict which the OS will pick at connect time.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(unwrapHostname(parsed.hostname), { all: true });
  } catch {
    throw new UrlSafetyError('Could not resolve hostname');
  }
  if (addresses.length === 0) {
    throw new UrlSafetyError('Hostname did not resolve');
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new UrlSafetyError();
    }
  }

  const first = addresses[0]!;
  return {
    url: parsed,
    address: first.address,
    family: (first.family === 6 ? 6 : 4) as 4 | 6,
  };
}

export async function assertSafeUrl(url: string): Promise<URL> {
  return (await resolveSafeUrl(url)).url;
}

// Pin Node's connect-phase lookup to the IP we validated. Without this, the
// kernel resolver could hand back a different (private) address between our
// dns.lookup and the actual TCP connect — classic DNS rebinding.
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    let cb = callback as (err: NodeJS.ErrnoException | null, ...args: unknown[]) => void;
    let opts: { all?: boolean } = {};
    if (typeof options === 'function') {
      cb = options as typeof cb;
    } else if (options && typeof options === 'object') {
      opts = options as { all?: boolean };
    }
    if (opts.all) {
      cb(null, [{ address, family }]);
    } else {
      cb(null, address, family);
    }
  }) as LookupFunction;
}

export interface SafeAxiosOptions extends Omit<AxiosRequestConfig, 'maxRedirects'> {
  maxHops?: number;
}

/**
 * axios.get wrapper that defends against SSRF on redirects AND DNS rebinding:
 *   - Re-validates the URL at every redirect hop (defeats public→private 302s)
 *   - Pins each hop's underlying TCP connect to the IP we just validated, via
 *     a custom lookup on the http(s) agent (defeats DNS rebinding)
 */
export async function safeAxiosGet(url: string, options: SafeAxiosOptions = {}): Promise<AxiosResponse> {
  const { maxHops = 5, ...rest } = options;
  let currentUrl = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    const { address, family } = await resolveSafeUrl(currentUrl);
    const lookup = pinnedLookup(address, family);
    const httpAgent = new http.Agent({ lookup });
    const httpsAgent = new https.Agent({ lookup });

    let response: AxiosResponse;
    try {
      response = await axios.get(currentUrl, {
        ...rest,
        httpAgent,
        httpsAgent,
        maxRedirects: 0,
        validateStatus: status => status >= 200 && status < 400,
      });
    } finally {
      httpAgent.destroy();
      httpsAgent.destroy();
    }
    if (response.status < 300) return response;
    const location = response.headers['location'];
    if (!location) {
      throw new UrlSafetyError('Redirect response without Location header');
    }
    currentUrl = new URL(String(location), currentUrl).toString();
  }
  throw new UrlSafetyError('Too many redirects');
}
