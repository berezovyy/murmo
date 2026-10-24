// The step interpreter: one walk over an editor-ops case, shared by every
// subject that drives an editor. The core subject (phase 05) drives the
// reference adapter, the helper subject (10) the same through
// murmo-plugin-host, a host subject (20) a real agent in tmux. Each supplies a
// StepDriver; the interpreter owns step order, settling, checkpoints and
// timing, so every subject reads a case the same way.

import type { EditorCase, Gesture, HostState, Measure, Origin, StateName, Step } from '@murmo/fixtures';
import { evaluate, forTrust, type Observation } from './expect.ts';
import type { Assertion, Observed, Run } from './types.ts';
import { resolveText } from './values.ts';

export interface DriverDelta {
  origin: Origin;
  text: string;
  from?: number;
  to?: number;
}

/** Delivery time of one key, and of the same key in the same-time zero-plugin control. */
export interface KeyTiming {
  ms: number;
  controlMs?: number;
}

export interface StepDriver {
  type(text: string): Promise<void>;
  burst(deltas: DriverDelta[], key?: string): Promise<void>;
  paste(text: string): Promise<void>;
  ime(text: string): Promise<void>;
  fill(text: string, origin: Origin, cursor?: number): Promise<void>;
  history(text: string): Promise<void>;
  key(id: string): Promise<'pass' | 'consume'>;
  move(offset: number): Promise<void>;
  select(range: [number, number]): Promise<void>;
  /** Merges a partial state into the host's current one. */
  state(state: Partial<HostState>): Promise<void>;
  submit(gesture: Gesture): Promise<void>;
  settle(): Promise<void>;
  wait(ms: number): Promise<void>;
  observe(): Promise<Observation>;
  /** Timing of the last key; drivers that cannot measure leave it out. */
  lastKey?(): KeyTiming | undefined;
  /** Per-change processing times, each paired with the control's. */
  changeTimes?(): { ms: number; controlMs?: number }[];
  /** Repeats a key callback for a latency sample series (C11). */
  measure?(m: Measure): Promise<{ samples: number[]; controlSamples?: number[] }>;
}

/** Named states as the r14 `repeatStates` defined them (shared-v2/conformance/run.mjs). */
export const namedStates: Record<StateName, Partial<HostState>> = {
  busy: { busy: true },
  popup: { popup: { owner: 'host' } },
  dialog: { dialog: true },
  history: { history: true },
  'vim-normal': { editorMode: 'normal' },
  unknown: { mode: 'unknown' },
};

function stateOf(step: Extract<Step, { state: unknown }>): Partial<HostState> {
  const value = step.state;
  if (typeof value === 'string') {
    const named = namedStates[value as StateName];
    if (!named) throw new Error(`state "${value}" was not replaced by a variant`);
    return named;
  }
  if ('editorMode' in value && value.editorMode === '$variant') throw new Error('editorMode variant was not replaced');
  return value as Partial<HostState>;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

/** Runs one editor-ops case through a driver and returns its assertions. */
export async function interpretEditorCase(run: Run, driver: StepDriver): Promise<Observed> {
  const c = run.case as EditorCase;
  const assertions: Assertion[] = [];
  const timing: Record<string, number> = {};
  const settled = c.pacing !== 'unsettled';
  const lastKeyExcess = (): number | undefined => {
    const t = driver.lastKey?.();
    return t === undefined ? undefined : t.ms - (t.controlMs ?? 0);
  };
  let worstKeyExcess = 0;

  for (const [index, step] of c.steps.entries()) {
    const at = `step ${index + 1}`;
    if ('check' in step) {
      const expect = forTrust(step.check, run.trust);
      assertions.push(...evaluate(expect, await driver.observe(), at));
      if (expect.withinMs !== undefined) {
        const excess = lastKeyExcess();
        assertions.push({
          what: `${at}: last key within ${expect.withinMs} ms of the control`,
          ok: excess !== undefined && excess <= expect.withinMs,
          timing: true,
          expected: expect.withinMs,
          actual: excess ?? 'not measured',
        });
      }
      continue;
    }
    if ('type' in step) await driver.type(resolveText(step.type));
    else if ('burst' in step) {
      const deltas = step.burst.map((d) => ({ ...d, text: resolveText(d.text) }));
      await driver.burst(deltas, step.key);
    } else if ('paste' in step) await driver.paste(resolveText(step.paste));
    else if ('ime' in step) await driver.ime(resolveText(step.ime));
    else if ('fill' in step) await driver.fill(resolveText(step.fill), step.origin ?? 'fill', step.cursor);
    else if ('history' in step) await driver.history(resolveText(step.history));
    else if ('key' in step) {
      const routing = await driver.key(step.key);
      if (step.routing) {
        assertions.push({
          what: `${at}: ${step.key} routing`,
          ok: routing === step.routing,
          ...(routing === step.routing ? {} : { expected: step.routing, actual: routing }),
        });
      }
      const excess = lastKeyExcess();
      if (excess !== undefined) worstKeyExcess = Math.max(worstKeyExcess, excess);
    } else if ('move' in step) await driver.move(step.move);
    else if ('select' in step) await driver.select(step.select);
    else if ('state' in step) await driver.state(stateOf(step));
    else if ('submit' in step) await driver.submit(step.submit);
    else if ('settle' in step) await driver.settle();
    else if ('waitMs' in step) await driver.wait(step.waitMs);
    else if ('restart' in step) throw new Error('a restart step needs a real host (adapter.rescue)');
    else if ('configFile' in step || 'trust' in step)
      throw new Error('editing config while a host runs needs a real host');
    if (settled) await driver.settle();
  }

  await driver.settle();
  assertions.push(...evaluate(forTrust(c.expect, run.trust), await driver.observe(), 'end'));

  if (c.timing?.keyMs !== undefined) {
    timing.worstKeyMs = worstKeyExcess;
    assertions.push({
      what: `every key within ${c.timing.keyMs} ms of the control`,
      ok: driver.lastKey !== undefined && worstKeyExcess <= c.timing.keyMs,
      timing: true,
      expected: c.timing.keyMs,
      actual: driver.lastKey ? worstKeyExcess : 'not measured',
    });
  }
  if (c.timing?.changeMs !== undefined) {
    const changes = driver.changeTimes?.() ?? [];
    const worst = changes.reduce((m, t) => Math.max(m, t.ms - (t.controlMs ?? 0)), 0);
    timing.worstChangeMs = worst;
    assertions.push({
      what: `every change within ${c.timing.changeMs} ms of the control`,
      ok: changes.length > 0 && worst <= c.timing.changeMs,
      timing: true,
      expected: c.timing.changeMs,
      actual: changes.length > 0 ? worst : 'not measured',
    });
  }
  const observed: Observed = { assertions, timing };
  if (c.measure && driver.measure) {
    const { samples, controlSamples } = await driver.measure(c.measure);
    const sorted = [...samples].sort((a, b) => a - b);
    const control = [...(controlSamples ?? [])].sort((a, b) => a - b);
    const measure: Record<string, number> = { samples: sorted.length };
    for (const q of c.measure.quantiles) {
      measure[`p${q * 100}`] = quantile(sorted, q);
      if (control.length) measure[`controlP${q * 100}`] = quantile(control, q);
    }
    observed.measure = measure;
  }
  return observed;
}
