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

  const parse = async (id: string): Promise<Record<string, unknown>> => {
    const raw = await backend.load(id);
    cache.set(id, raw === '' ? '{}' : raw);
    const parsed: unknown = JSON.parse(raw === '' ? '{}' : raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return { ...(parsed as Record<string, unknown>) };
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
              const data = await parse(id);
              return Object.hasOwn(data, key) ? { status: 'ok', value: cloneJson(data[key]) } : { status: 'ok' };
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
              const data = await parse(id);
              const next = { ...data, [key]: copy };
              const quota = quotaProblem(next);
              if (quota) return { status: 'quota', reason: quota };
              const json = JSON.stringify(next);
              await backend.save(id, json);
              cache.set(id, json);
              return { status: 'ok' };
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
              const data = await parse(id);
              if (!Object.hasOwn(data, key)) return { status: 'ok' };
              const next = { ...data };
              delete next[key];
              const json = JSON.stringify(next);
              await backend.save(id, json);
              cache.set(id, json);
              return { status: 'ok' };
            } catch (error) {
              return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
            }
          });
        },
      };
    },
    snapshot(): Readonly<Record<string, string>> {
      return Object.fromEntries(cache);
    },
  };
}
