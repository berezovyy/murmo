// Write-ahead install journal: `<data>/install.json`, 0600, temp-then-rename.
// Holds known config files only, never histories or transcripts (docs/plan/27).

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { type HostName, type PathMeta, sha256Bytes } from './home.ts';

export const JOURNAL_SCHEMA = 1 as const;

export interface Backup {
  readonly bytes_b64: string;
  readonly mode: number;
  readonly sha256: string;
}

export interface WrittenFile {
  readonly sha256: string;
  readonly mode: number;
}

export interface HostProbe {
  readonly name: HostName;
  readonly installed: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly skipped?: string;
}

export interface CommandResult {
  readonly argv: string[];
  readonly status: number | null;
  readonly ms: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
  readonly host?: string;
}

export interface LauncherRecord {
  readonly path: string;
  readonly sha256: string;
}

export interface Journal {
  schema: typeof JOURNAL_SCHEMA;
  complete: boolean;
  phase: string;
  before: Record<string, PathMeta>;
  parents: Record<string, boolean>;
  backup: Record<string, Backup>;
  written: Record<string, WrittenFile>;
  hosts: HostProbe[];
  results: CommandResult[];
  skipped: { host: string; reason: string }[];
  package: { version: string; sha256: string };
  launcher?: LauncherRecord;
  generations: string[];
}

export function emptyJournal(pkg: Journal['package']): Journal {
  return {
    schema: JOURNAL_SCHEMA,
    complete: false,
    phase: 'initial',
    before: {},
    parents: {},
    backup: {},
    written: {},
    hosts: [],
    results: [],
    skipped: [],
    package: pkg,
    generations: [],
  };
}

export function writeJournal(file: string, value: Journal): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function readJournal(file: string): Journal | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<Journal>;
    if (value.schema !== JOURNAL_SCHEMA || typeof value.phase !== 'string') return undefined;
    return {
      schema: JOURNAL_SCHEMA,
      complete: value.complete === true,
      phase: value.phase,
      before: value.before ?? {},
      parents: value.parents ?? {},
      backup: value.backup ?? {},
      written: value.written ?? {},
      hosts: value.hosts ?? [],
      results: value.results ?? [],
      skipped: value.skipped ?? [],
      package: value.package ?? { version: '', sha256: '' },
      generations: value.generations ?? [],
      ...(value.launcher ? { launcher: value.launcher } : {}),
    };
  } catch {
    return undefined;
  }
}

export function backupFile(path: string): Backup {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`unsupported config ${path}`);
  const bytes = readFileSync(path);
  return { bytes_b64: bytes.toString('base64'), mode: st.mode & 0o777, sha256: sha256Bytes(bytes) };
}

export function snapshotFile(path: string): WrittenFile | undefined {
  if (!existsSync(path)) return undefined;
  const st = lstatSync(path);
  if (!st.isFile()) return undefined;
  return { sha256: sha256Bytes(readFileSync(path)), mode: st.mode & 0o777 };
}

export function maybePause(phase: string, env: NodeJS.ProcessEnv): void {
  if (env.MURMO_TEST_PAUSE_PHASE !== phase) return;
  process.stderr.write(`PAUSED ${phase}\n`);
  const until = Date.now() + 30_000;
  while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}

export function setPhase(journal: Journal, file: string, phase: string, env: NodeJS.ProcessEnv): void {
  journal.phase = phase;
  writeJournal(file, journal);
  maybePause(phase, env);
}
