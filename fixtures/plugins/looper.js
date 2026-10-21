// Synthetic `looper` plugin, ported from experiments/platform/shared-v2/synthetic/looper.ts
// (2.0-pre plugin shape). Test code: loaded only by conformance runs.

/** Spins 200 ms on every `x` key: CPU containment must disable it. */
export default () => ({
  name: 'looper',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  keys: [{ key: 'x', when: ['editable'], action: 'dispatch' }],
  onKey() {
    const end = Date.now() + 200;
    while (Date.now() < end) {
      // Busy wait on purpose.
    }
    return [];
  },
});
