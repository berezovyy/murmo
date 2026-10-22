// Phrase log + packed snapshot on the phase 14 store. Sessions append JSON
// Lines without a lock; idle merge writes `phrases.bin` under the snapshot
// lock and swaps it by rename (E1, E26).

import { dirname } from 'node:path';
import { phraseMetricsPath, phraseSnapshotPath, sha256Hex } from '@murmo/store';
import {
  compactLog,
  ensurePrivateDir,
  type LogEntry,
  readSnapshot,
  type Store,
  writeAtomic,
  writeSnapshot,
} from '@murmo/store/node';
import { createMemoryStore, type PhraseStore, packedRowsOf, phraseId } from '../memory.ts';
import { emptyMetrics, type PhraseMetrics } from '../metrics.ts';
import { buildPacked, mapPacked, type PackedIndex, PHRASES_FORMAT } from '../packed.ts';
import type { PhraseRecord } from '../rank.ts';

export const PHRASE_FILE = 'phrases.bin';

export interface PhraseLogEvent extends LogEntry {
  readonly phrase: string;
  readonly host: string;
  readonly project: string;
  readonly at: number;
  readonly kind?: 'learn' | 'accept' | 'dismiss';
}

function isEvent(entry: LogEntry): entry is PhraseLogEvent {
  return (
    typeof entry.phrase === 'string' &&
    typeof entry.host === 'string' &&
    typeof entry.project === 'string' &&
    typeof entry.at === 'number'
  );
}

function replay(entries: readonly LogEntry[]): PhraseRecord[] {
  const memory = createMemoryStore();
  for (const entry of entries) {
    if (!isEvent(entry)) continue;
    const kind = entry.kind ?? 'learn';
    if (kind === 'accept') memory.recordAccept(entry.phrase, entry.host, entry.project, entry.at);
    else if (kind === 'dismiss') memory.recordDismiss(entry.phrase, entry.host, entry.project, entry.at);
    else memory.learn([{ phrase: entry.phrase, host: entry.host, project: entry.project, at: entry.at }]);
  }
  return [...memory.records()];
}

export async function loadRecords(store: Store): Promise<PhraseRecord[]> {
  const { entries } = await store.logs.read('phrases');
  return replay(entries);
}

export async function writePacked(store: Store, records: readonly PhraseRecord[], now: number): Promise<void> {
  const rows = packedRowsOf(records, now);
  const body = buildPacked(rows);
  const sourceHash = sha256Hex(body);
  await writeSnapshot(
    { path: phraseSnapshotPath(store.layout), base: store.layout.roots.data },
    { format: PHRASES_FORMAT, sourceHash, entries: rows.length },
    body,
  );
}

export async function readPacked(store: Store): Promise<PackedIndex | null> {
  const read = await readSnapshot(phraseSnapshotPath(store.layout));
  if (read.status !== 'ok') return null;
  if (read.snapshot.header.format !== PHRASES_FORMAT) return null;
  return mapPacked(read.snapshot.body);
}

export async function persistEvents(store: Store, sessionId: string, events: readonly PhraseLogEvent[]): Promise<void> {
  if (events.length === 0) return;
  await store.logs.session('phrases', sessionId).append(events);
}

export async function forgetPhrase(store: Store, id: string): Promise<{ removed: number; phrase?: string }> {
  const records = await loadRecords(store);
  const match = records.find((r) => r.id === id || r.phrase === id);
  const phrase = match?.phrase;
  const drop = (entry: LogEntry) =>
    isEvent(entry) &&
    (entry.phrase === id || phraseId(entry.phrase) === id || (phrase !== undefined && entry.phrase === phrase));
  const report = await compactLog(store.layout, 'phrases', drop);
  const kept = await loadRecords(store);
  await writePacked(store, kept, Date.now());
  return { removed: report.removedEntries, ...(phrase === undefined ? {} : { phrase }) };
}

export async function wipePhrases(store: Store, projectId?: string): Promise<{ removed: number }> {
  const drop = (entry: LogEntry) => {
    if (!isEvent(entry)) return projectId === undefined;
    return projectId === undefined || entry.project === projectId;
  };
  const report = await compactLog(store.layout, 'phrases', drop);
  const kept = await loadRecords(store);
  await writePacked(store, kept, Date.now());
  return { removed: report.removedEntries };
}

export async function readMetrics(store: Store): Promise<PhraseMetrics> {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(phraseMetricsPath(store.layout), 'utf8');
    const value = JSON.parse(text) as PhraseMetrics;
    return {
      shown: Number(value.shown) || 0,
      accepted: Number(value.accepted) || 0,
      dismissed: Number(value.dismissed) || 0,
      charactersSaved: Number(value.charactersSaved) || 0,
      staleDrops: Number(value.staleDrops) || 0,
    };
  } catch {
    return emptyMetrics();
  }
}

export async function writeMetrics(store: Store, metrics: PhraseMetrics): Promise<void> {
  const path = phraseMetricsPath(store.layout);
  await ensurePrivateDir(dirname(path), store.layout.roots.data);
  await writeAtomic(path, `${JSON.stringify({ schema: 1, ...metrics })}\n`);
}

export async function openPhraseMemory(store: Store): Promise<PhraseStore> {
  const memory = createMemoryStore();
  memory.load(await loadRecords(store));
  return memory;
}
