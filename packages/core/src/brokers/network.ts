// Address classification and grant checks for the network broker (E6).
// The HTTP client (pinned resolution, no redirects) lives in node/ and in
// murmo-plugin-host; this file is portable policy plus a fake for tests.

import { LIMITS, type NetworkAccess, type NetworkRequest, type NetworkResult, parseOrigin } from '@murmo/api';

export type AddressKind = 'loopback' | 'private' | 'link-local' | 'public' | 'invalid';

export function classifyAddress(ip: string): AddressKind {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const oct = v4.slice(1).map(Number);
    if (oct.some((n) => n > 255)) return 'invalid';
    const [a, b] = oct;
    if (a === 127 || a === 0) return 'loopback';
    if (a === 10) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    return 'public';
  }
  const compact = ip.toLowerCase();
  if (compact === '::1' || compact === '0:0:0:0:0:0:0:1') return 'loopback';
  if (compact.startsWith('fe80:')) return 'link-local';
  if (compact.startsWith('fc') || compact.startsWith('fd')) return 'private';
  if (compact.startsWith('::ffff:')) return classifyAddress(compact.slice('::ffff:'.length));
  if (compact.includes(':')) return 'public';
  return 'invalid';
}

function originOfUrl(url: string): ReturnType<typeof parseOrigin> {
  if (typeof url !== 'string' || url.includes('@')) return null;
  const sep = url.indexOf('://');
  if (sep < 0) return null;
  const rest = url.slice(sep + 3);
  const end = rest.search(/[/?#]/);
  const hostport = end < 0 ? rest : rest.slice(0, end);
  return parseOrigin(`${url.slice(0, sep).toLowerCase()}://${hostport}`);
}

export function originAllowed(url: string, granted: readonly string[]): boolean {
  const parsed = originOfUrl(url);
  if (!parsed) return false;
  return granted.some((item) => {
    const g = parseOrigin(item);
    return g !== null && g.scheme === parsed.scheme && g.host === parsed.host && g.port === parsed.port;
  });
}

export interface MemoryNetworkOptions {
  readonly origins?: readonly string[];
  /** Lab exception: allow loopback IPs when the granted origin is itself loopback (E6). */
  readonly allowLoopback?: boolean;
  readonly resolve?: (host: string) => readonly string[];
  readonly now?: () => number;
  readonly handler?: (req: NetworkRequest) => NetworkResult | Promise<NetworkResult>;
}

function originIsLoopback(origin: string): boolean {
  const parsed = parseOrigin(origin);
  return parsed !== null && classifyAddress(parsed.host) === 'loopback';
}

/** In-memory network broker for tests; same denials as the helper (E6). */
export function createMemoryNetwork(options: MemoryNetworkOptions = {}): NetworkAccess {
  const origins = options.origins ?? [];
  const times: number[] = [];
  return {
    async request(spec) {
      const parsed = originOfUrl(spec.url);
      if (!parsed || !originAllowed(spec.url, origins)) {
        return { status: 'denied', reason: 'origin denied' };
      }
      const host = parsed.host;
      const addresses = options.resolve?.(host) ?? (classifyAddress(host) === 'invalid' ? ['203.0.113.10'] : [host]);
      if (!addresses.length) return { status: 'denied', reason: 'private or invalid DNS address denied' };
      const allowPrivate = options.allowLoopback === true && origins.some(originIsLoopback);
      for (const ip of addresses) {
        const kind = classifyAddress(ip);
        if (kind === 'invalid' || (kind !== 'public' && !allowPrivate)) {
          return { status: 'denied', reason: 'private or invalid DNS address denied' };
        }
      }
      const body = spec.body ?? '';
      if (body.length > LIMITS.networkRequestBytes) return { status: 'too-large', reason: 'request exceeds 64 KiB' };
      const now = options.now?.() ?? 0;
      const window = times.filter((t) => now - t < 60_000);
      if (window.length >= LIMITS.networkRequestsPerMinute) {
        return { status: 'rate-limited', reason: '10 requests per minute' };
      }
      times.push(now);
      if (options.handler) return options.handler(spec);
      return { status: 'ok', httpStatus: 200, body: '', bytes: 0 };
    },
  };
}

export function denyNetwork(reason = 'network must be declared, granted and brokered'): NetworkAccess {
  return {
    request: async () => ({ status: 'denied', reason }),
  };
}
