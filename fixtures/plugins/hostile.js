// The hostile plugin of the r14 security suite, ported from
// experiments/platform/security/hostile.mjs (2.0-pre plugin shape).
// `settings.mode` picks the attack. Authored attack code: no ambient OS APIs,
// real secrets or external endpoints. Loaded only by conformance runs.

export default (settings = {}) => {
  const mode = settings.mode || 'edit';
  const permissions = settings.permissions || ['draft:read', 'draft:write', 'submit'];
  let fired = false;
  let count = 0;
  const effect = (d, insert, from = 0, to = d.text.length) => [
    { type: 'edit', edit: { baseVersion: d.version, from, to, insert, undoable: true, label: 'harmless formatting' } },
  ];
  return {
    name: settings.name || 'Security update',
    version: '1.0.0',
    permissions,
    keys: settings.keys || [],
    async activate(ctx) {
      if (mode === 'ambient') {
        const ambient = {
          fetch: typeof fetch,
          network: typeof ctx.network,
          process: typeof process,
          require: typeof require,
          keys: Object.keys(ctx),
          settings: ctx.settings,
        };
        return [{ type: 'status', baseVersion: ctx.draft.version, text: JSON.stringify(ambient) }];
      }
      if (mode === 'storage-victim') {
        await ctx.storage.set('private', 'VICTIM-PRIVATE');
        return [];
      }
      if (mode === 'storage-spy') {
        const out = Object.create(null);
        for (const k of ['private', 'victim/private', '../victim/private', '__proto__', 'constructor']) {
          out[k] = await ctx.storage.get(k);
        }
        out.context = Object.keys(ctx);
        out.settings = ctx.settings;
        out.ui = ctx.ghost || ctx.menu || ctx.plugins || null;
        await ctx.storage.set('probe', JSON.stringify(out));
        await ctx.storage.set('private', 'SPY-PRIVATE');
        return [{ type: 'status', baseVersion: ctx.draft.version, text: JSON.stringify(out) }];
      }
      return [];
    },
    async onChange(c, ctx) {
      const d = c.draft;
      if (mode === 'loop') {
        for (;;) {
          // Never returns: CPU containment must disable this plugin.
        }
      }
      if (mode === 'ghost-only') return [{ type: 'ghost', baseVersion: d.version, text: 'suggestion' }];
      if (mode === 'counter') {
        count += 1;
        return [{ type: 'status', baseVersion: d.version, text: `healthy ${count}` }];
      }
      if (mode === 'capture') {
        await ctx.storage.set('capture', { input: c, draft: ctx.draft, change: ctx.change, settings: ctx.settings });
        return [];
      }
      if (mode === 'ui') {
        const payload = settings.payload;
        return [
          { type: 'status', baseVersion: d.version, text: payload },
          {
            type: 'menu',
            baseVersion: d.version,
            items: [{ id: 'opaque', owner: 'victim', ownerId: 'victim', label: payload, detail: payload }],
          },
          { type: 'ghost', baseVersion: d.version, text: payload },
          { type: 'highlight', baseVersion: d.version, ranges: [[0, Math.min(4, d.text.length)]] },
        ];
      }
      if (mode === 'flood') {
        return [
          {
            type: 'menu',
            baseVersion: d.version,
            items: Array.from({ length: settings.rows || 1000 }, (_, i) => ({ id: String(i), label: `ROW${i}` })),
          },
          { type: 'status', baseVersion: d.version, text: 'x'.repeat(settings.bytes || 4096) },
        ];
      }
      if (c.origin === 'plugin') return [];
      if (mode === 'readd' && d.text === 'keep ') return effect(d, 'keep DELETE-ME');
      if (fired || !d.text.includes(settings.trigger || 'READY')) return [];
      fired = true;
      if (settings.delay) await ctx.clock.sleep(settings.delay);
      if (mode === 'edit') return effect(d, settings.insert ?? d.text.replace("don't", 'do'));
      if (mode === 'offscreen') return effect(d, 'DO', 0, 4);
      if (mode === 'zero') return effect(d, `${d.text}\u{200B}`);
      if (mode === 'homoglyph') return effect(d, d.text.replace('pay', 'p\u{430}y'));
      return [];
    },
    onBeforeSubmit(tx) {
      if (mode === 'submit') return { action: 'replace', text: tx.draft.text.replace("don't", 'do') };
      return { action: 'send' };
    },
  };
};
