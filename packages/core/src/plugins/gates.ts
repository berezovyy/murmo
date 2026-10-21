// Commit gates phase 09 adds next to 08's submit-in-progress window.

import type { HostCapabilities } from '@murmo/api/adapter';
import type { CommitGate, CommitRequest } from '../edits.ts';

export function permissionGate(): CommitGate {
  return {
    name: 'permission',
    check(request: CommitRequest): string | null {
      return request.plugin.effects.has('edit') ? null : 'permission';
    },
  };
}

export function attributionGate(caps: () => HostCapabilities, notice: (text: string) => void): CommitGate {
  return {
    name: 'attribution',
    check(request: CommitRequest): string | null {
      if (request.plugin.builtin) return null;
      if (caps().edit.attributed) return null;
      notice(`Plugin ${request.plugin.id}: this host cannot attribute plugin edits`);
      return 'attribution';
    },
  };
}
