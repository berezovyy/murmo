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

/** Third-party writes need a host that can show the review panel (phase 32). */
export function reviewCapabilityGate(caps: () => HostCapabilities, notice: (text: string) => void): CommitGate {
  return {
    name: 'review-capability',
    check(request: CommitRequest): string | null {
      if (request.plugin.builtin) return null;
      if (caps().ui.review) return null;
      notice(`Plugin ${request.plugin.id}: this host cannot show a review of plugin edits`);
      return 'review';
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
