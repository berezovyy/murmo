// Pi extension entry. Compiled to dist/node/pi.js (Jiti's cold transpile
// wrote a temp cache in round 13). session_start continues only in tui mode.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSlot, writeSlot } from './global.ts';
import { type StartOptions, startPiSession } from './session.ts';
import type { EditorBase, PiHost, PiSessionContext, TuiApi } from './types.ts';

export { createPiAdapter, PiAdapter } from './adapter.ts';
export { tryWrapDataProperty, wrapDataProperty } from './callbacks.ts';
export { detectCursorFormat } from './cursor.ts';
export { attachPiEvents } from './events.ts';
export { fromPiKeyId } from './keys.ts';
export { loadBuiltins } from './plugins.ts';
export { startPiSession } from './session.ts';
export { PI_SLOT } from './types.ts';

function packageFolder(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

/** Walk from an importer file to `node_modules/<spec>/package.json` and take `exports.import`. */
export function resolvePiSpecifier(specifier: string, importer: string): string | undefined {
  let dir = dirname(importer.startsWith('file:') ? fileURLToPath(importer) : importer);
  const folder = packageFolder(specifier);
  for (;;) {
    const pkgFile = join(dir, 'node_modules', folder, 'package.json');
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
        exports?: string | { '.': string | { import?: string } };
        module?: string;
        main?: string;
      };
      const exp = pkg.exports;
      const entry = typeof exp === 'string' ? exp : exp?.['.'];
      const rel =
        typeof entry === 'string' ? entry : typeof entry?.import === 'string' ? entry.import : (pkg.module ?? pkg.main);
      if (rel) return join(dirname(pkgFile), rel);
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Native import() from the packed `-e` path cannot see `@earendil-works/*`. */
export async function importPiPackage(specifier: string, argv1 = process.argv[1]): Promise<Record<string, unknown>> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch (first) {
    const starts = [
      argv1,
      ...(process.env.NODE_PATH ?? '')
        .split(':')
        .filter(Boolean)
        .map((dir) => join(dir, 'x.js')),
    ];
    for (const start of starts) {
      if (!start) continue;
      const resolved = resolvePiSpecifier(specifier, start);
      if (resolved) return (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
    }
    throw first;
  }
}

async function loadHostApis(): Promise<{ Base: EditorBase; tuiApi: TuiApi; version: string }> {
  const coding = await importPiPackage('@earendil-works/pi-coding-agent');
  const tui = await importPiPackage('@earendil-works/pi-tui');
  return {
    Base: coding.CustomEditor as EditorBase,
    tuiApi: {
      CURSOR_MARKER: tui.CURSOR_MARKER as TuiApi['CURSOR_MARKER'],
      parseKey: tui.parseKey as TuiApi['parseKey'],
      renderFakeCursor: tui.renderFakeCursor as TuiApi['renderFakeCursor'],
      truncateToWidth: tui.truncateToWidth as TuiApi['truncateToWidth'],
      visibleWidth: tui.visibleWidth as TuiApi['visibleWidth'],
    } as TuiApi,
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
    try {
      const apis = await loadHostApis();
      await installOnSession(pi, ctx, apis);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Murmo: ${message}`, 'warning');
    }
  });
}
