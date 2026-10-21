// Synthetic `memhog` plugin, ported from experiments/platform/shared-v2/synthetic/memhog.ts
// (2.0-pre plugin shape). Test code: loaded only by conformance runs.

const held = [];
/** Touches 200 MiB on activation: the 8 MiB guest memory cap must stop it. */
export default () => ({
  name: 'memhog',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  activate() {
    const bytes = new Uint8Array(200 * 1024 * 1024);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = 1;
    held.push(bytes);
    return [];
  },
});
