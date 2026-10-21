// Core subject through the real murmo-plugin-host binary. Advertises
// `executor.isolated` so C12 and the containment extension run (E6).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Permission } from '@murmo/api';
import type { DirectPluginSpec, Harness } from '@murmo/core/testing';
import { canonicalKey, createHarness, testInlineRules } from '@murmo/core/testing';
import { createNodeIsolatedExecutor } from '@murmo/executor/node';
import type { EditorCase, PluginRef } from '@murmo/fixtures';
import { transformSync } from 'esbuild';
import { capsFor, createCoreSubject, PEER_TODO } from '../core.ts';
import { plugins } from '../plugins.ts';
import type { Subject } from '../types.ts';
import { fixturesDir, repoRoot } from './fixtures.ts';

const fixtureFile: Record<string, string> = {
  fast: 'plugins/fast.js',
  keyhog: 'plugins/keyhog.js',
  looper: 'plugins/looper.js',
  memhog: 'plugins/memhog.js',
  slow50: 'plugins/slow50.js',
  stale: 'plugins/stale.js',
  thrower: 'plugins/thrower.js',
  hostile: 'plugins/hostile.js',
  rules: 'plugins/rules.js',
  edits: 'plugins/edits.js',
  conflicts: 'plugins/conflicts.js',
};

const sampleFile: Record<string, string> = {
  autocorrect: 'packages/api/examples/autocorrect/plugin.ts',
  snippets: 'packages/api/examples/semicolon-menu/plugin.ts',
  'todo-guard': 'packages/api/examples/todo-guard/plugin.ts',
  counter: 'packages/api/examples/status-counter/plugin.ts',
};

export function pluginSource(name: string): string {
  const fixture = fixtureFile[name];
  if (fixture) return readFileSync(join(fixturesDir, fixture), 'utf8');
  const sample = sampleFile[name];
  if (!sample) throw new Error(`no isolated source for plugin "${name}"`);
  const ts = readFileSync(join(repoRoot, sample), 'utf8');
  return transformSync(ts, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
}

function isolatedSpecs(c: EditorCase, builtin: boolean): DirectPluginSpec[] {
  return (c.plugins ?? []).map((ref: PluginRef) => {
    const { id, plugin, settings } = typeof ref === 'string' ? { id: ref, plugin: ref, settings: undefined } : ref;
    const registered = plugins[plugin];
    if (!registered) throw new Error(`no plugin "${plugin}" in the core subject's registry`);
    const fromCase = c.settings?.[id] as Record<string, unknown> | undefined;
    const spec: DirectPluginSpec = {
      id,
      builtin,
      factory: registered.factory,
      source: pluginSource(plugin),
      settings: { ...fromCase, ...settings },
      resources: { memoryMiB: 8 },
    };
    if (builtin && plugin === 'autocorrect' && (c.requires ?? []).includes('core.inline')) {
      const bundle = testInlineRules(id);
      return { ...spec, inline: [bundle.rules], assets: bundle.assets };
    }
    return spec;
  });
}

async function isolatedHarness(c: EditorCase, builtin: boolean, control: boolean): Promise<Harness> {
  const host = c.host;
  const executor = control ? undefined : createNodeIsolatedExecutor();
  const harness = await createHarness({
    plugins: control ? [] : isolatedSpecs(c, builtin),
    caps: capsFor(host),
    control,
    ...(executor ? { executor, realtime: true } : {}),
    ...(c.grants ? { grants: c.grants as Record<string, readonly Permission[]> } : {}),
    ...(host?.certainty ? { draft: { text: '', certainty: host.certainty } } : {}),
    ...(host?.tabQueues ? { tabQueues: true } : {}),
    ...(host?.nativePeer === 'inject-todo' ? { nativePeer: (text: string) => text + PEER_TODO } : {}),
    ...(host?.commitTiming === 'hold' ? { holdCommits: true } : {}),
    ...(c.core?.guardPolicy ? { guardPolicy: c.core.guardPolicy } : {}),
  });
  const { adapter } = harness;
  if (host?.commitTiming === 'compete' || host?.commitTiming === 'race') adapter.timing = host.commitTiming;
  if (host?.raceText !== undefined) adapter.raceText = host.raceText;
  if (host?.commitStatus) adapter.commitFault = host.commitStatus;
  if (host?.restoreStatus) adapter.restoreFault = host.restoreStatus;
  if (host?.unadvertisedKeys) {
    const hidden = new Set(host.unadvertisedKeys.map(canonicalKey));
    harness.adapter.caps = { ...harness.adapter.caps, keys: harness.adapter.caps.keys.filter((k) => !hidden.has(k)) };
  }
  return harness;
}

export function createIsolatedCoreSubject(options: { now: () => number }): Subject {
  return createCoreSubject({
    now: options.now,
    harness: isolatedHarness,
    executors: ['isolated'],
    features: { 'executor.isolated': true },
  });
}
