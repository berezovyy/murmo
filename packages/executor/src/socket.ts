// Claude's `$.http.fetch` over a Unix `socketPath` (r11b H3). Portable: the
// fetch implementation is injected; this file has no Node APIs.

import { executorFault } from './fault.ts';
import type { HelperTransport } from './helper.ts';

export interface FetchInit {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly socketPath?: string;
}

export type FetchResult = { readonly text: string } | { text(): string | Promise<string> };

export type HelperFetch = (url: string, init: FetchInit) => Promise<FetchResult>;

export interface SocketTransportOptions {
  readonly fetch: HelperFetch;
  readonly socketPath: string;
  /** Unused when `socketPath` is set; kept so loopback tests can target a port. */
  readonly url?: string;
}

async function bodyOf(response: FetchResult): Promise<string> {
  if (typeof response.text === 'function') return response.text();
  return response.text;
}

/** One POST /rpc per request, the Claude `socketPath` shape. */
export function createSocketTransport(options: SocketTransportOptions): HelperTransport {
  const url = options.url ?? 'http://127.0.0.1/rpc';
  let closed = false;
  const exits = new Set<(code: number | null) => void>();
  return {
    async request(message) {
      if (closed) throw executorFault('session-exit', 'helper socket closed');
      const response = await options.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
        socketPath: options.socketPath,
      });
      const text = await bodyOf(response);
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw executorFault('transport', `helper HTTP returned non-JSON: ${text.slice(0, 200)}`);
      }
    },
    async close() {
      closed = true;
      for (const cb of exits) cb(0);
    },
    onExit(callback) {
      exits.add(callback);
      return () => {
        exits.delete(callback);
      };
    },
  };
}
