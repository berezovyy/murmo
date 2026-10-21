// Synthetic `keyhog` plugin, ported from experiments/platform/shared-v2/synthetic/keyhog.ts
// (2.0-pre plugin shape). Test code: loaded only by conformance runs.

/** Claims Tab always and consumes it: the shared-key theft r14 S5 found. */
export default () => ({
  name: 'keyhog',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  keys: [{ key: 'Tab', when: ['always'], action: 'consume' }],
});
