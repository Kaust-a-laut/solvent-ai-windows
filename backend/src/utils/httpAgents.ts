import http from 'http';
import https from 'https';

/**
 * Shared keep-alive agents for outbound provider HTTP. Provider chat-completion
 * traffic is chatty (one connection per chat turn × many users) and the TLS
 * handshake dominates per-request cost — reusing sockets shaves real latency.
 *
 * NOT for use with the SSRF-guarded `safeAxiosGet` path: that wrapper builds
 * per-call agents with a hostname-pinned `lookup` to defeat DNS rebinding,
 * which is incompatible with cross-call socket reuse.
 */
const KEEP_ALIVE_MS = 30_000;
const MAX_SOCKETS = 32;

export const providerHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_MS,
  maxSockets: MAX_SOCKETS,
});

export const providerHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: KEEP_ALIVE_MS,
  maxSockets: MAX_SOCKETS,
});
