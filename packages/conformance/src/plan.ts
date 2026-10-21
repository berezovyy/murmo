// Expands loaded suites into runs: each editor-ops case × its variants × the
// trust levels it runs under × the subject's executors; each pure case once;
// each generator into its seeded streams. Skips are decided here, with their
// reason: a declared skip (reviewed, in the case) or an unmet requirement.

import type { EditorCase, EditorMode, PluginRef, PureCase, Skip, StateName, Step } from '@murmo/fixtures';
import { generatorOf } from '@murmo/fixtures/generators';
import { variantsOf } from './load.ts';
import type { Capabilities, LoadedSuite, Run, RunOptions } from './types.ts';

function applyVariant(c: EditorCase, variant: string | undefined): EditorCase {
  if (variant === undefined) return c;
  const steps = c.steps.map((s): Step => {
    if (!('state' in s)) return s;
    if (s.state === '$variant') return { state: variant as StateName };
    if (typeof s.state === 'object' && 'editorMode' in s.state && s.state.editorMode === '$variant') {
      return { state: { editorMode: variant as EditorMode } };
    }
    return s;
  });
  return { ...c, steps };
}

function matchingSkip(skips: readonly Skip[] | undefined, fields: Omit<Skip, 'reason'>): Skip | undefined {
  return skips?.find(
    (s) =>
      (s.runtime === undefined || s.runtime === fields.runtime) &&
      (s.executor === undefined || s.executor === fields.executor) &&
      (s.subject === undefined || s.subject === fields.subject) &&
      (s.trust === undefined || s.trust === fields.trust),
  );
}

/** The first requirement the subject does not meet. */
export function unmet(requires: readonly string[], caps: Capabilities): string | undefined {
  return requires.find((req) => {
    const [path, value] = req.split('=') as [string, string | undefined];
    const have = caps.features[path];
    return value === undefined ? !have : String(have) !== value;
  });
}

const trustLevels = (trust: EditorCase['trust']): ('builtin' | 'third-party')[] =>
  trust === 'builtin' ? ['builtin'] : trust === 'third-party' ? ['third-party'] : ['builtin', 'third-party'];

interface Context {
  caps: Capabilities;
  subject: string;
  options: RunOptions;
}

function editorRuns(
  suite: string,
  owner: string,
  c: EditorCase,
  ctx: Context,
  extra: { seed?: number; session?: string } = {},
): Run[] {
  const runs: Run[] = [];
  for (const variant of variantsOf(c)) {
    for (const trust of trustLevels(c.trust)) {
      for (const executor of ctx.caps.executors) {
        const run: Run = {
          suite,
          kind: 'editor-ops',
          caseId: c.id,
          ...(variant === undefined ? {} : { variant }),
          trust,
          executor,
          owner,
          case: applyVariant(c, variant),
          ...extra,
        };
        const declared = matchingSkip(c.skip, { runtime: ctx.options.runtime, executor, subject: ctx.subject, trust });
        const missing = unmet(c.requires ?? [], ctx.caps);
        if (declared) run.skip = { reason: declared.reason, declared: true };
        else if (!ctx.caps.trust.includes(trust))
          run.skip = { reason: `subject cannot load ${trust} plugins`, declared: false };
        else if (missing) run.skip = { reason: `needs ${missing}`, declared: false };
        runs.push(run);
      }
    }
  }
  return runs;
}

function pureRun(suite: string, owner: string, c: PureCase, ctx: Context, seed?: number): Run {
  const executor = ctx.caps.executors[0] ?? 'none';
  const run: Run = {
    suite,
    kind: 'pure-fn',
    caseId: c.id,
    executor,
    owner,
    case: c,
    ...(seed === undefined ? {} : { seed }),
  };
  const declared = matchingSkip(c.skip, { runtime: ctx.options.runtime, executor, subject: ctx.subject });
  const missing = unmet([`fn.${c.fn}`, ...(c.requires ?? [])], ctx.caps);
  if (declared) run.skip = { reason: declared.reason, declared: true };
  else if (missing) run.skip = { reason: `needs ${missing} (owner: phase ${owner})`, declared: false };
  return run;
}

/**
 * Every run of a suite for this subject, in order; nothing if the subject
 * cannot run the suite's kind. Generated streams are produced one at a time, so
 * a 10,000-stream generator never sits in a guest's memory all at once (the
 * rquickjs launcher runs with a 32 MiB heap).
 */
export function* planRuns(
  suite: LoadedSuite,
  caps: Capabilities,
  subject: string,
  options: RunOptions,
): Generator<Run> {
  const ctx: Context = { caps, subject, options };
  if (suite.kind === 'editor-ops') {
    if (!caps.kinds.includes('editor-ops')) return;
    for (const c of suite.cases) yield* editorRuns(suite.file, suite.owner, c, ctx);
    return;
  }
  if (suite.kind === 'pure-fn') {
    if (!caps.kinds.includes('pure-fn')) return;
    for (const c of suite.cases) yield pureRun(suite.file, suite.owner, c, ctx);
    return;
  }
  const g = suite.generator;
  const target = g.target;
  if (!caps.kinds.includes(target.kind)) return;
  const size = options.mode === 'nightly' ? g.sizes.nightly : g.sizes.pr;
  const session = g.session === 'shared' ? suite.file : undefined;
  for (const generated of generatorOf(g.generator).generate(g.seed, size)) {
    if (target.kind === 'pure-fn') {
      yield pureRun(suite.file, suite.owner, { ...(generated.case as PureCase), fn: target.fn }, ctx, g.seed);
    } else {
      const c: EditorCase = {
        ...(generated.case as EditorCase),
        ...(target.plugins ? { plugins: target.plugins as PluginRef[] } : {}),
        ...(target.trust ? { trust: target.trust } : {}),
      };
      yield* editorRuns(suite.file, suite.owner, c, ctx, { seed: g.seed, ...(session ? { session } : {}) });
    }
  }
}

/** `planRuns` as an array. */
export function planSuite(suite: LoadedSuite, caps: Capabilities, subject: string, options: RunOptions): Run[] {
  return Array.from(planRuns(suite, caps, subject, options));
}
