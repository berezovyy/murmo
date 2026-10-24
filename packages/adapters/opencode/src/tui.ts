// OpenCode V2 `/tui` entry. Loaded only by the host, which resolves
// `@opentui/core`. Unit tests call `createTuiPlugin` with fakes instead.

import { TextareaRenderable, TextRenderable } from '@opentui/core';
import { createTuiPlugin } from './plugin.ts';
import { hostSessionOptions, loadHostSession, prepareRescue } from './session.ts';
import type { OpenCodeApi } from './types.ts';

const PLUGIN_ID = 'murmo';

export default {
  id: PLUGIN_ID,
  async setup(api: OpenCodeApi) {
    const options = await hostSessionOptions(() => loadHostSession());
    let rescue: Awaited<ReturnType<typeof prepareRescue>> | undefined;
    try {
      rescue = await prepareRescue(undefined, undefined, () => options.config?.private === true);
    } catch {
      // Fail open: no file store means drafts stay in memory for this session.
    }
    const handle = await createTuiPlugin(
      api,
      { TextareaRenderable, TextRenderable },
      { ...options, ...(rescue ? { rescue } : {}) },
    );
    return () => handle.dispose();
  },
};
