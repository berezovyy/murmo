// History log + packed snapshot set. Sessions append JSON Lines without a
// lock; idle merge writes the file set under the snapshot lock and swaps
// `current` (E5, E23). Retention: 50,000 unique or 365 days (phase 35).

import { dirname } from 'node:path';
import { historyDirectory, historyMetricsPath, sha256Hex } from '@murmo/store';
import {
  compactLog,
  ensurePrivateDir,
  type LogEntry,
  readPointer,
  readSnapshotSet,
  type Store,
  swapSnapshotSet,
  writeAtomic,
} from '@murmo/store/node';
import { createMemoryStore, promptId } from '../memory.ts';
import { emptyMetrics, type HistoryMetrics } from '../metrics.ts';
import { buildPacked, HISTORY_FORMAT, mapPacked, type PackedIndex } from '../packed.ts';
import type { HistoryRecord } from '../rank.ts';

export const RETAIN_UNIQUE = 50_000;
export const RETAIN_DAYS = 365;
export const DAY_MS = 86_400_000;

export interface HistoryLogEvent extends LogEntry {
  readonly text: string;
  readonly host: string;
  readonly project: string;
  readonly at: number;
}

function isEvent(entry: LogEntry): entry is HistoryLogEvent {
  return (
    typeof entry.text === 'string' &&
    typeof entry.host === 'string' &&
    typeof entry.project === 'string' &&
    typeof entry.at === 'number'
  );
}

export function replay(entries: readonly LogEntry[]): HistoryRecord[] {
  const memory = createMemoryStore();
  const events: { text: string; host: string; project: string; at: number }[] = [];
  for (const entry of entries) {
    if (!isEvent(entry)) continue;
    events.push({ text: entry.text, host: entry.host, project: entry.project, at: entry.at });
  }
  memory.record(events);
  return memory.records();
}

export function retain(records: readonly HistoryRecord[], now: number): HistoryRecord[] {
  const cutoff = now - RETAIN_DAYS * DAY_MS;
  const kept = records.filter((r) => r.lastAt >= cutoff);
  if (kept.length <= RETAIN_UNIQUE) return kept;
  return [...kept].sort((a, b) => b.lastAt - a.lastAt).slice(0, RETAIN_UNIQUE);
}

export async function loadRecords(store: Store): Promise<HistoryRecord[]> {
  const { entries } = await store.logs.read('history');
  return replay(entries);
}

export async function writePacked(store: Store, records: readonly HistoryRecord[], now: number): Promise<void> {
  const kept = retain(records, now);
  const built = buildPacked(kept, now);
  const files: Record<string, { fields: { format: string; sourceHash: string; entries: number }; body: Uint8Array }> =
    {};
  const sourceHash = sha256Hex(built.files.index ?? new Uint8Array(0));
  for (const [name, body] of Object.entries(built.files)) {
    files[name] = { fields: { format: HISTORY_FORMAT, sourceHash, entries: kept.length }, body };
  }
  await swapSnapshotSet({ directory: historyDirectory(store.layout), base: store.layout.roots.data }, files);
}

export async function readPacked(store: Store): Promise<PackedIndex | null> {
  const read = await readSnapshotSet(historyDirectory(store.layout));
  if (read.status !== 'ok') return null;
  const bodies: Record<string, Uint8Array> = {};
  for (const [name, snap] of Object.entries(read.files)) {
    if (snap.header.format !== HISTORY_FORMAT) return null;
    bodies[name] = snap.body;
  }
  return mapPacked(bodies);
}

export async function persistEvents(
  store: Store,
  sessionId: string,
  events: readonly HistoryLogEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await store.logs.session('history', sessionId).append(events);
}

export async function mergeHistory(store: Store, now = Date.now()): Promise<{ prompts: number }> {
  const records = await loadRecords(store);
  await writePacked(store, records, now);
  return { prompts: retain(records, now).length };
}

export async function forgetPrompt(store: Store, id: string): Promise<{ removed: number; text?: string }> {
  const records = await loadRecords(store);
  const match = records.find((r) => promptId(r.text) === id || r.text === id);
  const text = match?.text;
  const drop = (entry: LogEntry) =>
    isEvent(entry) && (entry.text === id || promptId(entry.text) === id || (text !== undefined && entry.text === text));
  const report = await compactLog(store.layout, 'history', drop);
  const kept = await loadRecords(store);
  await writePacked(store, kept, Date.now());
  return { removed: report.removedEntries, ...(text === undefined ? {} : { text }) };
}

export async function wipeHistory(store: Store, projectId?: string): Promise<{ removed: number }> {
  const drop = (entry: LogEntry) => {
    if (!isEvent(entry)) return projectId === undefined;
    return projectId === undefined || entry.project === projectId;
  };
  const report = await compactLog(store.layout, 'history', drop);
  const kept = await loadRecords(store);
  await writePacked(store, kept, Date.now());
  return { removed: report.removedEntries };
}

export async function lastMerge(store: Store): Promise<{ generation: number } | undefined> {
  const pointer = await readPointer(historyDirectory(store.layout));
  return pointer ? { generation: pointer.generation } : undefined;
}

export async function readMetrics(store: Store): Promise<HistoryMetrics> {
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(historyMetricsPath(store.layout), 'utf8');
    const value = JSON.parse(text) as HistoryMetrics;
    return {
      recorded: Number(value.recorded) || 0,
      searches: Number(value.searches) || 0,
      inserts: Number(value.inserts) || 0,
      staleDrops: Number(value.staleDrops) || 0,
    };
  } catch {
    return emptyMetrics();
  }
}

export async function writeMetrics(store: Store, metrics: HistoryMetrics): Promise<void> {
  const path = historyMetricsPath(store.layout);
  await ensurePrivateDir(dirname(path), store.layout.roots.data);
  await writeAtomic(path, `${JSON.stringify({ schema: 1, ...metrics })}\n`);
}
