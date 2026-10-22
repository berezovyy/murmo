// The store protocol a session without a real file system API (Claude's
// plugin runtime) speaks to the helper, which owns the files. One JSON request,
// one JSON reply. The helper (phase 10, Rust: rust/src/protocol.rs) and the
// Node handler (./node/server.ts) answer it the same way.
import { LOG_KINDS, type LogKind } from './layout.ts';

export type StoreRequest =
  | { readonly op: 'storage.get'; readonly plugin: string; readonly key: string }
  | {
      readonly op: 'storage.set';
      readonly plugin: string;
      readonly key: string;
      readonly value: unknown;
      readonly expected?: number;
    }
  | { readonly op: 'storage.delete'; readonly plugin: string; readonly key: string }
  | { readonly op: 'private.get' }
  | { readonly op: 'generation.get' }
  | { readonly op: 'words.add'; readonly word: string; readonly learned: boolean; readonly projectId?: string }
  | { readonly op: 'log.append'; readonly kind: LogKind; readonly session: string; readonly lines: readonly string[] };

export type StoreReply =
  | { readonly status: 'ok'; readonly value?: unknown; readonly revision?: number }
  | {
      readonly status: 'quota' | 'denied' | 'busy' | 'error' | 'conflict';
      readonly reason?: string;
      readonly revision?: number;
    };

const isString = (v: unknown): v is string => typeof v === 'string';

/** The request in `value`, or undefined when it isn't a well-formed one. */
export function parseStoreRequest(value: unknown): StoreRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  switch (r.op) {
    case 'storage.get':
    case 'storage.delete':
      return isString(r.plugin) && isString(r.key) ? { op: r.op, plugin: r.plugin, key: r.key } : undefined;
    case 'storage.set':
      if (!isString(r.plugin) || !isString(r.key) || !Object.hasOwn(r, 'value')) return undefined;
      return {
        op: r.op,
        plugin: r.plugin,
        key: r.key,
        value: r.value,
        ...(typeof r.expected === 'number' ? { expected: r.expected } : {}),
      };
    case 'private.get':
    case 'generation.get':
      return { op: r.op };
    case 'words.add':
      if (!isString(r.word) || typeof r.learned !== 'boolean') return undefined;
      if (r.projectId !== undefined && !isString(r.projectId)) return undefined;
      return {
        op: r.op,
        word: r.word,
        learned: r.learned,
        ...(isString(r.projectId) ? { projectId: r.projectId } : {}),
      };
    case 'log.append':
      return (LOG_KINDS as readonly unknown[]).includes(r.kind) &&
        isString(r.session) &&
        Array.isArray(r.lines) &&
        r.lines.every(isString)
        ? { op: r.op, kind: r.kind as LogKind, session: r.session, lines: r.lines as string[] }
        : undefined;
    default:
      return undefined;
  }
}
