// Turns failing generated runs into fixed cases: find the stream's spec from
// its seed and index, shrink it against the subject, and save the smallest
// failing case in the generator's `failures` file (docs/plan/02 § Generators).

import type { EditorCase, PureCase } from '@murmo/fixtures';
import { generatorOf } from '@murmo/fixtures/generators';
import { verdictOf } from '../runner.ts';
import { shrinkFailure } from '../shrink.ts';
import type { LoadedSuite, Run, RunOptions, Subject, Verdict } from '../types.ts';
import { fixturesDir, saveRegression } from './fixtures.ts';

export interface SavedRegression {
  from: string;
  id: string;
  file: string;
  attempts: number;
}

/** The stream index in a generated case ID (`burst-1306637-42` → 42). */
export function streamIndex(caseId: string): number {
  const index = Number(caseId.slice(caseId.lastIndexOf('-') + 1));
  if (!Number.isInteger(index) || index < 0) throw new Error(`"${caseId}" is not a generated case ID`);
  return index;
}

export async function saveFailures(
  suites: LoadedSuite[],
  verdicts: Verdict[],
  subject: Subject,
  options: RunOptions,
  dir = fixturesDir,
): Promise<SavedRegression[]> {
  const saved: SavedRegression[] = [];
  for (const suite of suites) {
    if (suite.kind !== 'generator') continue;
    const g = suite.generator;
    const failed = verdicts.filter((v) => v.suite === suite.file && v.status === 'fail');
    // One regression per verdict case: trust levels and executors of one stream share it.
    for (const caseId of new Set(failed.map((v) => v.case))) {
      const verdict = failed.find((v) => v.case === caseId);
      if (!verdict) continue;
      const generator = generatorOf(g.generator);
      const index = streamIndex(caseId);
      let spec: unknown;
      for (const generated of generator.generate(g.seed, index + 1)) spec = generated.spec;
      const target = g.target;
      const toRun = (c: EditorCase | PureCase): Run => ({
        suite: suite.file,
        kind: target.kind,
        caseId: c.id,
        executor: verdict.executor,
        owner: suite.owner,
        ...(verdict.trust ? { trust: verdict.trust } : {}),
        case: target.kind === 'pure-fn' ? { ...(c as PureCase), fn: target.fn } : c,
      });
      const fails = async (c: EditorCase | PureCase) => {
        const run = toRun(c);
        let outcome: Parameters<typeof verdictOf>[3];
        try {
          outcome = { observed: await subject.run(run) };
        } catch (error) {
          outcome = { error };
        }
        return verdictOf(run, subject.name, options, outcome, 0).status === 'fail';
      };
      const id = `${caseId}-shrunk`;
      const shrunk = await shrinkFailure(generator, spec, id, fails);
      const file = saveRegression(g, suite.file, shrunk.case, dir);
      saved.push({ from: caseId, id, file, attempts: shrunk.attempts });
    }
  }
  return saved;
}
