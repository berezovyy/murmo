// Pi extension entry. Compiled to dist/node/pi.js (Jiti's cold transpile
// wrote a temp cache in round 13). session_start continues only in tui mode.

import { readSlot, writeSlot } from './global.ts';
import { type StartOptions, startPiSession } from './session.ts';
import type { EditorBase, PiHost, PiSessionContext, TuiApi } from './types.ts';

export { createPiAdapter, PiAdapter } from './adapter.ts';
export { wrapDataProperty } from './callbacks.ts';
export { detectCursorFormat } from './cursor.ts';
export { fromPiKeyId } from './keys.ts';
export { loadBuiltins } from './plugins.ts';
export { startPiSession } from './session.ts';
export { PI_SLOT } from './types.ts';

async function loadHostApis(): Promise<{ Base: EditorBase; tuiApi: TuiApi; version: string }> {
  const coding = await import('@earendil-works/pi-coding-agent');
  const tui = await import('@earendil-works/pi-tui');
  return {
    Base: coding.CustomEditor,
    tuiApi: {
      CURSOR_MARKER: tui.CURSOR_MARKER,
      parseKey: tui.parseKey,
      renderFakeCursor: tui.renderFakeCursor,
      truncateToWidth: tui.truncateToWidth,
      visibleWidth: tui.visibleWidth,
    },
    version: typeof coding.VERSION === 'string' ? coding.VERSION : '1.3.0',
  };
}

export async function installOnSession(
  pi: PiHost,
  ctx: PiSessionContext,
  apis: { Base: EditorBase; tuiApi: TuiApi; version: string },
  options: Omit<StartOptions, 'Base' | 'tuiApi' | 'ctx' | 'pi' | 'version'> = {},
): Promise<() => Promise<void>> {
  const previous = readSlot();
  if (previous) {
    previous.off();
    await previous.started.dispose();
    writeSlot(undefined);
  }
  const started = await startPiSession({
    ...options,
    Base: apis.Base,
    tuiApi: apis.tuiApi,
    ctx,
    pi,
    version: apis.version,
  });
  const offShutdown = pi.on('session_shutdown', async () => {
    offShutdown();
    const slot = readSlot();
    if (slot?.started === started) writeSlot(undefined);
    await started.dispose();
  });
  writeSlot({ started, off: offShutdown });
  return async () => {
    offShutdown();
    writeSlot(undefined);
    await started.dispose();
  };
}

export default function murmoPi(pi: PiHost): void {
  pi.on('session_start', async (_event, raw) => {
    const ctx = raw as PiSessionContext;
    if (ctx.mode !== 'tui') return;
    const apis = await loadHostApis();
    await installOnSession(pi, ctx, apis);
  });
}
