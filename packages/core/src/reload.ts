// Config edited while a session runs (02-architecture § Loading and failures):
// the built-ins it configures load again, one at a time, and each replaces its
// running copy. Every other plugin keeps its in-memory state (E5), and key
// handling never waits for this.

import type { HostPluginSpec, PluginHost } from './plugins/index.ts';
import type { Session } from './session.ts';

/** Replaces each running plugin that has a spec here; a spec for a plugin the session doesn't run is skipped. */
export async function reloadPlugins(
  session: Session,
  host: Pick<PluginHost, 'loadOne'>,
  specs: readonly HostPluginSpec[],
): Promise<void> {
  const running = new Set(session.stats().plugins.map((plugin) => plugin.id));
  for (const spec of specs) {
    if (!running.has(spec.id)) continue;
    // Off first, so no hook reaches the old copy while the new one loads.
    await session.applyPlugin({ action: 'disable', id: spec.id });
    const plugin = await host.loadOne(spec, session.caps());
    await session.applyPlugin({ action: 'replace', plugin });
  }
}
