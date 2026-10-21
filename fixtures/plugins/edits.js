// Plugins for the phase 05 edit cases (fixtures/core/edits/edits.json): new,
// in the 2.0-pre plugin shape. `settings.mode` picks one. Test code: loaded
// only by conformance runs.
//
// - `once`: the first time a typed change leaves `trigger` (default `go`)
//   right before the cursor, replace it with `insert`, optionally after
//   `delayMs` on the plugin clock; `range: "invalid"` ends the edit past the
//   draft (a malformed result the core must refuse).
// - `append`: the first time the draft is exactly `after`, insert `insert` at
//   the cursor (two of these make interleaved edits; the prototype fuzz did it).
// - `record`: reads the full draft and stores every change it is given, so a
//   case can see the ordered deltas of a merged change.

export default (settings = {}) => {
  const mode = settings.mode;
  if (mode === 'once') {
    const trigger = settings.trigger ?? 'go';
    let done = false;
    return {
      name: 'edits',
      version: '1',
      permissions: ['draft:read', 'draft:write'],
      async onChange(change, ctx) {
        const d = change.draft;
        if (done || change.origin !== 'typed' || !d.text.slice(0, d.cursor).endsWith(trigger)) return [];
        done = true;
        if (settings.delayMs) await ctx.clock.sleep(settings.delayMs, ctx.signal);
        const from = d.cursor - trigger.length;
        const to = settings.range === 'invalid' ? d.text.length + 5 : d.cursor;
        const insert = settings.insert ?? 'GO';
        return [{ type: 'edit', edit: { from, to, insert, baseVersion: d.version, undoable: true, label: 'once' } }];
      },
    };
  }
  if (mode === 'append') {
    let done = false;
    return {
      name: 'append',
      version: '1',
      // Full reads: the draft it waits for may hold another plugin's insert, which typed-only reads mask.
      permissions: ['draft:read:full', 'draft:write'],
      onChange(change) {
        const d = change.draft;
        if (done || d.text !== settings.after) return [];
        done = true;
        const edit = { from: d.cursor, to: d.cursor, insert: settings.insert, baseVersion: d.version, undoable: true };
        return [{ type: 'edit', edit }];
      },
    };
  }
  if (mode === 'record') {
    const changes = [];
    return {
      name: 'record',
      version: '1',
      permissions: ['draft:read:full'],
      onChange(change, ctx) {
        changes.push({ origin: change.origin, text: change.draft.text, deltas: change.deltas ?? null });
        return ctx.storage.set('changes', changes).then(() => []);
      },
    };
  }
  throw new Error(`edits fixture plugin: unknown mode ${JSON.stringify(mode)}`);
};
