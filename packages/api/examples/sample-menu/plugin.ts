// A typed trigger opens a one-row menu. Where the host has a native completion
// transaction, the row carries a literal `inlineEdit` that the host commits on
// Tab itself; elsewhere Tab routes to `onMenuSelect`, which returns a versioned
// edit. Enter only closes the menu, it never sends.
import type { Capabilities, Draft, Effect, MenuItem, PluginFactory } from '@murmo/api';

const TRIGGER = '~sample';
const INSERT = 'hello';

function triggerStart(d: Draft): number | null {
  const from = d.cursor - TRIGGER.length;
  const typed = d.typedSpans.some(([a, b]) => a <= from && b >= d.cursor);
  return from >= 0 && typed && d.text.slice(from, d.cursor) === TRIGGER ? from : null;
}

function row(d: Draft, from: number, caps: Capabilities): MenuItem {
  const item = { id: 'hello', label: 'Insert hello' };
  if (!caps.inline.nativeCompletion) return item;
  return { ...item, inlineEdit: { baseVersion: d.version, from, to: d.cursor, insert: INSERT, undoable: false } };
}

export default (() => ({
  name: 'sample-menu',
  version: '1.0.0',
  permissions: ['draft:read', 'draft:write'],
  onChange(change, ctx): Effect[] {
    const d = change.draft;
    const caps = ctx.host.caps;
    const from = triggerStart(d);
    const usable = caps.menu && (caps.edit.atomic || caps.inline.nativeCompletion);
    const items = from !== null && usable ? [row(d, from, caps)] : null;
    return [{ type: 'menu', items, baseVersion: d.version }];
  },
  onMenuSelect(item, ctx): Effect[] {
    const d = ctx.draft;
    const from = triggerStart(d);
    if (item.id !== 'hello' || from === null) return [];
    return [{ type: 'edit', edit: { from, to: d.cursor, insert: INSERT, baseVersion: d.version, undoable: true } }];
  },
})) satisfies PluginFactory;
