// The durable backend behind `ctx.storage` (draft 2.0-pre broker contract):
// one record per plugin namespace, and every `set` or `delete` re-reads the
// namespace under its lock and applies only its own key. Twelve sessions
// writing different keys of one namespace lose nothing (round 14 ran 12 at
// once, lesson 76); the prototype's fixed `.tmp` file and last-writer-wins
// save did (r12 `createFileStorage`, r14 D4).
//
// Still not compare-and-set per key: a plugin that needs read-modify-write
// across calls keeps that state in its session until phase 32.
import { LIMITS, type PluginStorage, type StorageResult } from '@murmo/api';
import { pluginRecordPath, type StoreLayout } from '../layout.ts';
import {
  type NamespaceChange,
  type NamespaceData,
  PRIVATE_MODE_REASON,
  storageDelete,
  storageGet,
  storageSet,
} from '../plugin-namespace.ts';
import type { PluginRecord } from '../records.ts';
import type { ModeRepairs } from './files.ts';
import type { Privacy } from './privacy.ts';
import { readRecord, updateRecord } from './record.ts';

/** The `forPlugin` contract of the draft 2.0-pre storage broker. */
export interface PluginStorageBroker {
  forPlugin(pluginId: string): PluginStorage;
}

/** Room for the record envelope around a full namespace. */
const RECORD_BYTES = LIMITS.storageBytes + 1024;

export function createPluginStorageBroker(
  layout: StoreLayout,
  privacy: Privacy,
  repairs?: ModeRepairs,
): PluginStorageBroker {
  return {
    forPlugin(pluginId) {
      const path = pluginRecordPath(layout, pluginId);
      const dataOf = (record: PluginRecord | undefined): NamespaceData =>
        record && record.plugin === pluginId ? { ...record.data } : {};

      const change = async (apply: (data: NamespaceData) => NamespaceChange): Promise<StorageResult> => {
        if (await privacy.isPrivate()) return { status: 'denied', reason: PRIVATE_MODE_REASON };
        const outcome = await updateRecord(
          'plugin',
          path,
          (current) => {
            const { result, next } = apply(dataOf(current));
            if (!next) return { unchanged: result };
            return { record: { schema: 1, plugin: pluginId, data: next }, result };
          },
          { base: layout.roots.data, maxBytes: RECORD_BYTES, ...(repairs ? { repairs } : {}) },
        );
        if (outcome.status === 'ok') return outcome.result;
        if (outcome.status === 'busy') return { status: 'error', reason: 'storage is busy; try again' };
        return { status: 'error', reason: outcome.reason };
      };

      return {
        async get(key) {
          const read = await readRecord('plugin', path, repairs, RECORD_BYTES);
          if (read.status === 'unreadable') return { status: 'error', reason: `storage ${read.reason}` };
          return storageGet(dataOf(read.status === 'ok' ? read.record : undefined), key);
        },
        set: (key, value) => change((data) => storageSet(data, key, value)),
        delete: (key) => change((data) => storageDelete(data, key)),
      };
    },
  };
}
