// Synthetic `slow50` plugin, ported from experiments/platform/shared-v2/synthetic/slow50.ts
// (2.0-pre plugin shape). Test code: loaded only by conformance runs.

/** Inserts `slow` at the start 50 ms after each typed change: only the latest result may apply (C3). */
export default () => ({
  name: 'slow50',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  async onChange(change, ctx) {
    if (change.origin !== 'typed') return [];
    await ctx.clock.sleep(50, ctx.signal);
    return [{ type: 'edit', edit: { from: 0, to: 0, insert: 'slow', baseVersion: change.draft.version } }];
  },
});
