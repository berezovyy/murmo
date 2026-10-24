// A third-party plugin as `murmo plugin new` writes one, installed with
// `murmo plugin add`: it holds any send whose typed text says zzhold, which
// every host shows the same way (no request reaches the model), and keeps
// the held text in its storage, which must outlive the session.
export default () => ({
  name: 'send-hold',
  version: '1.0.0',
  permissions: ['draft:read', 'submit'],
  async onBeforeSubmit(tx, ctx) {
    if (!/zzhold/.test(tx.draft.text)) return { action: 'send' };
    await ctx.storage.set('lastHeld', tx.draft.text);
    return { action: 'block', reason: 'send-hold: the prompt says zzhold' };
  },
});
