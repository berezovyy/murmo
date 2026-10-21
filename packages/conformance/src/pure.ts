// The `pure` subject calls a named function with a case's input and compares
// the result with the case's output. It runs the same way on Node, Bun,
// QuickJS-wasm and rquickjs (guests get the cases as JSON), so its verdicts
// are what the parity compare checks.
//
// Functions register by name as their phases land: the generator summaries
// now; text offsets (phase 04), the name splitter (19) and others later. A
// case whose function is not registered is skipped with "needs fn.<name>",
// never passed.

import type { PureCase } from '@murmo/fixtures';
import { sha256, summarize } from '@murmo/fixtures/generators';
import type { Capabilities, Observed, Run, Subject } from './types.ts';
import { deepEqual, preview } from './values.ts';

export type PureFunction = (input: unknown) => unknown;

function summary(input: unknown): unknown {
  const { generator, seed, size } = input as { generator: string; seed: number; size: number };
  return summarize(generator, seed, size);
}

/** Every pure function this phase has. */
export const pureFunctions: Readonly<Record<string, PureFunction>> = {
  'generators.summary': summary,
};

export interface PureSubject extends Subject {
  runSync(run: Run): Observed;
}

export function createPureSubject(
  functions: Readonly<Record<string, PureFunction>> = pureFunctions,
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
    const fn = c.fn ? functions[c.fn] : undefined;
    if (!fn) throw new Error(`no pure function "${c.fn}"`);
    const result = fn(c.input);
    const outputHash = sha256(JSON.stringify(result) ?? 'undefined');
    if (!('output' in c)) {
      // A generated case without an expected output: its result is checked by the parity compare.
      return { assertions: [{ what: 'result hashed for the parity compare', ok: true }], outputHash };
    }
    const ok = deepEqual(result, c.output);
    return {
      assertions: [
        {
          what: `${c.fn} output`,
          ok,
          ...(ok ? {} : { expected: preview(JSON.stringify(c.output)), actual: preview(JSON.stringify(result)) }),
        },
      ],
      outputHash,
    };
  };
  return {
    name,
    caps: () => caps,
    runSync,
    run: async (run) => runSync(run),
    dispose: async () => {},
  };
}
