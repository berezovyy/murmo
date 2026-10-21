// `murmo.prioritize` through public `keymap.layer` (E11). Phase 25 owns the
// handoff policy; this only registers the command so a later peer can call it.

import type { OpenCodeApi } from './types.ts';

export function registerPrioritize(api: OpenCodeApi, reprepend: () => void): () => void {
  try {
    return api.keymap.layer(() => ({
      commands: [{ id: 'murmo.prioritize', title: 'Give Murmo current key priority', run: reprepend }],
    }));
  } catch {
    return () => {};
  }
}
