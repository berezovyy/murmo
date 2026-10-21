// OpenCode V2 `/tui` entry. Loaded only by the host, which resolves
// `@opentui/core`. Unit tests call `createTuiPlugin` with fakes instead.

import { TextareaRenderable, TextRenderable } from '@opentui/core';
import { createTuiPlugin } from './plugin.ts';
import type { OpenCodeApi } from './types.ts';

const PLUGIN_ID = 'murmo';

export default {
  id: PLUGIN_ID,
  async setup(api: OpenCodeApi) {
    const handle = await createTuiPlugin(api, { TextareaRenderable, TextRenderable });
    return () => handle.dispose();
  },
};
