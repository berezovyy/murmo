// A third-party plugin as `murmo plugin new` writes one, installed with
// `murmo plugin add`: it holds any send whose typed text says zzhold, which
// every host shows the same way (no request reaches the model).
export default () => ({
  name: 'send-hold',
  version: '1.0.0',
  permissions: ['draft:read', 'submit'],
  onBeforeSubmit(tx) {
    return /zzhold/.test(tx.draft.text)
      ? { action: 'block', reason: 'send-hold: the prompt says zzhold' }
      : { action: 'send' };
  },
});
