// Synthetic `thrower` plugin, ported from experiments/platform/shared-v2/synthetic/thrower.ts
// (2.0-pre plugin shape). Test code: loaded only by conformance runs.

/** Throws on every change: it must be disabled without hurting its peers (C12). */
export default () => ({
  name: 'thrower',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  onChange() {
    throw new Error('synthetic thrower');
  },
});
