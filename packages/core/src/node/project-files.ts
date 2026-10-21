// Node/Bun project-file broker: project root only, no symlink escapes,
// regular files, UTF-8, digest-pinned approval revoked when `.murmo.toml`
// changes (lessons 55, 60). Never imported by the portable core bundle.

import { createHash } from 'node:crypto';
import { constants, watch as watchFs } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Cancellation, ProjectChange, ProjectReadResult } from '@murmo/api';
import { LIMITS } from '@murmo/api';
import type { ProjectFiles, ProjectTrustRequest, StorageBackend, Unsubscribe } from '@murmo/api/adapter';

export interface ProjectFileBrokerOptions {
  readonly root: string;
  readonly requestTrust: (request: ProjectTrustRequest) => boolean | Promise<boolean>;
  readonly maxFileBytes?: number;
  readonly maxReadBytes?: number;
  readonly maxReads?: number;
  readonly timeoutMs?: number;
}

const result = (status: ProjectReadResult['status'], reason: string): ProjectReadResult => ({ status, reason });

export async function createProjectFileBroker(options: ProjectFileBrokerOptions): Promise<ProjectFiles> {
  const root = await realpath(options.root);
  const maxFileBytes = options.maxFileBytes ?? LIMITS.projectFileBytes;
  const maxReadBytes = options.maxReadBytes ?? LIMITS.projectSessionBytes;
  const maxReads = options.maxReads ?? LIMITS.projectReads;
  const timeoutMs = options.timeoutMs ?? 250;
  const approved = new Map<string, string>();
  const usage = new Map<string, { bytes: number; reads: number }>();
  const listeners = new Set<(event: ProjectChange) => void>();
  let disposed = false;
  let version = 0;

  async function load(relative: string): Promise<ProjectReadResult> {
    if (disposed) return result('denied', 'broker disposed');
    if (
      typeof relative !== 'string' ||
      !relative ||
      relative.length > 4096 ||
      relative.includes('\\') ||
      relative.includes('\0') ||
      path.isAbsolute(relative) ||
      /^[A-Za-z]:/.test(relative) ||
      relative.split('/').some((part) => part === '..')
    ) {
      return result('denied', 'path must be relative, with no traversal');
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const canonical = await realpath(path.join(root, relative));
      if (canonical !== root && !canonical.startsWith(root + path.sep)) {
        return result('denied', 'resolved path escapes project root');
      }
      const before = await stat(canonical);
      if (!before.isFile()) return result('denied', 'regular files only');
      if (before.size > maxFileBytes) return result('too-large', `file exceeds ${maxFileBytes} bytes`);
      handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const actual = await handle.stat();
      if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino || actual.size > maxFileBytes) {
        return result('denied', 'file identity changed before read');
      }
      const bytes = Buffer.alloc(Math.min(maxFileBytes + 1, actual.size + 1));
      let used = 0;
      while (used < bytes.length) {
        const read = await handle.read(bytes, used, bytes.length - used, used);
        if (!read.bytesRead) break;
        used += read.bytesRead;
      }
      if (used > maxFileBytes) return result('too-large', 'file grew beyond limit');
      const after = await handle.stat();
      if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs) {
        return result('denied', 'file changed during read');
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used));
      } catch {
        return result('invalid-utf8', 'project files must be UTF-8');
      }
      return {
        status: 'ok',
        text,
        bytes: used,
        sha256: createHash('sha256').update(bytes.subarray(0, used)).digest('hex'),
        path: relative,
      };
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      return result(code === 'ENOENT' ? 'not-found' : 'denied', code ?? 'project read failed');
    } finally {
      await handle?.close();
    }
  }

  async function bounded(relative: string): Promise<ProjectReadResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        load(relative),
        new Promise<ProjectReadResult>((resolve) => {
          timer = setTimeout(() => resolve(result('timeout', 'project read deadline')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  let fingerprint = (await bounded('.murmo.toml')).sha256;
  const watcher = watchFs(root, { persistent: false }, (_event, name) => {
    if (String(name) !== '.murmo.toml') return;
    void bounded('.murmo.toml').then((file) => {
      const next = file.status === 'ok' ? file.sha256 : undefined;
      if (disposed || next === fingerprint) return;
      fingerprint = next;
      approved.clear();
      const event: ProjectChange = { path: '.murmo.toml', version: ++version, reason: 'changed' };
      for (const fn of listeners) fn(event);
    });
  });

  return {
    root,
    limits: { maxFileBytes, maxReadBytes, maxReads },
    async authorize(pluginId, relative = '.murmo.toml') {
      if (approved.has(pluginId)) return true;
      const file = await bounded(relative);
      if (file.status !== 'ok') return false;
      const request: ProjectTrustRequest = {
        pluginId,
        root,
        path: relative,
        sha256: file.sha256 ?? '',
        bytes: file.bytes ?? 0,
        message: `Allow ${pluginId} to read project files under ${root}? Up to ${maxFileBytes} bytes/file, ${maxReadBytes} bytes and ${maxReads} reads per session. Project snippets are data, never shell commands. Changes to .murmo.toml require approval again.`,
      };
      if (await options.requestTrust(request)) {
        const current = await bounded(relative);
        if (current.status !== 'ok' || current.sha256 !== file.sha256) return false;
        approved.set(pluginId, file.sha256 ?? '');
        return true;
      }
      return false;
    },
    async read(pluginId, relative, signal?: Cancellation) {
      if (signal?.cancelled) return result('cancelled', 'cancelled');
      if (!approved.has(pluginId)) {
        return result('approval-required', 'project approval required; authorize outside the Executor deadline');
      }
      const u = usage.get(pluginId) ?? { bytes: 0, reads: 0 };
      if (u.reads >= maxReads || u.bytes >= maxReadBytes) return result('quota', 'project read budget exhausted');
      u.reads++;
      usage.set(pluginId, u);
      const read = await bounded(relative);
      if (signal?.cancelled) return result('cancelled', 'cancelled');
      if (read.status === 'ok') {
        if (relative === '.murmo.toml' && read.sha256 !== approved.get(pluginId)) {
          approved.delete(pluginId);
          return result('approval-required', 'config changed since approval');
        }
        if (u.bytes + (read.bytes ?? 0) > maxReadBytes) return result('quota', 'project byte budget exhausted');
        u.bytes += read.bytes ?? 0;
      }
      return read;
    },
    onChange(callback: (event: ProjectChange) => void): Unsubscribe {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    async dispose() {
      disposed = true;
      watcher.close();
      listeners.clear();
      approved.clear();
    },
  };
}

/** Durable JSON backend under an app-data directory the caller owns, never a project path. */
export async function createFileStorage(directory: string): Promise<StorageBackend> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = (id: string) => path.join(directory, `${createHash('sha256').update(id).digest('hex')}.json`);
  return {
    async load(id) {
      try {
        return await readFile(filename(id), 'utf8');
      } catch (error) {
        if ((error as { code?: string } | null)?.code === 'ENOENT') return '{}';
        throw error;
      }
    },
    async save(id, json) {
      const target = filename(id);
      const temp = `${target}.tmp`;
      await writeFile(temp, json, { mode: 0o600 });
      await rename(temp, target);
    },
  };
}
