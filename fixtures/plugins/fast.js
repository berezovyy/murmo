// Synthetic `fast` plugin, ported from experiments/platform/shared-v2/synthetic/fast.ts
// (2.0-pre plugin shape). Test code: loaded only by conformance runs.

/** Does nothing; loaded many times to fill a plugin list. */
export default () => ({
  name: 'fast',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  onChange() {
    return [];
  },
});
