import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, type Harness } from '@murmo/core/testing';
import { openStore, type Store } from '@murmo/store/node';
import { createMemoryStore, type HistoryStore } from '../src/memory.ts';
import { historyPlugin } from '../src/plugin.ts';
import type { HistoryRecord } from '../src/rank.ts';

export const PROJECT = createHash('sha256').update('history-test').digest('hex');

export function tempStore(prefix = 'murmo-history-'): { store: Promise<Store>; dir: string; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const roots = {
    data: join(dir, 'data', 'murmo'),
    state: join(dir, 'state', 'murmo'),
    cache: join(dir, 'cache', 'murmo'),
  };
  return {
    dir,
    store: openStore({ roots }),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function record(partial: Partial<HistoryRecord> & Pick<HistoryRecord, 'text'>): HistoryRecord {
  return {
    id: partial.id ?? 0,
    text: partial.text,
    count: partial.count ?? 1,
    lastAt: partial.lastAt ?? 0,
    events: partial.events ?? [{ host: 'pi', project: PROJECT, at: partial.lastAt ?? 0 }],
  };
}

export function seed(rows: readonly (Partial<HistoryRecord> & Pick<HistoryRecord, 'text'>)[]): HistoryStore {
  const memory = createMemoryStore();
  memory.load(rows.map((r, i) => record({ id: i, ...r })));
  for (const r of memory.records()) {
    memory.delta.push(r);
  }
  return memory;
}

export async function withHistory(
  memory: HistoryStore,
  settings: Readonly<Record<string, unknown>> = { enabled: true },
): Promise<Harness> {
  return createHarness({
    runner: 'direct',
    plugins: [
      historyPlugin(
        {
          memory,
          identity: { project: PROJECT, host: 'fake', session: 't' },
          debounceMs: 0,
        },
        settings,
      ),
    ],
  });
}

export const QUERIES = [
  'r',
  'review',
  'outboxworker',
  'drain_',
  'review auth',
  'test timeout',
  'fix src/',
  'case 179',
  'unicode offsets',
  'nonexistent_symbol',
  'api_key',
  'request',
  'session',
  'in src/',
  'the',
  'a',
  's',
  'c',
  'review outboxworker',
  'Case 1',
  '1',
  '17',
  'sr',
  'in',
  'ou',
  'dr',
  're',
  'no',
  'zz',
];
