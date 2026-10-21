// Synthetic `stale` plugin, ported from experiments/platform/shared-v2/synthetic/stale.ts
// (2.0-pre plugin shape). Test code: loaded only by conformance runs.

/** Returns every effect against the previous version: all of it must be dropped (C3). */
export default () => ({
  name: 'stale',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  onChange(change) {
    const baseVersion = change.draft.version - 1;
    return [
      { type: 'edit', edit: { from: 0, to: 0, insert: 'stale', baseVersion } },
      { type: 'ghost', text: 'stale', baseVersion },
      { type: 'menu', items: [{ id: 'stale', label: 'stale' }], baseVersion },
      { type: 'highlight', ranges: [[0, 1]], baseVersion },
    ];
  },
});
