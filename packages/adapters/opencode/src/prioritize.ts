// `murmo.prioritize` through public `keymap.layer` (E11). Phase 25 owns the
// handoff policy; this only registers the command so a later peer can call it.

import type { OpenCodeApi } from './types.ts';

export function registerPrioritize(api: OpenCodeApi, reprepend: () => void): () => void {
  try {
    const off = api.keymap.layer(() => ({
      commands: [{ id: 'murmo.prioritize', title: 'Give Murmo current key priority', run: reprepend }],
    }));
    // OpenCode 2.1 returns nothing and drops the layer with the plugin; calling
    // the missing result threw at every quit ("off is not a function").
    return typeof off === 'function' ? off : () => {};
  } catch {
    return () => {};
  }
}
