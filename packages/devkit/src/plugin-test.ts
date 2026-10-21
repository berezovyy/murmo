import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Permission } from '@murmo/api';
import { ManifestError } from '@murmo/api';
import { makeAdapter } from '@murmo/fake-host';
import { capabilityCases, cloneCaps, missingValue, setPath } from './capabilities.ts';
import { runAuthorConformance } from './conformance.ts';
import { createNamedExecutor, type ExecutorName, helperPath, parseExecutors } from './executors.ts';
import { preparePlugin } from './loader.ts';
import { assertExecutorRoutes, MissingRouteError, ROUTE_PARITY_SOURCE, routesOf } from './routes.ts';
import { startPlugin } from './session.ts';

export const PROFILES = ['fake', 'claude', 'codex', 'opencode', 'pi'] as const;
export type TestProfile = (typeof PROFILES)[number];

export interface PluginTestOptions {
  readonly profile?: TestProfile;
  readonly executor?: string;
  readonly settings?: Readonly<Record<string, unknown>>;
  /** Unit tests skip the 71-case sweep; the CLI default still runs it. */
  readonly skipConformance?: boolean;
}

export interface PluginTestReport {
  readonly command: 'test';
  readonly plugin: string;
  readonly profile: TestProfile;
  readonly executors: readonly string[];
  readonly skipped: readonly { executor: string; reason: string }[];
  readonly capabilityMissing: ReturnType<typeof capabilityCases>;
  readonly contract: Awaited<ReturnType<typeof runAuthorConformance>>;
  readonly helperConformance?: { passed: number; skipped: number; failed: number };
  readonly authorTests: number;
  readonly routes: readonly { executor: string; ok: true }[];
  readonly ms: number;
}

function grantsOf(name: string, permissions: readonly { name: Permission }[]): Record<string, readonly Permission[]> {
  return { [name]: permissions.map((p) => p.name) };
}

async function runAuthorTest(
  directory: string,
  profile: TestProfile,
  executorName: ExecutorName,
  settings: Readonly<Record<string, unknown>> | undefined,
): Promise<number> {
  const adapter = makeAdapter(profile === 'fake' ? 'fake' : profile);
  const prepared = await preparePlugin(directory, {
    caps: adapter.caps,
    ...(settings === undefined ? {} : { settings }),
  });
  const executor = await createNamedExecutor(executorName);
  assertExecutorRoutes(executorName, routesOf(executor));
  const session = await startPlugin(prepared, {
    adapter,
    executor,
    grants: grantsOf(prepared.manifest.name, prepared.manifest.permissions),
  });
  try {
    const path = resolve(prepared.root, 'plugin.test.mjs');
    let authorTests = 0;
    if (await stat(path).catch(() => null)) {
      const loaded = (await import(`${pathToFileURL(path).href}?run=${Date.now()}`)) as {
        default?: (args: object) => Promise<void>;
      };
      if (typeof loaded.default !== 'function') {
        throw new Error('plugin.test.mjs must export default async test({driver,assert})');
      }
      await loaded.default({
        ...session,
        assert,
        manifest: prepared.manifest,
      });
      authorTests = 1;
    }
    await session.driver.settle();
    assert.deepEqual(session.session.stats().disabled, [], 'plugin must remain enabled');
    assert.equal(session.session.stats().faults, 0, 'plugin hook faults fail the author test');
    return authorTests;
  } finally {
    await session.dispose();
  }
}

async function runRouteParity(executorName: ExecutorName): Promise<void> {
  const adapter = makeAdapter('fake');
  const source = ROUTE_PARITY_SOURCE;
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'murmo-route-'));
  try {
    await writeFile(
      join(dir, 'murmo.plugin.json'),
      JSON.stringify({
        name: 'route-parity',
        version: '1.0.0',
        api: '^2.0.0',
        entry: 'plugin.mjs',
        permissions: [
          { name: 'draft:read', reason: 'read' },
          { name: 'submit:observe', reason: 'observe' },
          { name: 'fs:project-read', reason: 'read ok.txt' },
        ],
        capabilities: { required: { readDraft: true }, optional: {} },
        settingsSchema: { type: 'object', properties: {} },
      }),
    );
    await writeFile(join(dir, 'plugin.mjs'), source);
    const prepared = await preparePlugin(dir, { caps: adapter.caps });
    const executor = await createNamedExecutor(executorName);
    assertExecutorRoutes(executorName, routesOf(executor));
    const session = await startPlugin(prepared, {
      adapter,
      executor,
      grants: {
        'route-parity': ['draft:read', 'submit:observe', 'fs:project-read'],
      },
    });
    try {
      await session.driver.type('hi');
      await session.driver.submit('send');
      await session.driver.settle();
      const stored = session.runner.storage()['route-parity'];
      const data = stored ? (JSON.parse(stored) as Record<string, unknown>) : {};
      if (data.committed === undefined) {
        throw new MissingRouteError(`onSubmitCommitted (storage=${stored ?? 'none'})`, executorName);
      }
      if (data.project !== 'ok') {
        throw new MissingRouteError(`project.read (got ${JSON.stringify(data.project)})`, executorName);
      }
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function pluginTest(directory: string, options: PluginTestOptions = {}): Promise<PluginTestReport> {
  const start = performance.now();
  const profile = options.profile ?? 'fake';
  if (!(PROFILES as readonly string[]).includes(profile)) throw new Error(`invalid --profile ${profile}`);
  const selected = parseExecutors(options.executor);
  const adapter = makeAdapter(profile === 'fake' ? 'fake' : profile);
  const prepared = await preparePlugin(directory, {
    caps: adapter.caps,
    ...(options.settings === undefined ? {} : { settings: options.settings }),
  });

  const capabilityMissing = capabilityCases(prepared.manifest, adapter.caps);
  for (const item of capabilityMissing) {
    if (item.path.startsWith('api.')) {
      item.proof = 'api-version-negotiation';
      continue;
    }
    const degraded = cloneCaps(adapter.caps);
    const group = prepared.manifest.capabilities[item.required ? 'required' : 'optional'];
    const value = group[item.path];
    setPath(degraded as unknown as Record<string, unknown>, item.path, missingValue(value));
    if (item.required) {
      await assert.rejects(
        () =>
          preparePlugin(directory, {
            caps: degraded,
            ...(options.settings === undefined ? {} : { settings: options.settings }),
          }),
        (error: unknown) => error instanceof ManifestError && error.code === 'capability-unavailable',
      );
      item.proof = 'loader-refused-before-entry';
    } else {
      try {
        const candidate = await preparePlugin(directory, {
          caps: degraded,
          ...(options.settings === undefined ? {} : { settings: options.settings }),
        });
        const probeAdapter = makeAdapter(profile === 'fake' ? 'fake' : profile);
        probeAdapter.caps = degraded;
        const executor = await createNamedExecutor('in-process');
        const probe = await startPlugin(candidate, { adapter: probeAdapter, executor });
        try {
          await probe.driver.type('probe');
          assert.deepEqual(probe.session.stats().disabled, []);
          item.proof = 'live-isolated-guest';
          item.status = probeAdapter.status;
        } finally {
          await probe.dispose();
        }
      } catch (error) {
        if (error instanceof ManifestError && error.code === 'capability-unavailable') {
          item.proof = 'required-constraint-prevents-degradation';
          continue;
        }
        throw error;
      }
    }
  }

  const contract = options.skipConformance
    ? {
        invariants: { checks: 0, passed: true as const },
        cases: { passed: 0, skipped: 0, failed: 0 },
        containment: { passed: 0, skipped: 0, failed: 0 },
        failed: [],
      }
    : await runAuthorConformance();
  if (contract.failed.length) {
    const first = contract.failed[0];
    throw new Error(`conformance failed ${first?.case}: ${first?.reason}`);
  }

  const skipped: { executor: string; reason: string }[] = [];
  const ran: string[] = [];
  const routes: { executor: string; ok: true }[] = [];
  let authorTests = 0;

  for (const name of selected) {
    if (name === 'helper' && !helperPath()) {
      skipped.push({
        executor: 'helper',
        reason: 'murmo-plugin-host is not built for this platform; helper route skipped (phase 26)',
      });
      continue;
    }
    try {
      await runRouteParity(name);
      routes.push({ executor: name, ok: true });
      authorTests = await runAuthorTest(directory, profile, name, options.settings);
      ran.push(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${name}: ${message}`);
    }
  }

  // Canonical helper C12/containment is packages/conformance's isolated.gate.ts.
  // Here we prove the author's plugin plus route parity on the real binary.

  return {
    command: 'test',
    plugin: prepared.manifest.name,
    profile,
    executors: ran,
    skipped,
    capabilityMissing,
    contract,
    authorTests,
    routes,
    ms: performance.now() - start,
  };
}
