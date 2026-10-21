// The plugins an editor-ops case can name (fixtures/plugins.json), as static
// imports so every runtime's bundle carries them: the fixture plugins, and
// stand-ins for the provided plugins until their phases ship them. A stand-in
// is the API sample of the same job (phase 03): good enough for the core
// cases that only need a corrector, a counter or a guard to exist, and
// advertised as `plugin.<name>: 'sample'`, so cases that need the real
// plugin's behaviour require `plugin.<name>=release` and skip with that reason.
// The guard cases use the `todo-guard` API sample: Murmo ships no guard of its own.

import type { PluginFactory } from '@murmo/api';
import autocorrectSample from '@murmo/api/examples/autocorrect';
import semicolonMenuSample from '@murmo/api/examples/semicolon-menu';
import statusCounterSample from '@murmo/api/examples/status-counter';
import todoGuardSample from '@murmo/api/examples/todo-guard';
import conflicts from '@murmo/fixtures/plugins/conflicts';
import edits from '@murmo/fixtures/plugins/edits';
import fast from '@murmo/fixtures/plugins/fast';
import hostile from '@murmo/fixtures/plugins/hostile';
import keyhog from '@murmo/fixtures/plugins/keyhog';
import looper from '@murmo/fixtures/plugins/looper';
import memhog from '@murmo/fixtures/plugins/memhog';
import rules from '@murmo/fixtures/plugins/rules';
import slow50 from '@murmo/fixtures/plugins/slow50';
import stale from '@murmo/fixtures/plugins/stale';
import thrower from '@murmo/fixtures/plugins/thrower';
import { shortcutsFactory } from '@murmo/plugin-shortcuts';

export type PluginBuild = 'fixture' | 'sample' | 'release';

export interface RegisteredPlugin {
  readonly factory: PluginFactory;
  readonly build: PluginBuild;
}

const fixture = (factory: unknown): RegisteredPlugin => ({ factory: factory as PluginFactory, build: 'fixture' });
const sample = (factory: PluginFactory): RegisteredPlugin => ({ factory, build: 'sample' });
const release = (factory: PluginFactory): RegisteredPlugin => ({ factory, build: 'release' });

export const plugins: Readonly<Record<string, RegisteredPlugin>> = {
  fast: fixture(fast),
  keyhog: fixture(keyhog),
  looper: fixture(looper),
  memhog: fixture(memhog),
  slow50: fixture(slow50),
  stale: fixture(stale),
  thrower: fixture(thrower),
  hostile: fixture(hostile),
  rules: fixture(rules),
  conflicts: fixture(conflicts),
  edits: fixture(edits),
  autocorrect: sample(autocorrectSample),
  shortcuts: release(shortcutsFactory),
  snippets: sample(semicolonMenuSample),
  counter: sample(statusCounterSample),
  'todo-guard': sample(todoGuardSample),
};

/** `plugin.<name>` features: which build of each plugin this subject loads. */
export function pluginFeatures(): Record<string, string> {
  return Object.fromEntries(Object.entries(plugins).map(([name, p]) => [`plugin.${name}`, p.build]));
}
