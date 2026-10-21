// The `pure` subject calls a named function with a case's input and compares
// the result with the case's output. It runs the same way on Node, Bun,
// QuickJS-wasm and rquickjs (guests get the cases as JSON), so its verdicts
// are what the parity compare checks.
//
// Functions register by name as their phases land: the generator summaries,
// text offsets and provenance ledgers (phase 04) now; the name splitter (19)
// and others later. A case whose function is not registered is skipped with
// "needs fn.<name>", never passed.

import type { PureCase } from '@murmo/fixtures';
import { sha256, summarize } from '@murmo/fixtures/generators';
import { configFunctions } from './fns/config.ts';
import { provenanceFunctions } from './fns/provenance.ts';
import { textFunctions } from './fns/text.ts';
import type { Assertion, Capabilities, Observed, Run, Subject } from './types.ts';
import { deepEqual, preview } from './values.ts';

export type PureFunction = (input: unknown) => unknown;

/**
 * A function with rules every result must satisfy. Generated cases carry no
 * expected output, so the rules are what checks them (besides the parity
 * compare of their hashes); fixed cases are checked against both.
 */
export interface RuledFunction {
  run: PureFunction;
  /** The rules the result breaks; empty when it keeps them all. */
  rules(input: unknown, result: unknown): string[];
}

export type PureEntry = PureFunction | RuledFunction;

function summary(input: unknown): unknown {
  const { generator, seed, size } = input as { generator: string; seed: number; size: number };
  return summarize(generator, seed, size);
}

/** Every pure function registered so far. */
export const pureFunctions: Readonly<Record<string, PureEntry>> = {
  'generators.summary': summary,
  ...textFunctions,
  ...provenanceFunctions,
  ...configFunctions,
};

export interface PureSubject extends Subject {
  runSync(run: Run): Observed;
}

export function createPureSubject(
  functions: Readonly<Record<string, PureEntry>> = pureFunctions,
  name = 'pure',
): PureSubject {
  const caps: Capabilities = {
    kinds: ['pure-fn'],
    executors: ['none'],
    trust: [],
    features: Object.fromEntries(Object.keys(functions).map((fn) => [`fn.${fn}`, true])),
  };
  const runSync = (run: Run): Observed => {
    const c = run.case as PureCase;
    const entry = c.fn ? functions[c.fn] : undefined;
    if (!entry) throw new Error(`no pure function "${c.fn}"`);
    const fn = typeof entry === 'function' ? entry : entry.run;
    const result = fn(c.input);
    const outputHash = sha256(JSON.stringify(result) ?? 'undefined');
    const assertions: Assertion[] = [];
    if (typeof entry !== 'function') {
      const broken = entry.rules(c.input, result);
      assertions.push({
        what: `${c.fn} rules${broken.length ? `: ${broken[0]}` : ''}`,
        ok: broken.length === 0,
        ...(broken.length ? { expected: 'no broken rule', actual: broken.slice(0, 5) } : {}),
      });
    }
    if ('output' in c) {
      const ok = deepEqual(result, c.output);
      assertions.push({
        what: `${c.fn} output`,
        ok,
        ...(ok ? {} : { expected: preview(JSON.stringify(c.output)), actual: preview(JSON.stringify(result)) }),
      });
    } else if (assertions.length === 0) {
      // A generated case with no output and no rules: only the parity compare of its hash checks it.
      assertions.push({ what: 'result hashed for the parity compare', ok: true });
    }
    return { assertions, outputHash };
  };
  return {
    name,
    caps: () => caps,
    runSync,
    run: async (run) => runSync(run),
    dispose: async () => {},
  };
}
