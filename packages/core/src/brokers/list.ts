// Project listing: snapshot id, paging, metadata quota (E11). Memory fake
// for tests; the Node walk and the helper broker share the same statuses.

import { LIMITS, type ProjectListQuery, type ProjectListResult } from '@murmo/api';

export interface MemoryListFile {
  readonly path: string;
  readonly bytes: number;
  readonly directory: boolean;
}

export interface MemoryListOptions {
  readonly files?: readonly MemoryListFile[];
  readonly snapshotId?: string;
}

export interface ProjectListAccess {
  list(pluginId: string, query?: ProjectListQuery): Promise<ProjectListResult>;
}

export function denyList(reason = 'project:list must be declared, granted and brokered'): ProjectListAccess {
  return {
    list: async () => ({ status: 'denied', reason }),
  };
}

export function createMemoryList(options: MemoryListOptions = {}): ProjectListAccess {
  const files = [...(options.files ?? [])];
  const snapshotId = options.snapshotId ?? 'snap-1';
  const meta = JSON.stringify(files.map((f) => f.path)).length;
  return {
    async list(_pluginId, query = {}) {
      if (files.length > LIMITS.projectListEntries || meta > LIMITS.projectListBytes) {
        return { status: 'quota', reason: 'listing metadata quota exceeded' };
      }
      const prefix = query.prefix ?? '';
      if (prefix.includes('..') || prefix.startsWith('/') || prefix.includes('\\')) {
        return { status: 'denied', reason: 'path must be relative, with no traversal' };
      }
      const matched = files.filter((f) => !prefix || f.path === prefix || f.path.startsWith(prefix));
      const offset = Math.max(0, query.offset ?? 0);
      const limit = Math.min(LIMITS.projectListPage, Math.max(1, query.limit ?? LIMITS.projectListPage));
      return {
        status: 'ok',
        snapshotId,
        entries: matched.slice(offset, offset + limit),
        total: matched.length,
        offset,
      };
    },
  };
}
