import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, type Harness } from '@murmo/core/testing';
import { openStore, type Store } from '@murmo/store/node';
import { createMemoryStore, type PhraseStore } from '../src/memory.ts';
import { phrasesPlugin } from '../src/plugin.ts';
import type { PhraseRecord } from '../src/rank.ts';

export const PROJECT = createHash('sha256').update('phrases-test').digest('hex');

export function tempStore(prefix = 'murmo-phrases-'): { store: Promise<Store>; dir: string; remove: () => void } {
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

export function record(partial: Partial<PhraseRecord> & Pick<PhraseRecord, 'phrase'>): PhraseRecord {
  return {
    id: partial.id ?? createHash('sha256').update(partial.phrase).digest('hex').slice(0, 16),
    host: partial.host ?? 'pi',
    project: partial.project ?? PROJECT,
    count: partial.count ?? 3,
    firstAt: partial.firstAt ?? 0,
    lastAt: partial.lastAt ?? 0,
    accepts: partial.accepts ?? 0,
    dismissals: partial.dismissals ?? 0,
    recentAt: partial.recentAt ?? [partial.lastAt ?? 0],
    phrase: partial.phrase,
  };
}

export function seed(phrases: readonly (Partial<PhraseRecord> & Pick<PhraseRecord, 'phrase'>)[]): PhraseStore {
  const memory = createMemoryStore();
  memory.load(phrases.map(record));
  return memory;
}

export async function withPhrases(
  memory: PhraseStore,
  settings: Readonly<Record<string, unknown>> = { learn: true },
  runner: 'direct' | 'executor' = 'direct',
): Promise<Harness> {
  return createHarness({
    runner,
    plugins: [phrasesPlugin({ memory, identity: { project: PROJECT, host: 'fake', session: 't' } }, settings)],
  });
}
