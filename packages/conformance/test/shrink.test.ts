// A failing seed must become a fixed case: shrunk to its smallest failing
// stream, saved in the owning folder, indexed, and loadable.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixturesDir, loadFixtureDir } from '../src/node/fixtures.ts';
import { saveFailures } from '../src/node/regressions.ts';
import { createPureSubject } from '../src/pure.ts';
import { runSuites } from '../src/runner.ts';
import type { RunOptions } from '../src/types.ts';

const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';

test('a failing unicode stream shrinks to the one chunk that fails and is saved as an indexed fixed case', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'murmo-shrink-'));
  try {
    cpSync(fixturesDir, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
    const options: RunOptions = { runtime: 'node', mode: 'pr', timing: 'report', now: () => performance.now() };
    // A planted bug: the boundary function throws on the ZWJ family emoji.
    const subject = createPureSubject({
      'text.boundaries': (input) => {
        const { text } = input as { text: string };
        if (text.includes(family)) throw new Error('split a ZWJ sequence');
        return text.length;
      },
    });
    const loaded = loadFixtureDir(dir);
    const suite = loaded.suites.filter((s) => s.file === 'generators/unicode.json');
    const { verdicts } = await runSuites(suite, subject, options);
    const first = verdicts.find((v) => v.status === 'fail');
    assert.ok(first, 'the planted bug fails some stream');

    const saved = await saveFailures(suite, [first], subject, options, dir);
    assert.deepEqual(
      saved.map((s) => [s.from, s.file]),
      [[first.case, 'text/unicode-regressions.json']],
    );
    const file = JSON.parse(readFileSync(join(dir, 'text/unicode-regressions.json'), 'utf8'));
    assert.equal(file.fn, 'text.boundaries');
    assert.equal(file.cases.length, 1);
    assert.equal(file.cases[0].input.text, family, 'shrunk to the single failing chunk');
    assert.equal(file.cases[0].input.cursors.length, 1);
    assert.equal(file.cases[0].output, null, 'no oracle output: fails until reviewed');

    const reloaded = loadFixtureDir(dir);
    assert.deepEqual(reloaded.problems, []);
    assert.ok(
      reloaded.suites.some(
        (s) => s.file === 'text/unicode-regressions.json' && s.kind === 'pure-fn' && s.cases.length === 1,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
