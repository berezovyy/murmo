// Log segments for learned events (phrases 34, history 35): JSON Lines, one
// segment series per session, rolled at 1 MiB so one `$.fs` call reads a
// segment. One writer per session needs no lock. A writer killed mid-line
// leaves a line without its newline; readers skip it and the next append from
// that writer starts on a fresh line.
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { checkSessionId, type LogKind, logDirectory, type StoreLayout } from '../layout.ts';
import { ensurePrivateDir, errorCode, FILE_MODE, type ModeRepairs, repairOpenFile, writeAtomic } from './files.ts';

export const SEGMENT_BYTES = 1_048_576;
const SEGMENT_NAME = /^([A-Za-z0-9-]{1,64})\.([0-9]{4,})\.jsonl$/;

export interface LogEntry {
  /** The project an entry belongs to, so `murmo data delete --project` can find it. */
  readonly project?: string;
  readonly [field: string]: unknown;
}

export interface LogRead {
  readonly entries: LogEntry[];
  /** Lines that were not complete JSON objects (a torn last line, a hand edit). */
  readonly skipped: number;
}

export async function segmentFiles(layout: StoreLayout, kind: LogKind): Promise<string[]> {
  const dir = logDirectory(layout, kind);
  try {
    return (await fsp.readdir(dir))
      .filter((name) => SEGMENT_NAME.test(name))
      .sort()
      .map((name) => join(dir, name));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/** Parses one segment's text: complete lines only. */
export function parseSegment(text: string): LogRead {
  const entries: LogEntry[] = [];
  let skipped = 0;
  const lines = text.split('\n');
  // The part after the last newline is a torn write, never an entry.
  if (lines.at(-1) !== '') skipped++;
  for (const line of lines.slice(0, -1)) {
    if (line === '') continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) entries.push(value as LogEntry);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

export async function readLog(layout: StoreLayout, kind: LogKind): Promise<LogRead> {
  const entries: LogEntry[] = [];
  let skipped = 0;
  for (const file of await segmentFiles(layout, kind)) {
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const read = parseSegment(text);
    entries.push(...read.entries);
    skipped += read.skipped;
  }
  return { entries, skipped };
}

export interface LogWriter {
  /** Appends already gated lines; returns the bytes written. */
  appendLines(lines: readonly string[]): Promise<number>;
}

export function createLogWriter(
  layout: StoreLayout,
  kind: LogKind,
  sessionId: string,
  repairs?: ModeRepairs,
): LogWriter {
  const dir = logDirectory(layout, kind);
  const session = checkSessionId(sessionId);
  let sequence: number | undefined;
  let size = 0;
  let needsNewline = false;

  const segment = (n: number) => join(dir, `${session}.${String(n).padStart(4, '0')}.jsonl`);

  async function locate(): Promise<number> {
    await ensurePrivateDir(dir, layout.roots.data, repairs);
    let last = 0;
    for (const name of await fsp.readdir(dir)) {
      const match = SEGMENT_NAME.exec(name);
      if (match && match[1] === session) last = Math.max(last, Number(match[2]));
    }
    const n = Math.max(1, last);
    try {
      const st = await fsp.stat(segment(n));
      size = st.size;
      if (size > 0) {
        const handle = await fsp.open(segment(n), 'r');
        try {
          const tail = new Uint8Array(1);
          await handle.read(tail, 0, 1, size - 1);
          needsNewline = tail[0] !== 0x0a;
        } finally {
          await handle.close();
        }
      }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      size = 0;
    }
    return n;
  }

  return {
    async appendLines(lines) {
      if (lines.length === 0) return 0;
      sequence ??= await locate();
      let data = `${needsNewline ? '\n' : ''}${lines.join('\n')}\n`;
      if (size > 0 && size + Buffer.byteLength(data) > SEGMENT_BYTES) {
        sequence++;
        size = 0;
        data = `${lines.join('\n')}\n`;
      }
      const path = segment(sequence);
      // Opened per append, never kept: after `murmo data delete` rewrites a
      // segment, the next append lands in the new file, not the unlinked one.
      const handle = await fsp.open(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
        FILE_MODE,
      );
      try {
        await repairOpenFile(handle, path, repairs);
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      const bytes = Buffer.byteLength(data);
      size += bytes;
      needsNewline = false;
      return bytes;
    },
  };
}

/**
 * Rewrites every segment of `kind` without the entries `drop` selects, each
 * with temp + rename; an emptied segment is removed. Returns entries removed.
 */
export async function compactLog(
  layout: StoreLayout,
  kind: LogKind,
  drop: (entry: LogEntry) => boolean,
): Promise<{ removedEntries: number; rewrittenFiles: number; removedFiles: number }> {
  let removedEntries = 0;
  let rewrittenFiles = 0;
  let removedFiles = 0;
  for (const file of await segmentFiles(layout, kind)) {
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const { entries } = parseSegment(text);
    const kept = entries.filter((entry) => !drop(entry));
    const dropped = entries.length - kept.length;
    if (dropped === 0) continue;
    removedEntries += dropped;
    if (kept.length === 0) {
      await fsp.rm(file, { force: true });
      removedFiles++;
    } else {
      await writeAtomic(file, `${kept.map((e) => JSON.stringify(e)).join('\n')}\n`);
      rewrittenFiles++;
    }
  }
  return { removedEntries, rewrittenFiles, removedFiles };
}
