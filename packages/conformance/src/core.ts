// The `core` subject (phase 05): runs editor-ops cases against @murmo/core on
// the reference adapter, with plugins called in-process by the direct runner
// and time on a manual clock, so the verdicts are the same on Node, Bun and
// QuickJS-wasm. Each run gets a fresh session; a timing case also gets a
// zero-plugin control fed the same input at the same time (lesson 65).
//
// Besides the case's own expectations, every run checks the invariants the
// core owes on any input: ledgers that add up (no resync), exact restores,
// commits compared at the native commit, the core's draft in step with the
// host's, no typed coverage without host-labeled evidence, no core failure,
// and a dispose that unsubscribes everything.
//
// Features: `core.edits`, `core.keys` and `core.submit`; `core.inline` (07),
// `core.permissions` and `executor.isolated` (09) are
// added by those phases, so cases that need them skip with "needs <feature>".

import type { Draft } from '@murmo/api';
import type { HostCapabilities } from '@murmo/api/adapter';
import { type CapsPatch, canonicalKey, createHarness, type DirectPluginSpec, type Harness } from '@murmo/core/testing';
import type { EditorCase, HostSetup, PluginRef } from '@murmo/fixtures';
import type { Observation } from './expect.ts';
import { type DriverDelta, interpretEditorCase, type KeyTiming, type StepDriver } from './interpreter.ts';
import { pluginFeatures, plugins } from './plugins.ts';
import type { Assertion, Capabilities, Observed, Run, Subject } from './types.ts';

export interface CoreSubjectOptions {
  /** A monotonic clock in milliseconds, for timing only (performance.now, or Date.now in QuickJS). */
  readonly now: () => number;
}

/** What a native peer adds to the sent text (V1-managed-peer, V1-final-peer): the guard's marker. */
export const PEER_TODO = ' TODO';

export function coreFeatures(): Record<string, string | boolean> {
  return { 'core.edits': true, 'core.keys': true, 'core.submit': true, ...pluginFeatures() };
}

/** The host quirks a case asks for, as reference-adapter capability overrides. */
export function capsFor(host: HostSetup | undefined): CapsPatch {
  if (!host) return {};
  const caps: { -readonly [K in keyof CapsPatch]: CapsPatch[K] } = {};
  if (host.inputOriginEvidence) caps.inputOriginEvidence = host.inputOriginEvidence;
  if (host.dialogSafe !== undefined) caps.ui = { dialogSafe: host.dialogSafe };
  const submit: Partial<HostCapabilities['submit']> = {
    ...(host.guardPosition ? { guardPosition: host.guardPosition } : {}),
    ...(host.submitTransform === undefined ? {} : { transform: host.submitTransform }),
  };
  if (Object.keys(submit).length) caps.submit = submit;
  if (host.edit) caps.edit = { ...host.edit };
  return caps;
}

function pluginSpecs(c: EditorCase, builtin: boolean): DirectPluginSpec[] {
  return (c.plugins ?? []).map((ref: PluginRef) => {
    const { id, plugin, settings } = typeof ref === 'string' ? { id: ref, plugin: ref, settings: undefined } : ref;
    const registered = plugins[plugin];
    if (!registered) throw new Error(`no plugin "${plugin}" in the core subject's registry`);
    const fromCase = c.settings?.[id] as Record<string, unknown> | undefined;
    return { id, builtin, factory: registered.factory, settings: { ...fromCase, ...settings } };
  });
}

async function harnessFor(c: EditorCase, builtin: boolean, control: boolean): Promise<Harness> {
  const host = c.host;
  const harness = await createHarness({
    plugins: control ? [] : pluginSpecs(c, builtin),
    caps: capsFor(host),
    control,
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

function observe(h: Harness, trust: Run['trust']): Observation {
  const { adapter, session, runner } = h;
  const host = adapter.getDraft();
  const stats = session?.stats();
  const numbers: Record<string, number> = {};
  if (stats) {
    for (const [name, value] of Object.entries(stats)) if (typeof value === 'number') numbers[name] = value;
    for (const [code, count] of Object.entries(stats.commits)) numbers[`commits.${code}`] = count;
    for (const [by, count] of Object.entries(stats.keyBy)) numbers[`keys.${by}`] = count;
    // The fixtures' name for plugin corrections the host committed (r4, stress).
    numbers.corrections = stats.applied;
  }
  const attributed = adapter.edits.filter((e) => e.route === 'attributed');
  return {
    draft: {
      text: host.text,
      cursor: host.cursor,
      ...(host.selection ? { selection: [host.selection[0], host.selection[1]] } : {}),
      typedSpans: (session?.draft()?.typedSpans ?? host.typedSpans).map(([a, b]) => [a, b]),
    },
    requests: adapter.requests.map((r) => r.text),
    ui: {
      ghost: adapter.ghost,
      menu: adapter.menu?.map((row) => ({ id: row.id, label: row.label, owner: row.owner })) ?? null,
      status: adapter.status,
    },
    notices: [...(stats?.notices ?? [])],
    stats: numbers,
    disabled: [...(stats?.disabled ?? [])],
    edits: {
      applied: adapter.edits.length,
      // The core sends only built-in plugins' edits by the direct route; in a third-party run there are none.
      unattributed: trust === 'third-party' ? adapter.edits.filter((e) => e.route === 'direct').length : 0,
      owners: attributed.map((e) => e.attribution?.pluginId ?? ''),
    },
    storage: { ...runner.storage() },
  };
}

const spans = (d: Draft | undefined) => JSON.stringify(d?.typedSpans ?? null);

/** What the core owes on any input; failing one fails the run whatever the case expects. */
function invariants(h: Harness, disposedClean: boolean): Assertion[] {
  const out: Assertion[] = [];
  const add = (what: string, ok: boolean, expected?: unknown, actual?: unknown) =>
    out.push({ what: `invariant: ${what}`, ok, ...(ok ? {} : { expected, actual }) });
  const stats = h.session?.stats();
  if (!stats) return out;
  const host = h.adapter.getDraft();
  const core = h.session?.draft();
  add('every ledger added up (no resync)', stats.resyncs === 0, 0, stats.resyncs);
  add('every restore was exact', stats.restoreMismatches === 0, 0, stats.restoreMismatches);
  const unchecked = h.adapter.audit.filter((a) => a.status === 'applied' && a.expected !== a.actual);
  add('every applied commit matched the version at the commit', unchecked.length === 0, [], unchecked);
  add(
    "the core's draft is the host's",
    core?.text === host.text && core.cursor === host.cursor,
    { text: host.text, cursor: host.cursor },
    core && { text: core.text, cursor: core.cursor },
  );
  if (h.adapter.caps.inputOriginEvidence === 'host-labeled') {
    add("typed spans agree with the host's labels", spans(core) === spans(host), spans(host), spans(core));
  } else {
    add('no typed coverage without host-labeled evidence', spans(core) === '[]', '[]', spans(core));
  }
  add(
    'every undo restored the draft before its edit (host oracle)',
    h.adapter.undoViolations.length === 0,
    [],
    h.adapter.undoViolations.slice(0, 3),
  );
  add('no core failure', stats.failures === 0, 0, stats.failures);
  add('dispose unsubscribed everything and hid Murmo UI', disposedClean, true, false);
  return out;
}

/** Feeds every step to the session and, for timing cases, to the control at the same time. */
class CoreStepDriver implements StepDriver {
  readonly #main: Harness;
  readonly #control: Harness | null;
  readonly #now: () => number;
  readonly #trust: Run['trust'];
  /** Settled pacing: a `type` step settles after every key, as the prototype's driver did. */
  readonly #settled: boolean;
  #lastKey: KeyTiming | undefined;

  constructor(main: Harness, control: Harness | null, now: () => number, run: Run) {
    this.#main = main;
    this.#control = control;
    this.#now = now;
    this.#trust = run.trust;
    this.#settled = (run.case as EditorCase).pacing !== 'unsettled';
  }

  async #both(step: (h: Harness) => Promise<unknown>): Promise<void> {
    await step(this.#main);
    if (this.#control) await step(this.#control);
  }

  type(text: string): Promise<void> {
    return this.#both((h) => h.driver.type(text, this.#settled));
  }

  burst(deltas: DriverDelta[], key?: string): Promise<void> {
    // The fixture origin `fill` has no API origin: programmatic input is `unknown`.
    const api = deltas.map((d) => ({ ...d, origin: d.origin === 'fill' ? ('unknown' as const) : d.origin }));
    return this.#both((h) => h.driver.burst(api, key));
  }

  paste(text: string): Promise<void> {
    return this.#both((h) => h.driver.paste(text));
  }

  ime(text: string): Promise<void> {
    return this.#both((h) => h.driver.ime(text));
  }

  fill(text: string, origin: Parameters<StepDriver['fill']>[1], cursor?: number): Promise<void> {
    return this.#both((h) => h.driver.fill(text, origin, cursor));
  }

  history(text: string): Promise<void> {
    return this.#both((h) => h.driver.history(text));
  }

  async key(id: string): Promise<'pass' | 'consume'> {
    let start = this.#now();
    const routing = await this.#main.driver.key(id);
    const ms = this.#now() - start;
    let controlMs: number | undefined;
    if (this.#control) {
      start = this.#now();
      await this.#control.driver.key(id);
      controlMs = this.#now() - start;
    }
    this.#lastKey = controlMs === undefined ? { ms } : { ms, controlMs };
    return routing;
  }

  move(offset: number): Promise<void> {
    return this.#both((h) => h.driver.move(offset));
  }

  select(range: [number, number]): Promise<void> {
    return this.#both((h) => h.driver.select(range));
  }

  state(state: Parameters<StepDriver['state']>[0]): Promise<void> {
    return this.#both((h) => h.driver.state(state));
  }

  submit(gesture: Parameters<StepDriver['submit']>[0]): Promise<void> {
    return this.#both((h) => h.driver.submit(gesture));
  }

  settle(): Promise<void> {
    return this.#both((h) => h.driver.settle());
  }

  wait(ms: number): Promise<void> {
    return this.#both((h) => h.driver.wait(ms));
  }

  async observe(): Promise<Observation> {
    return observe(this.#main, this.#trust);
  }

  lastKey(): KeyTiming | undefined {
    return this.#lastKey;
  }

  /** The key callback alone, repeated: the session's against the control's (C11; reported, never asserted). */
  async measure(m: { key: string; repeat: number }): Promise<{ samples: number[]; controlSamples?: number[] }> {
    const sample = (h: Harness): number[] => {
      const key = canonicalKey(m.key);
      const out: number[] = [];
      for (let i = 0; i < m.repeat; i++) {
        const start = this.#now();
        h.adapter.deliverKey(key);
        out.push((this.#now() - start) * 1000);
      }
      return out;
    };
    const samples = sample(this.#main);
    await this.#main.driver.settle();
    return this.#control ? { samples, controlSamples: sample(this.#control) } : { samples };
  }
}

export function createCoreSubject(options: CoreSubjectOptions): Subject {
  const caps: Capabilities = {
    kinds: ['editor-ops'],
    executors: ['in-process'],
    trust: ['builtin', 'third-party'],
    features: coreFeatures(),
  };
  return {
    name: 'core',
    caps: () => caps,
    async run(run: Run): Promise<Observed> {
      const c = run.case as EditorCase;
      const builtin = run.trust !== 'third-party';
      const timed = c.control === true || c.timing !== undefined || c.measure !== undefined;
      const main = await harnessFor(c, builtin, false);
      const control = timed ? await harnessFor(c, builtin, true) : null;
      const observed = await interpretEditorCase(run, new CoreStepDriver(main, control, options.now, run));
      // A commit still held at the host lands now, so dispose never waits on it.
      main.adapter.holdCommits(false);
      await main.driver.settle();
      const before = main.adapter.subscribers();
      await main.session?.dispose();
      const clean =
        before > 0 &&
        main.adapter.subscribers() === 0 &&
        main.adapter.ghost === null &&
        main.adapter.highlight === null &&
        main.adapter.status === null;
      observed.assertions.push(...invariants(main, clean));
      return observed;
    },
    dispose: async () => {},
  };
}
