// The Claude backend: the store reached through the helper's socket (r9's
// Claude rescue wrote through a helper too, 27-34 ms per save, off the key
// path). Portable: no file system, timers or Node APIs here; the transport is
// injected by the adapter (phase 24) once the helper protocol exists (phase 10).
//
// While the helper is down, the session keeps plugin storage in memory only,
// refuses learned writes, reports private mode as on (nothing gets learned),
// and `degraded` lets the adapter say so in its status.
import type { PluginStorage, StorageResult } from '@murmo/api';
import type { LogKind } from './layout.ts';
import { type NamespaceData, storageDelete, storageGet, storageSet } from './plugin-namespace.ts';
import type { StoreReply, StoreRequest } from './protocol.ts';

export interface StoreTransport {
  /** Sends one request; rejects when the helper can't be reached. */
  request(message: StoreRequest): Promise<StoreReply>;
}

export type RemoteWrite =
  | { readonly status: 'ok' }
  | { readonly status: 'denied' | 'busy' | 'error'; readonly reason: string };

export interface RemoteStore {
  forPlugin(pluginId: string): PluginStorage;
  isPrivate(): Promise<boolean>;
  generation(): Promise<{ readonly epoch: string; readonly generation: number } | undefined>;
  addWord(word: string, options: { readonly learned: boolean; readonly projectId?: string }): Promise<RemoteWrite>;
  appendLog(kind: LogKind, sessionId: string, entries: readonly object[]): Promise<RemoteWrite>;
  /** True once a request could not reach the helper; stays true for the session. */
  readonly degraded: boolean;
}

const UNAVAILABLE = 'the Murmo helper is not running; kept in memory for this session';

export function createRemoteStore(transport: StoreTransport): RemoteStore {
  let degraded = false;
  const memory = new Map<string, NamespaceData>();

  async function send(message: StoreRequest): Promise<StoreReply | undefined> {
    if (degraded) return undefined;
    try {
      return await transport.request(message);
    } catch {
      degraded = true;
      return undefined;
    }
  }

  const asStorage = (reply: StoreReply): StorageResult => {
    if (reply.status === 'busy') return { status: 'error', reason: reply.reason ?? 'storage is busy; try again' };
    return reply.status === 'ok'
      ? reply.value === undefined
        ? { status: 'ok' }
        : { status: 'ok', value: reply.value }
      : { status: reply.status, ...(reply.reason === undefined ? {} : { reason: reply.reason }) };
  };

  const asWrite = (reply: StoreReply | undefined): RemoteWrite => {
    if (!reply) return { status: 'error', reason: UNAVAILABLE };
    if (reply.status === 'ok') return { status: 'ok' };
    if (reply.status === 'quota') return { status: 'error', reason: reply.reason ?? reply.status };
    if (reply.status === 'conflict') return { status: 'error', reason: reply.reason ?? reply.status };
    return { status: reply.status, reason: reply.reason ?? reply.status };
  };

  return {
    forPlugin(pluginId) {
      const local = (): NamespaceData => {
        const data = memory.get(pluginId) ?? {};
        memory.set(pluginId, data);
        return data;
      };
      const change = async (
        message: StoreRequest,
        apply: (data: NamespaceData) => { result: StorageResult; next?: NamespaceData },
      ): Promise<StorageResult> => {
        const reply = await send(message);
        if (reply) return asStorage(reply);
        const { result, next } = apply(local());
        if (next) memory.set(pluginId, next);
        return result;
      };
      return {
        async get(key) {
          const reply = await send({ op: 'storage.get', plugin: pluginId, key });
          return reply ? asStorage(reply) : storageGet(local(), key);
        },
        set: (key, value) =>
          change({ op: 'storage.set', plugin: pluginId, key, value }, (data) => storageSet(data, key, value)),
        cas: (key, expected, value) =>
          change({ op: 'storage.set', plugin: pluginId, key, value, expected }, (data) => storageSet(data, key, value)),
        delete: (key) => change({ op: 'storage.delete', plugin: pluginId, key }, (data) => storageDelete(data, key)),
      };
    },
    async isPrivate() {
      const reply = await send({ op: 'private.get' });
      return reply?.status === 'ok' ? reply.value === true : true;
    },
    async generation() {
      const reply = await send({ op: 'generation.get' });
      const value = reply?.status === 'ok' ? (reply.value as { epoch?: unknown; generation?: unknown }) : undefined;
      return typeof value?.epoch === 'string' && typeof value.generation === 'number'
        ? { epoch: value.epoch, generation: value.generation }
        : undefined;
    },
    async addWord(word, { learned, projectId }) {
      return asWrite(await send({ op: 'words.add', word, learned, ...(projectId === undefined ? {} : { projectId }) }));
    },
    async appendLog(kind, sessionId, entries) {
      const lines = entries.map((e) => JSON.stringify(e));
      if (lines.length === 0) return { status: 'ok' };
      return asWrite(await send({ op: 'log.append', kind, session: sessionId, lines }));
    },
    get degraded() {
      return degraded;
    },
  };
}
