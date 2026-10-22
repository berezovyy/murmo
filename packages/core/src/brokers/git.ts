// Read-only git queries. Memory fake for tests; the helper runs git inside
// the trusted project root (FEEDBACK C3).

import type { GitAccess, GitQuery, GitResult } from '@murmo/api';

export interface MemoryGitState {
  readonly branch?: string;
  readonly dirty?: boolean;
  readonly ahead?: number;
  readonly behind?: number;
  readonly subjects?: readonly string[];
  readonly paths?: readonly string[];
}

export function denyGit(reason = 'project:git must be declared, granted and brokered'): GitAccess {
  return {
    query: async () => ({ status: 'denied', reason }),
  };
}

export function createMemoryGit(state: MemoryGitState = {}): GitAccess {
  return {
    async query(spec: GitQuery): Promise<GitResult> {
      if (spec.kind === 'branch') return { status: 'ok', branch: state.branch ?? 'main' };
      if (spec.kind === 'status') {
        return {
          status: 'ok',
          branch: state.branch ?? 'main',
          dirty: state.dirty === true,
          ahead: state.ahead ?? 0,
          behind: state.behind ?? 0,
        };
      }
      if (spec.kind === 'log') {
        const limit = Math.min(20, Math.max(1, spec.limit ?? 10));
        return { status: 'ok', subjects: (state.subjects ?? []).slice(0, limit) };
      }
      return { status: 'ok', paths: state.paths ?? [] };
    },
  };
}
