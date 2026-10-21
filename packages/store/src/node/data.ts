// Review and delete (`murmo data show`, `murmo data delete`). Review walks the
// three roots and lists every file it finds under a kind, so nothing Murmo
// wrote can hide from it. Delete unlinks whole files, or rewrites a record or
// log segment without the entries and renames it over the old one, then bumps
// the generation so open sessions drop what they hold in memory. "Clear" that
// keeps the file is the prior-art failure this answers (lesson 4, knowledge § 7).
import fsp from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { LOG_KINDS, type LogKind, projectCache, projectDirectory, projectDrafts, type StoreLayout } from '../layout.ts';
import { decodeRecord, EMPTY_WORDS } from '../records.ts';
import { errorCode, exists, type ModeRepairs } from './files.ts';
import { compactLog, parseSegment } from './logs.ts';
import { updateRecord } from './record.ts';

export const DATA_KINDS = ['trust', 'words', 'plugins', 'logs', 'drafts', 'vocab'] as const;
export type DataKind = (typeof DATA_KINDS)[number];

/** Everything else Murmo finds: the store's own bookkeeping and files it doesn't recognize. */
export type InventoryKind = DataKind | 'meta' | 'private' | 'other';

export interface InventoryRow {
  readonly kind: InventoryKind;
  readonly scope: 'global' | 'project';
  readonly projectId?: string;
  /** A plugin ID for a storage namespace, a log kind for logs. */
  readonly label?: string;
  readonly files: number;
  readonly bytes: number;
  /** Words, approvals, keys or log lines; absent where entries aren't countable. */
  readonly entries?: number;
  /** The folder or file the row covers. */
  readonly path: string;
}

interface FileInfo {
  readonly path: string;
  readonly bytes: number;
}

async function walk(root: string, out: FileInfo[]): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else {
      const st = await fsp.lstat(path).catch(() => undefined);
      if (st) out.push({ path, bytes: st.size });
    }
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Which row a file belongs to. Locks and temps count with the file they belong to. */
function classify(layout: StoreLayout, path: string): Omit<InventoryRow, 'files' | 'bytes' | 'entries'> {
  const under = (base: string) => {
    const rel = relative(base, path);
    return rel.startsWith('..') || rel.startsWith(sep) ? undefined : rel.split(sep);
  };
  const store = under(layout.store);
  if (store) {
    const [first, second, third] = store;
    const name = (first ?? '').replace(/^\./, '');
    if (store.length === 1 && name.startsWith('meta.json')) return { kind: 'meta', scope: 'global', path: layout.meta };
    if (store.length === 1 && name.startsWith('trust.json'))
      return { kind: 'trust', scope: 'global', path: layout.trust };
    if (store.length === 1 && name.startsWith('words.json'))
      return { kind: 'words', scope: 'global', path: layout.words };
    if (first === 'plugins') return { kind: 'plugins', scope: 'global', path: layout.plugins };
    if (first === 'logs' && second && (LOG_KINDS as readonly string[]).includes(second)) {
      return { kind: 'logs', scope: 'global', label: second, path: join(layout.logs, second) };
    }
    if (first === 'projects' && second && HEX64.test(second)) {
      const dir = projectDirectory(layout, second);
      if (third?.replace(/^\./, '').startsWith('words.json') && store.length === 3) {
        return { kind: 'words', scope: 'project', projectId: second, path: join(dir, 'words.json') };
      }
      return { kind: 'other', scope: 'project', projectId: second, path: dir };
    }
    return { kind: 'other', scope: 'global', path: layout.store };
  }
  const drafts = under(layout.drafts);
  if (drafts) {
    const [first] = drafts;
    if (first && HEX64.test(first) && drafts.length > 1) {
      return { kind: 'drafts', scope: 'project', projectId: first, path: projectDrafts(layout, first) };
    }
    return { kind: 'drafts', scope: 'global', path: layout.drafts };
  }
  const state = under(layout.roots.state);
  if (state && state.length === 1 && (state[0] ?? '').replace(/^\./, '').startsWith('private')) {
    return { kind: 'private', scope: 'global', path: layout.privateFlag };
  }
  const cache = under(layout.roots.cache);
  if (cache) {
    const [first] = cache;
    if (first && HEX64.test(first) && cache.length > 1) {
      return { kind: 'vocab', scope: 'project', projectId: first, path: projectCache(layout, first) };
    }
    return { kind: 'vocab', scope: 'global', path: layout.roots.cache };
  }
  return { kind: 'other', scope: 'global', path: layout.roots.data };
}

/** Locks and temps are bookkeeping: their bytes count, their entries don't. */
function isBookkeeping(file: string): boolean {
  const name = file.slice(file.lastIndexOf(sep) + 1);
  return name.startsWith('.') || name.endsWith('.lock');
}

async function entriesOf(kind: InventoryKind, file: string): Promise<{ entries: number; plugin?: string }> {
  if (isBookkeeping(file)) return { entries: 0 };
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return { entries: 0 };
  }
  switch (kind) {
    case 'trust':
      return { entries: Object.keys(decodeRecord('trust', text)?.approvals ?? {}).length };
    case 'words':
      return { entries: decodeRecord('words', text)?.words.length ?? 0 };
    case 'plugins': {
      const record = decodeRecord('plugin', text);
      return record ? { entries: Object.keys(record.data).length, plugin: record.plugin } : { entries: 0 };
    }
    case 'logs':
      return { entries: file.endsWith('.jsonl') ? parseSegment(text).entries.length : 0 };
    default:
      return { entries: 0 };
  }
}

const COUNTED: ReadonlySet<InventoryKind> = new Set(['trust', 'words', 'plugins', 'logs']);

/**
 * Every file under the store, state and cache roots, grouped by kind and
 * project (and plugin or log kind). `projectId` keeps only that project's rows.
 */
export async function inventory(layout: StoreLayout, projectId?: string): Promise<InventoryRow[]> {
  const files: FileInfo[] = [];
  for (const root of [layout.store, layout.roots.state, layout.roots.cache]) await walk(root, files);
  const rows = new Map<string, InventoryRow & { entries: number }>();
  for (const file of files) {
    const base = classify(layout, file.path);
    if (projectId !== undefined && base.projectId !== projectId) continue;
    const { entries, plugin } = await entriesOf(base.kind, file.path);
    // One row per plugin namespace, named by its plugin ID.
    const row = plugin === undefined ? base : { ...base, label: plugin, path: file.path };
    const key = JSON.stringify([row.kind, row.projectId ?? '', row.label ?? '', row.path]);
    const current = rows.get(key) ?? { ...row, files: 0, bytes: 0, entries: 0 };
    rows.set(key, {
      ...current,
      files: current.files + 1,
      bytes: current.bytes + file.bytes,
      entries: current.entries + entries,
    });
  }
  return [...rows.values()]
    .map(({ entries, ...row }): InventoryRow => (COUNTED.has(row.kind) ? { ...row, entries } : row))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (a.projectId ?? '').localeCompare(b.projectId ?? '') ||
        a.path.localeCompare(b.path),
    );
}

export type DeleteSelector =
  | { readonly all: true }
  | { readonly projectId: string }
  | { readonly kind: DataKind }
  | { readonly word: string };

export interface DeleteReport {
  readonly removedFiles: number;
  readonly rewrittenFiles: number;
  readonly removedEntries: number;
}

async function removeTree(path: string): Promise<number> {
  const files: FileInfo[] = [];
  await walk(path, files);
  await fsp.rm(path, { recursive: true, force: true });
  return files.length;
}

/** A word as a whole token inside any string of a log entry. */
function mentions(value: unknown, word: string): boolean {
  if (typeof value === 'string') {
    let from = 0;
    for (;;) {
      const at = value.indexOf(word, from);
      if (at < 0) return false;
      const before = value.slice(0, at);
      const after = value.slice(at + word.length);
      if (!/[\p{L}\p{N}_]$/u.test(before) && !/^[\p{L}\p{N}_]/u.test(after)) return true;
      from = at + 1;
    }
  }
  if (Array.isArray(value)) return value.some((v) => mentions(v, word));
  if (typeof value === 'object' && value !== null) return Object.values(value).some((v) => mentions(v, word));
  return false;
}

async function projectIds(layout: StoreLayout): Promise<string[]> {
  try {
    return (await fsp.readdir(layout.projects)).filter((name) => HEX64.test(name));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

async function rewriteWords(
  layout: StoreLayout,
  path: string,
  keep: (word: string) => boolean,
  repairs: ModeRepairs | undefined,
): Promise<number> {
  if (!(await exists(path))) return 0;
  const outcome = await updateRecord(
    'words',
    path,
    (current) => {
      const words = (current ?? EMPTY_WORDS).words;
      const kept = words.filter(keep);
      if (kept.length === words.length) return { unchanged: 0 };
      return { record: { schema: 1, words: kept }, result: words.length - kept.length };
    },
    { base: layout.roots.data, durable: true, ...(repairs ? { repairs } : {}) },
  );
  if (outcome.status !== 'ok') throw new Error(outcome.status === 'busy' ? `${path} is busy` : outcome.reason);
  return outcome.result;
}

export async function deleteData(
  layout: StoreLayout,
  selector: DeleteSelector,
  repairs?: ModeRepairs,
): Promise<DeleteReport> {
  let removedFiles = 0;
  let rewrittenFiles = 0;
  let removedEntries = 0;
  const compactAll = async (drop: Parameters<typeof compactLog>[2]) => {
    for (const kind of LOG_KINDS as readonly LogKind[]) {
      const report = await compactLog(layout, kind, drop);
      removedEntries += report.removedEntries;
      rewrittenFiles += report.rewrittenFiles;
      removedFiles += report.removedFiles;
    }
  };

  if ('all' in selector) {
    // The store, drafts and caches; never `<data>` itself, which also holds the
    // installed package (phase 27), and never the private flag: deleting data
    // must not turn learning back on.
    for (const path of [layout.store, layout.drafts, layout.roots.cache]) removedFiles += await removeTree(path);
  } else if ('projectId' in selector) {
    const id = selector.projectId;
    for (const path of [projectDirectory(layout, id), projectCache(layout, id), projectDrafts(layout, id)]) {
      removedFiles += await removeTree(path);
    }
    const trust = await updateRecord(
      'trust',
      layout.trust,
      (current) => {
        if (!current || !Object.hasOwn(current.approvals, id)) return { unchanged: false };
        const approvals = { ...current.approvals };
        delete approvals[id];
        return { record: { schema: 1, approvals }, result: true };
      },
      { base: layout.roots.data, durable: true, ...(repairs ? { repairs } : {}) },
    );
    if (trust.status !== 'ok') throw new Error(trust.status === 'busy' ? 'trust.json is busy' : trust.reason);
    if (trust.result) {
      rewrittenFiles++;
      removedEntries++;
    }
    await compactAll((entry) => entry.project === id);
  } else if ('kind' in selector) {
    switch (selector.kind) {
      case 'trust':
        removedFiles += await removeTree(layout.trust);
        break;
      case 'words':
        removedFiles += await removeTree(layout.words);
        for (const id of await projectIds(layout))
          removedFiles += await removeTree(join(projectDirectory(layout, id), 'words.json'));
        break;
      case 'plugins':
        removedFiles += await removeTree(layout.plugins);
        break;
      case 'logs':
        removedFiles += await removeTree(layout.logs);
        break;
      case 'drafts':
        removedFiles += await removeTree(layout.drafts);
        break;
      case 'vocab':
        removedFiles += await removeTree(layout.roots.cache);
        break;
    }
  } else {
    const word = selector.word;
    for (const path of [
      layout.words,
      ...(await projectIds(layout)).map((id) => join(projectDirectory(layout, id), 'words.json')),
    ]) {
      const removed = await rewriteWords(layout, path, (w) => w !== word, repairs);
      if (removed > 0) {
        removedEntries += removed;
        rewrittenFiles++;
      }
    }
    await compactAll((entry) => mentions(entry, word));
  }
  return { removedFiles, rewrittenFiles, removedEntries };
}
