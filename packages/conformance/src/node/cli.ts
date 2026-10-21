// murmo-conformance: load and check the fixtures, run the pure subject on
// each runtime, compare verdicts across runtimes, self-test the suites.
//
//   node packages/conformance/src/node/cli.ts check
//   node packages/conformance/src/node/cli.ts run [--runtime <name>|all] [--mode pr|nightly] [--out <file.jsonl>]
//   node packages/conformance/src/node/cli.ts compare <verdicts.jsonl>...
//   node packages/conformance/src/node/cli.ts self-test
//
// `run` with several runtimes also compares them. The core, helper and host
// subjects plug in from phases 05, 10 and 20; until then only `pure` runs.

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { compare } from '../compare.ts';
import { createPureSubject } from '../pure.ts';
import { selfTest } from '../self-test.ts';
import type { RunOptions, Verdict } from '../types.ts';
import { loadFixtureDir } from './fixtures.ts';
import { bunAvailable, launch, type RuntimeName, runtimes } from './launchers.ts';

export const toJsonl = (verdicts: readonly Verdict[]) => verdicts.map((v) => `${JSON.stringify(v)}\n`).join('');
export const fromJsonl = (text: string): Verdict[] =>
  text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Verdict);

function load() {
  const loaded = loadFixtureDir();
  if (loaded.problems.length) {
    for (const p of loaded.problems) console.error(`FAIL ${p}`);
    throw new Error(`${loaded.problems.length} fixture problems`);
  }
  return loaded;
}

function summary(verdicts: readonly Verdict[]): string {
  const by = new Map<string, Record<string, number>>();
  for (const v of verdicts) {
    const row = by.get(v.runtime) ?? { pass: 0, fail: 0, skip: 0 };
    row[v.status] = (row[v.status] ?? 0) + 1;
    by.set(v.runtime, row);
  }
  return [...by].map(([rt, r]) => `${rt}: ${r.pass} pass, ${r.fail} fail, ${r.skip} skip`).join('; ');
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'check') {
    const loaded = load();
    const cases = loaded.suites.reduce((n, s) => n + (s.kind === 'generator' ? 0 : s.cases.length), 0);
    console.log(`fixtures ok: ${loaded.suites.length} suites, ${cases} fixed cases`);
    return 0;
  }
  if (command === 'run') {
    const { values } = parseArgs({
      args: rest,
      options: {
        runtime: { type: 'string', default: 'all' },
        mode: { type: 'string', default: 'pr' },
        out: { type: 'string' },
      },
    });
    const mode = values.mode === 'nightly' ? 'nightly' : 'pr';
    const chosen: RuntimeName[] =
      values.runtime === 'all' ? [...runtimes] : [values.runtime as RuntimeName].filter((r) => runtimes.includes(r));
    if (chosen.length === 0) throw new Error(`unknown runtime "${values.runtime}"; one of ${runtimes.join(', ')}, all`);
    if (chosen.includes('bun') && !bunAvailable()) throw new Error('bun is not on PATH (set MURMO_BUN to its path)');
    const { suites } = load();
    const verdicts: Verdict[] = [];
    for (const runtime of chosen) verdicts.push(...(await launch(runtime, suites, { mode })).verdicts);
    if (values.out) writeFileSync(values.out, toJsonl(verdicts));
    console.log(summary(verdicts));
    const failed = verdicts.filter((v) => v.status === 'fail');
    for (const v of failed.slice(0, 20)) console.error(`FAIL ${v.runtime} ${v.suite} ${v.case}: ${v.reason}`);
    const problems = chosen.length > 1 ? compare(verdicts) : [];
    for (const p of problems) console.error(`PARITY ${p}`);
    return failed.length || problems.length ? 1 : 0;
  }
  if (command === 'compare') {
    if (rest.length === 0) throw new Error('compare needs verdict files');
    const verdicts = rest.flatMap((file) => fromJsonl(readFileSync(file, 'utf8')));
    const problems = compare(verdicts);
    for (const p of problems) console.error(`PARITY ${p}`);
    console.log(`${verdicts.length} verdicts compared, ${problems.length} differences`);
    return problems.length ? 1 : 0;
  }
  if (command === 'self-test') {
    const { suites } = load();
    const options: RunOptions = { runtime: 'node', mode: 'pr', timing: 'report', now: () => performance.now() };
    const results = await selfTest(suites, createPureSubject(), options);
    for (const r of results) console.log(`${r.outcome.padEnd(12)} ${r.suite}${r.case ? ` (${r.case})` : ''}`);
    return results.some((r) => r.outcome === 'missed') ? 1 : 0;
  }
  console.error(
    'usage: cli.ts check | run [--runtime <name>|all] [--mode pr|nightly] [--out file] | compare <files> | self-test',
  );
  return 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
