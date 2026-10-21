// The round 14 host-conflict plugins, ported from
// experiments/platform/hosts-r14/conflicts/{A,B,guard}.mjs (2.0-pre plugin
// shape). `settings.letter` makes plugin A or B; `settings.guard` makes the
// submit guard. Two plugins answer the same trigger text, so plugin order
// decides who wins. Loaded only by conformance runs.

export default (settings = {}) => {
  if (settings.guard) {
    return {
      name: 'r14-guard',
      version: '1',
      guard: true,
      permissions: ['draft:read', 'submit'],
      onBeforeSubmit(tx) {
        return tx.draft.text.startsWith('r14submit-deny')
          ? { action: 'block', reason: `R14 guard saw ${tx.draft.text}` }
          : { action: 'send' };
      },
    };
  }
  const letter = settings.letter;
  const insertAtCursor = (ctx) => [
    {
      type: 'edit',
      edit: {
        from: ctx.draft.cursor,
        to: ctx.draft.cursor,
        insert: letter,
        baseVersion: ctx.draft.version,
        undoable: true,
      },
    },
  ];
  return {
    name: `r14-${letter}`,
    version: '1.0.0',
    permissions: ['draft:read', 'draft:write', 'submit'],
    keys: [{ key: 'F6', when: ['editable', 'ghost-visible-by-me'], action: 'accept-ghost' }],
    onChange(change) {
      const d = change.draft;
      const v = d.version;
      const out = [];
      if (d.text === 'r14key ') out.push({ type: 'ghost', text: letter, baseVersion: v });
      if (d.text === 'r14menu ')
        out.push({ type: 'menu', items: [{ id: 'same-id', label: `${letter} row` }], baseVersion: v });
      if (d.text === 'r14word target ') {
        out.push({ type: 'edit', edit: { from: 8, to: 14, insert: letter, baseVersion: v, undoable: true } });
      }
      if (d.text === 'r14status') out.push({ type: 'status', text: `R14_STATUS_${letter}`, baseVersion: v });
      return out;
    },
    onMenuSelect(item, ctx) {
      return item.id === 'same-id' ? insertAtCursor(ctx) : [];
    },
    onBeforeSubmit(tx) {
      return tx.draft.text.startsWith('r14submit')
        ? { action: 'replace', text: `${tx.draft.text}|${letter}` }
        : { action: 'send' };
    },
  };
};
