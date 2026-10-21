// Project reads: portable broker interface plus an in-memory fake. The Node
// implementation (realpath, O_NOFOLLOW, digest-pinned trust) lives in
// `src/node/project-files.ts`. Approval happens before activation, never
// inside a hook (lesson 55).

import { type Cancellation, LIMITS, type ProjectAccess, type ProjectChange, type ProjectReadResult } from '@murmo/api';
import type { ProjectFiles, Unsubscribe } from '@murmo/api/adapter';

const denied = (reason: string): ProjectReadResult => ({ status: 'denied', reason });

/** Always-deny access for plugins without `fs:project-read` or a broker. */
export function denyProject(reason = 'fs:project-read must be declared, granted and brokered'): ProjectAccess {
  return {
    read: async () => denied(reason),
  };
}

export interface MemoryProjectFile {
  readonly text: string;
  readonly sha256?: string;
}

export interface MemoryProjectOptions {
  readonly root?: string;
  readonly files?: Readonly<Record<string, MemoryProjectFile | string>>;
  readonly approved?: ReadonlySet<string> | readonly string[];
  readonly requestTrust?: (pluginId: string, path: string) => boolean | Promise<boolean>;
}

function asFile(value: MemoryProjectFile | string): MemoryProjectFile {
  return typeof value === 'string' ? { text: value } : value;
}

/** In-memory project tree for tests; same statuses as the Node broker. */
export function createMemoryProjectFiles(options: MemoryProjectOptions = {}): ProjectFiles {
  const files = new Map<string, MemoryProjectFile>(
    Object.entries(options.files ?? {}).map(([path, value]) => [path, asFile(value)]),
  );
  const approved = new Set<string>(options.approved instanceof Set ? options.approved : (options.approved ?? []));
  const usage = new Map<string, { bytes: number; reads: number }>();
  const listeners = new Set<(event: ProjectChange) => void>();
  let disposed = false;
  const maxFileBytes = LIMITS.projectFileBytes;
  const maxReadBytes = LIMITS.projectSessionBytes;
  const maxReads = LIMITS.projectReads;

  const result = (status: ProjectReadResult['status'], reason: string): ProjectReadResult => ({ status, reason });

  return {
    root: options.root ?? '/project',
    limits: { maxFileBytes, maxReadBytes, maxReads },
    async authorize(pluginId, path = '.murmo.toml') {
      if (approved.has(pluginId)) return true;
      if (options.requestTrust && !(await options.requestTrust(pluginId, path))) return false;
      if (!files.has(path) && path === '.murmo.toml') {
        approved.add(pluginId);
        return true;
      }
      if (!files.has(path)) return false;
      approved.add(pluginId);
      return true;
    },
    async read(pluginId, path, signal?: Cancellation) {
      if (signal?.cancelled) return result('cancelled', 'cancelled');
      if (disposed) return result('denied', 'broker disposed');
      if (!approved.has(pluginId))
        return result('approval-required', 'project approval required; authorize outside the Executor deadline');
      if (
        typeof path !== 'string' ||
        !path ||
        path.includes('\\') ||
        path.includes('\0') ||
        path.startsWith('/') ||
        path.split('/').some((part) => part === '..')
      ) {
        return result('denied', 'path must be relative, with no traversal');
      }
      const u = usage.get(pluginId) ?? { bytes: 0, reads: 0 };
      if (u.reads >= maxReads || u.bytes >= maxReadBytes) return result('quota', 'project read budget exhausted');
      u.reads++;
      usage.set(pluginId, u);
      const file = files.get(path);
      if (!file) return result('not-found', 'not found');
      const bytes = file.text.length;
      if (bytes > maxFileBytes) return result('too-large', `file exceeds ${maxFileBytes} bytes`);
      if (u.bytes + bytes > maxReadBytes) return result('quota', 'project byte budget exhausted');
      u.bytes += bytes;
      if (signal?.cancelled) return result('cancelled', 'cancelled');
      return {
        status: 'ok',
        text: file.text,
        bytes,
        sha256: file.sha256 ?? '0',
        path,
      };
    },
    onChange(callback: (event: ProjectChange) => void): Unsubscribe {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    async dispose() {
      disposed = true;
      listeners.clear();
      approved.clear();
    },
  };
}
