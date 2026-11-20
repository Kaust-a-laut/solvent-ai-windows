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

const PRIVATE_HOST_LITERAL_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /^solvent-bridge$/i,
  /^metadata\.google\.internal$/i,
  /^metadata\.goog$/i,
];

function parseIpv4Octets(addr: string): [number, number, number, number] | null {
  if (!net.isIPv4(addr)) return null;
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts as [number, number, number, number];
}

function isPrivateIpv4Octets(a: number, b: number, c: number, d: number): boolean {
  if (a === 0) return true;                                        // 0.0.0.0/8 ("this" network)
  if (a === 10) return true;                                       // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true;               // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true;                                      // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true;                         // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;                // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true;                // 192.0.0.0/24 (IETF protocol)
  if (a === 192 && b === 0 && c === 2) return true;                // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true;                         // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true;            // 198.18.0.0/15 (benchmarking)
  if (a === 198 && b === 51 && c === 100) return true;             // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true;              // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true;                                       // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  void d;
  return false;
}

function parseIpv6Groups(raw: string): number[] | null {
  const addr = raw.split('%')[0] ?? raw; // strip zone index (e.g. %eth0)
  if (!net.isIPv6(addr)) return null;

  // Handle dotted-quad IPv4 tail (e.g., ::ffff:127.0.0.1)
  let normalized = addr;
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon !== -1 && normalized.slice(lastColon + 1).includes('.')) {
    const v4 = parseIpv4Octets(normalized.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(':');
    const nums: number[] = [];
    for (const tok of tokens) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(tok)) return null;
      nums.push(parseInt(tok, 16));
    }
    return nums;
  };

  const left = parsePart(halves[0] ?? '');
  if (!left) return null;
  if (halves.length === 1) {
    return left.length === 8 ? left : null;
  }
  const right = parsePart(halves[1] ?? '');
  if (!right) return null;
  const missing = 8 - (left.length + right.length);
  if (missing < 1) return null;
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isPrivateIpv6Groups(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const isAllZeroPrefix6 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  // ::/128 (unspecified) and ::1/128 (loopback)
  if (isAllZeroPrefix6 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // ::ffff:0:0/96 (IPv4-mapped) — covers both dotted and Node URL hex-normalized forms (e.g. ::ffff:7f00:1)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff);
  }
  // ::ffff:0:0:0/96 (IPv4-translated) or deprecated IPv4-compatible ::/96
  if ((g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) || isAllZeroPrefix6) {
    return isPrivateIpv4Octets(g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff);
  }
  // 64:ff9b::/96 & 64:ff9b:1::/48 (NAT64)
  if (g0 === 0x0064 && g1 === 0xff9b && ((g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) || g2 === 1)) {
    return true;
  }
  // 2002::/16 (6to4 embeds IPv4 in groups 1..2)
  if (g0 === 0x2002) {
    return isPrivateIpv4Octets(g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff);
  }
  // 2001::/32 (Teredo), 2001:db8::/32 (documentation), 100::/64 (discard)
  if (g0 === 0x2001 && (g1 === 0x0000 || g1 === 0x0db8)) return true;
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  // fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (site-local), ff00::/8 (multicast)
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

export function isPrivateIp(addr: string): boolean {
  const cleaned = addr.split('%')[0] ?? addr;
  const v4 = parseIpv4Octets(cleaned);
  if (v4) {
    return isPrivateIpv4Octets(v4[0], v4[1], v4[2], v4[3]);
  }
  const v6 = parseIpv6Groups(cleaned);
  if (v6) {
    return isPrivateIpv6Groups(v6);
  }
  return false;
}

function unwrapHostname(hostname: string): string {
  // Node's URL exposes IPv6 hostnames as bracketed (e.g. "[::1]"); net.isIP
  // wants the raw form. Strip trailing DNS root dot as well.
  let out = hostname;
  if (out.startsWith('[') && out.endsWith(']')) {
    out = out.slice(1, -1);
  }
  return out.replace(/\.+$/, '');
}

function isPrivateHostnameLiteral(hostname: string): boolean {
  const unwrapped = unwrapHostname(hostname);
  if (PRIVATE_HOST_LITERAL_PATTERNS.some(p => p.test(unwrapped))) return true;
  const noZone = unwrapped.split('%')[0] ?? unwrapped;
  if (net.isIP(noZone)) return isPrivateIp(noZone);
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
        proxy: false,
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
