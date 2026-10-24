// `murmo uninstall`: refuse live sessions and changed configs, then replay
// the journal so HOME matches the pre-setup inventory (r13 R3 / E5). Never
// touch an npm cache that existed before.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { CliError } from './errors.ts';
import { type HomeLayout, homeLayout, inventoryOf, ownedRoots, sha256Bytes } from './home.ts';
import type { Journal } from './journal.ts';
import { readJournal } from './journal.ts';
import { processAlive } from './lock.ts';

export interface UninstallOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly json?: boolean;
}

export interface UninstallReport {
  readonly status: 'uninstalled' | 'absent';
}

export interface SessionRecord {
  readonly pid?: number;
  readonly host?: { readonly name?: string } | string;
  readonly healthy?: boolean;
}

function sessionHost(record: SessionRecord): string {
  if (typeof record.host === 'string') return record.host;
  return record.host?.name ?? 'session';
}

export function liveSessions(layout: HomeLayout): { pid: number; host: string; record: Record<string, unknown> }[] {
  if (!existsSync(layout.sessions)) return [];
  const live: { pid: number; host: string; record: Record<string, unknown> }[] = [];
  for (const name of readdirSync(layout.sessions).filter((n) => n.endsWith('.json'))) {
    try {
      const record = JSON.parse(readFileSync(`${layout.sessions}/${name}`, 'utf8')) as SessionRecord &
        Record<string, unknown>;
      const pid = record.pid;
      if (typeof pid !== 'number') continue;
      if (processAlive(pid)) live.push({ pid, host: sessionHost(record), record });
    } catch {
      // ignore unreadable session files
    }
  }
  return live;
}

export function changedConfigs(journal: Journal): string[] {
  const changed: string[] = [];
  for (const [path, written] of Object.entries(journal.written)) {
    if (!existsSync(path)) {
      changed.push(path);
      continue;
    }
    if (sha256Bytes(readFileSync(path)) !== written.sha256) changed.push(path);
  }
  return changed;
}

export function replayJournal(journal: Journal, layout: HomeLayout): void {
  const current = inventoryOf(ownedRoots(layout));
  for (const [file, backup] of Object.entries(journal.backup)) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(backup.bytes_b64, 'base64'));
    chmodSync(file, backup.mode);
  }
  const keep = new Set([...Object.keys(journal.before), ...Object.keys(journal.backup)]);
  for (const file of Object.keys(current).sort((a, b) => b.length - a.length)) {
    if (keep.has(file)) continue;
    try {
      const meta = current[file];
      if (meta?.type === 'dir') rmdirSync(file);
      else unlinkSync(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw error;
    }
  }
  for (const root of [layout.data, layout.state, layout.cache]) {
    rmSync(root, { recursive: true, force: true });
  }
  // The launcher, and the starter murmo.toml unless the user has made it their own.
  for (const owned of [journal.launcher, journal.starter]) {
    if (!owned?.path || !existsSync(owned.path)) continue;
    try {
      if (sha256Bytes(readFileSync(owned.path)) === owned.sha256) unlinkSync(owned.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const [path, existed] of Object.entries(journal.parents).sort((a, b) => b[0].length - a[0].length)) {
    if (existed) continue;
    try {
      rmdirSync(path);
    } catch {
      // still has other children, or already gone
    }
  }
}

export function uninstallCommand(options: UninstallOptions = {}): UninstallReport {
  const env = options.env ?? process.env;
  const layout = homeLayout(env);
  const journal = readJournal(layout.journal);
  if (!journal) return { status: 'absent' };

  const live = liveSessions(layout);
  if (live.length > 0) {
    const host = live[0]?.host ?? 'host';
    throw new CliError(`close active ${host} session before uninstall`, {
      action: `quit ${host} and re-run murmo uninstall`,
    });
  }
  const changed = changedConfigs(journal);
  if (changed.length > 0) {
    throw new CliError(`config changed since setup: ${changed[0]}`, {
      action: 'restore that file to what setup wrote, or uninstall after copying it aside',
    });
  }
  replayJournal(journal, layout);
  return { status: 'uninstalled' };
}

export function printUninstall(report: UninstallReport, json: boolean, out: (s: string) => void): void {
  if (json) out(`${JSON.stringify(report)}\n`);
  else out(`murmo uninstall: ${report.status}\n`);
}
