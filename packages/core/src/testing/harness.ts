// A session on the reference adapter with the direct runner and a manual
// clock, plus a driver that feeds it input the way the conformance step
// interpreter does. Unit tests, the conformance core subject (phase 02's
// interpreter) and the edit fuzz all drive the core through this one harness.
//
// Settling: plugin work runs on promises only, and time moves only through the
// manual clock, so the harness settles by yielding microtask turns until the
// session has no task in flight. While tasks wait on the clock (a plugin's
// `sleep`) and nothing else moves, it advances the clock to the next timer,
// which is what waiting would do; tasks parked on something the clock can't
// release (a held commit) end the settle after a run of idle turns.

import type { Gesture, HostState, KeyId, Origin, Range } from '@murmo/api';
import type { RunnerHealth } from '../hooks.ts';
import { createSession, type Session, type SessionOptions } from '../session.ts';
import { createManualClock, type ManualClock } from './clock.ts';
import { createDirectRunner, type DirectPluginSpec, type DirectRunner } from './direct-runner.ts';
import { type CapsPatch, ReferenceAdapter, type ReferenceAdapterOptions } from './reference-adapter.ts';

export interface HarnessOptions {
  readonly plugins?: readonly DirectPluginSpec[];
  readonly caps?: CapsPatch;
  readonly draft?: ReferenceAdapterOptions['draft'];
  readonly tabQueues?: boolean;
  readonly nativePeer?: (text: string) => string;
  /** Default true: the reference adapter reports bursts of keys as one typed delta. */
  readonly keyBursts?: boolean;
  readonly failureLimit?: number;
  readonly gates?: SessionOptions['gates'];
  readonly notify?: (message: string) => void;
  /**
   * Commits wait at the host until the next input step has landed, so every
   * commit races one input (the pending-merge and stale-commit cases).
   */
  readonly holdCommits?: boolean;
  /** A session-free control: the adapter and clock only, for timing baselines. */
  readonly control?: boolean;
  /** Override the runner's reported health (lesson 76: a dead executor must not look healthy). */
  readonly health?: RunnerHealth;
}

export interface Harness {
  readonly clock: ManualClock;
  readonly adapter: ReferenceAdapter;
  readonly runner: DirectRunner;
  readonly session: Session | null;
  readonly driver: Driver;
}

/** A key as fixtures write it (`' '`) or canonically (`space`). */
export function canonicalKey(id: string): KeyId {
  return id === ' ' ? 'space' : id;
}

/** Microtask turns without progress before a settle stops waiting on work the clock can't release. */
const IDLE_TURNS = 64;
/** Manual time one settle may advance before it stops: a plugin that sleeps forever ends here. */
const MAX_ADVANCE_MS = 60_000;
/** Turns one settle may take at most; more means a task never stops scheduling work. */
const MAX_TURNS = 1_000_000;

export class Driver {
  readonly #harness: () => Harness;
  readonly #hold: boolean;

  constructor(harness: () => Harness, hold: boolean) {
    this.#harness = harness;
    this.#hold = hold;
  }

  get #adapter(): ReferenceAdapter {
    return this.#harness().adapter;
  }

  /** Lets the held commits through after an input step (see `holdCommits`). */
  async #input(deliver: () => unknown): Promise<void> {
    await deliver();
    if (this.#hold) this.#adapter.releaseCommits();
  }

  /**
   * Typed key by key, settling after each key unless `settle` is false, as a
   * person types and as the prototype's driver did (`adapter.type(text, settle)`):
   * every key's plugin work finishes before the next key.
   */
  async type(text: string, settle = true): Promise<void> {
    for (const point of text) {
      await this.#input(() =>
        point === '\n' ? this.#adapter.submit('newline') : this.#adapter.key(canonicalKey(point)),
      );
      if (settle) await this.settle();
    }
  }

  async key(id: string): Promise<'consume' | 'pass'> {
    let routing: 'consume' | 'pass' = 'pass';
    await this.#input(async () => {
      routing = await this.#adapter.key(canonicalKey(id));
    });
    return routing;
  }

  /** A native transaction; with `key`, the key goes to Murmo first and the burst lands only if it passes. */
  async burst(
    deltas: readonly { origin: Origin; text: string; from?: number; to?: number }[],
    key?: string,
  ): Promise<void> {
    await this.#input(() => {
      if (key !== undefined && this.#adapter.deliverKey(canonicalKey(key)) === 'consume') return;
      this.#adapter.burst(deltas);
    });
  }

  paste(text: string): Promise<void> {
    return this.#input(() => this.#adapter.paste(text));
  }

  ime(text: string): Promise<void> {
    return this.#input(() => this.#adapter.ime(text));
  }

  /** The fixture origin `fill` has no API origin: a programmatic fill is `unknown` input. */
  fill(text: string, origin: Origin | 'fill', cursor?: number): Promise<void> {
    return this.#input(() => this.#adapter.fill(text, origin === 'fill' ? 'unknown' : origin, cursor));
  }

  history(text: string): Promise<void> {
    return this.#input(() => this.#adapter.history(text));
  }

  move(offset: number): Promise<void> {
    return this.#input(() => this.#adapter.move(offset));
  }

  select(range: Range): Promise<void> {
    return this.#input(() => this.#adapter.select(range));
  }

  state(state: Partial<HostState>): Promise<void> {
    return this.#input(() => this.#adapter.setState(state));
  }

  async submit(gesture: Gesture): Promise<void> {
    await this.#input(() => this.#adapter.submit(gesture));
  }

  /** Waits `ms` of manual time, settling after each timer that fires. */
  async wait(ms: number): Promise<void> {
    await this.#harness().clock.advance(ms, () => this.#turns(IDLE_TURNS));
  }

  async #turns(n: number): Promise<void> {
    for (let i = 0; i < n; i++) await Promise.resolve();
  }

  /** Runs until no session task is in flight (see the file comment). */
  async settle(): Promise<void> {
    const { session, clock } = this.#harness();
    if (!session) return;
    await session.ready;
    let advanced = 0;
    let idle = 0;
    let last = '';
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const { pending, settled } = session.activity();
      if (pending === 0) return;
      const mark = `${pending}/${settled}/${clock.now()}`;
      idle = mark === last ? idle + 1 : 0;
      last = mark;
      if (idle >= IDLE_TURNS) {
        const step = clock.untilNext();
        if (step === undefined || advanced >= MAX_ADVANCE_MS) return;
        advanced += step;
        await clock.advance(step, () => this.#turns(IDLE_TURNS));
        idle = 0;
        continue;
      }
      await Promise.resolve();
    }
    throw new Error('settle: session tasks never stopped scheduling work');
  }
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = createManualClock();
  const adapter = new ReferenceAdapter({
    clock,
    ...(options.caps ? { caps: options.caps } : {}),
    ...(options.draft ? { draft: options.draft } : {}),
    ...(options.tabQueues === undefined ? {} : { tabQueues: options.tabQueues }),
    ...(options.nativePeer ? { nativePeer: options.nativePeer } : {}),
  });
  if (options.holdCommits) adapter.holdCommits(true);
  const runner = createDirectRunner({
    plugins: options.plugins ?? [],
    clock,
    ...(options.health === undefined ? {} : { health: options.health }),
  });
  const session = options.control
    ? null
    : createSession({
        adapter,
        runner,
        keyBursts: options.keyBursts ?? true,
        ...(options.failureLimit === undefined ? {} : { failureLimit: options.failureLimit }),
        ...(options.gates ? { gates: options.gates } : {}),
        ...(options.notify ? { notify: options.notify } : {}),
      });
  let harness: Harness | undefined;
  const driver = new Driver(() => harness as Harness, options.holdCommits === true);
  harness = { clock, adapter, runner, session, driver };
  if (session) {
    await session.ready;
    await driver.settle();
  }
  return harness;
}
