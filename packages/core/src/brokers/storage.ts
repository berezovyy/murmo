// Coordinator-owned JSON namespace. The backend sees one JSON document per
// plugin ID (`load`/`save`); it cannot merge per key (phase 14 hand-off).
// Operations in one namespace are serialized. Guests never receive the backend.

import { LIMITS, type PluginStorage, type StorageResult } from '@murmo/api';
import type { StorageBackend } from '@murmo/api/adapter';
import { utf8Length } from '@murmo/text';

export interface PluginStorageBroker {
  forPlugin(pluginId: string): PluginStorage;
}

export interface StorageBroker extends PluginStorageBroker {
  readonly backend: StorageBackend;
  snapshot(): Readonly<Record<string, string>>;
}

const cloneJson = (value: unknown): unknown => {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
};

function keyProblem(key: unknown): string | null {
  if (typeof key !== 'string' || key.length === 0) return 'storage keys are non-empty strings';
  if (key.length > LIMITS.storageKeyUnits) {
    return `storage keys are at most ${LIMITS.storageKeyUnits} UTF-16 units`;
  }
  return null;
}

function quotaProblem(data: Record<string, unknown>): string | null {
  if (Object.keys(data).length > LIMITS.storageKeys) return `plugin storage holds at most ${LIMITS.storageKeys} keys`;
  if (utf8Length(JSON.stringify(data)) > LIMITS.storageBytes) {
    return `plugin storage holds at most ${LIMITS.storageBytes} bytes of JSON`;
  }
  return null;
}

export function createMemoryStorage(): StorageBackend {
  const data = new Map<string, string>();
  return {
    async load(namespace) {
      return data.get(namespace) ?? '{}';
    },
    async save(namespace, json) {
      data.set(namespace, json);
    },
  };
}

interface NamespaceDoc {
  readonly data: Record<string, unknown>;
  readonly revisions: Record<string, number>;
}

function asDoc(parsed: unknown): NamespaceDoc {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { data: {}, revisions: {} };
  const rec = parsed as Record<string, unknown>;
  if (
    rec.data &&
    typeof rec.data === 'object' &&
    !Array.isArray(rec.data) &&
    rec.revisions &&
    typeof rec.revisions === 'object'
  ) {
    return {
      data: { ...(rec.data as Record<string, unknown>) },
      revisions: { ...(rec.revisions as Record<string, number>) },
    };
  }
  return { data: { ...rec }, revisions: {} };
}

export function createStorageBroker(backend: StorageBackend = createMemoryStorage()): StorageBroker {
  const queues = new Map<string, Promise<unknown>>();
  const cache = new Map<string, string>();

  const run = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    queues.set(
      id,
      next.then(
        () => {},
        () => {},
      ),
    );
    return next;
  };

  const parse = async (id: string): Promise<NamespaceDoc> => {
    const raw = await backend.load(id);
    cache.set(id, raw === '' ? '{}' : raw);
    const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
    return asDoc(parsed);
  };

  const write = async (id: string, doc: NamespaceDoc): Promise<void> => {
    const json = JSON.stringify({ data: doc.data, revisions: doc.revisions });
    await backend.save(id, json);
    cache.set(id, json);
  };

  const put = async (id: string, key: string, copy: unknown, expected?: number): Promise<StorageResult> => {
    const doc = await parse(id);
    const current = Object.hasOwn(doc.revisions, key) ? (doc.revisions[key] ?? 0) : 0;
    if (expected !== undefined && current !== expected) {
      return { status: 'conflict', revision: current, reason: 'revision mismatch' };
    }
    const data = { ...doc.data, [key]: copy };
    const quota = quotaProblem(data);
    if (quota) return { status: 'quota', reason: quota };
    const revision = current + 1;
    await write(id, { data, revisions: { ...doc.revisions, [key]: revision } });
    return { status: 'ok', revision };
  };

  return {
    backend,
    forPlugin(id: string): PluginStorage {
      return {
        get(key) {
          return run(id, async (): Promise<StorageResult> => {
            const problem = keyProblem(key);
            if (problem) return { status: 'denied', reason: problem };
            try {
              const doc = await parse(id);
              if (!Object.hasOwn(doc.data, key)) return { status: 'ok', revision: 0 };
              return { status: 'ok', value: cloneJson(doc.data[key]), revision: doc.revisions[key] ?? 1 };
            } catch (error) {
              return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
            }
          });
        },
        set(key, value) {
          return run(id, async (): Promise<StorageResult> => {
            const problem = keyProblem(key);
            if (problem) return { status: 'denied', reason: problem };
            const copy = cloneJson(value);
            if (copy === undefined) return { status: 'denied', reason: 'storage values must be JSON' };
            try {
              return await put(id, key, copy);
            } catch (error) {
              return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
            }
          });
        },
        cas(key, expected, value) {
          return run(id, async (): Promise<StorageResult> => {
            const problem = keyProblem(key);
            if (problem) return { status: 'denied', reason: problem };
            const copy = cloneJson(value);
            if (copy === undefined) return { status: 'denied', reason: 'storage values must be JSON' };
            try {
              return await put(id, key, copy, expected);
            } catch (error) {
              return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
            }
          });
        },
        delete(key) {
          return run(id, async (): Promise<StorageResult> => {
            const problem = keyProblem(key);
            if (problem) return { status: 'denied', reason: problem };
            try {
              const doc = await parse(id);
              if (!Object.hasOwn(doc.data, key)) return { status: 'ok', revision: 0 };
              const data = { ...doc.data };
              delete data[key];
              const revisions = { ...doc.revisions };
              delete revisions[key];
              await write(id, { data, revisions });
              return { status: 'ok', revision: 0 };
            } catch (error) {
              return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
            }
          });
        },
      };
    },
    snapshot(): Readonly<Record<string, string>> {
      const out: Record<string, string> = {};
      for (const [id, json] of cache) {
        try {
          out[id] = JSON.stringify(asDoc(JSON.parse(json === '' ? '{}' : json)).data);
        } catch {
          out[id] = json;
        }
      }
      return out;
    },
  };
}
