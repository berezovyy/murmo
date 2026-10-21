// JSON-RPC to the Rust wrapper. Every call is a string in, a string out.

export type HostBridge = (op: string, data?: Record<string, unknown>) => Record<string, unknown>;

export function createHost(): HostBridge {
  const native = (globalThis as { __host?: (line: string) => string }).__host;
  if (typeof native !== 'function') throw new Error('murmo-codex: __host is missing');
  delete (globalThis as { __host?: unknown }).__host;
  return (op, data = {}) => {
    try {
      return JSON.parse(native(JSON.stringify({ op, ...data }))) as Record<string, unknown>;
    } catch {
      return { ok: false, why: 'host-json' };
    }
  };
}

export function sha256(bytes: Uint8Array): string {
  const fn = (globalThis as { __sha256?: (b: Uint8Array) => string }).__sha256;
  if (typeof fn === 'function') return fn(bytes);
  return 'missing';
}
