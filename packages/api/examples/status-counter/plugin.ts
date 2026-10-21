// Status counter: the smallest useful plugin. `draft:read` is typed-only, but
// masking keeps the length, so a counter needs nothing more.
import type { PluginFactory } from '@murmo/api';

export default (() => ({
  name: 'status-counter',
  version: '1.0.0',
  permissions: ['draft:read'],
  onChange(change, ctx) {
    if (!ctx.host.caps.status) return [];
    const length = change.draft.text.length;
    return [{ type: 'status', text: `${length} chars`, baseVersion: change.draft.version }];
  },
})) satisfies PluginFactory;
