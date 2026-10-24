// OpenCode V2 `/tui` entry. Loaded only by the host, which resolves
// `@opentui/core`. Unit tests call `createTuiPlugin` with fakes instead.

import { TextareaRenderable, TextRenderable } from '@opentui/core';
import { createTuiPlugin } from './plugin.ts';
import { followHostSession, hostSessionOptions, prepareRescue } from './session.ts';
import type { OpenCodeApi } from './types.ts';

const PLUGIN_ID = 'murmo';

export default {
  id: PLUGIN_ID,
  async setup(api: OpenCodeApi) {
    const { recheck, ...options } = await hostSessionOptions(() => followHostSession());
    // Rescue outlives config reloads, so it reads the flag of the latest load.
    let latest = options.config;
    const follow = recheck
      ? {
          recheck: async () => {
            const next = await recheck();
            if (next) latest = next.effective;
            return next;
          },
        }
      : {};
    let rescue: Awaited<ReturnType<typeof prepareRescue>> | undefined;
    try {
      rescue = await prepareRescue(undefined, undefined, () => latest?.private === true);
    } catch {
      // Fail open: no file store means drafts stay in memory for this session.
    }
    const handle = await createTuiPlugin(
      api,
      { TextareaRenderable, TextRenderable },
      { ...options, ...follow, ...(rescue ? { rescue } : {}) },
    );
    return () => handle.dispose();
  },
};
