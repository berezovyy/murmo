// One segmenter everywhere (docs/plan/04): the bundled segmenter must agree
// with Node's Intl.Segmenter on the generated corpus and the fixed cases, and
// the rewritten index must keep the r7 conversion rules. A difference fails
// unless it is listed here with the Unicode versions that explain it.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { PureFnFile } from '@murmo/fixtures';
import { unicode } from '@murmo/fixtures/generators';
import { transform } from 'esbuild';
import {
  graphemeBoundaries,
  invisibleCodePointRanges,
  isGraphemeBoundary,
  offsetIndex,
  segmenter,
  type Unit,
  units,
} from '../src/index.ts';

const repo = join(import.meta.dirname, '..', '..', '..');

/** Texts from every fixed `text.offsets` case plus the seeded r7-sized corpus (4,000 drafts). */
function corpus(): string[] {
  const texts: string[] = [];
  const dir = join(repo, 'fixtures', 'text');
  for (const name of readdirSync(dir)) {
    const file = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PureFnFile;
    if (file.fn !== 'text.offsets') continue;
    for (const c of file.cases ?? []) texts.push((c.input as { text: string }).text);
  }
  const seed = (
    JSON.parse(readFileSync(join(repo, 'fixtures', 'generators', 'unicode.json'), 'utf8')) as { seed: number }
  ).seed;
  for (const g of unicode.generate(seed, 4000)) texts.push((g.case.input as { text: string }).text);
  return texts;
}

/**
 * Reviewed differences between the bundled segmenter and Intl.Segmenter, each
 * with the Unicode versions that explain it. Empty: both implement Unicode 17.0
 * (unicode-segmenter 0.17.3, Node 24.18 with ICU 78).
 */
const knownIntlDifferences = new Map<string, string>();

test('the bundled segmenter agrees with Intl.Segmenter on every corpus text (hosts must not disagree on graphemes, E10)', () => {
  const intl = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const differences: string[] = [];
  for (const text of corpus()) {
    const expected = [...Array.from(intl.segment(text), (s) => s.index), text.length].filter(
      (at, i, all) => all.indexOf(at) === i,
    );
    const ours = graphemeBoundaries(text);
    if (ours.join() !== expected.join() && !knownIntlDifferences.has(text)) differences.push(JSON.stringify(text));
    // The no-index check takes a different path (certain-boundary fast path, local stretch); it must agree too.
    for (let at = 0; at <= text.length; at++) {
      if (isGraphemeBoundary(text, at) !== expected.includes(at)) differences.push(`${JSON.stringify(text)} @${at}`);
    }
  }
  assert.deepEqual(
    differences.slice(0, 10),
    [],
    `bundled ${segmenter.name} ${segmenter.version} (Unicode ${segmenter.unicode}) vs Node ICU ${process.versions.icu} (Unicode ${process.versions.unicode})`,
  );
});

const prototypeFile = join(repo, 'experiments', 'engine-v2', 'src', 'unicode.ts');
test('the binary-search index keeps the r7 conversion rules: same verdict as the prototype for every unit pair (E24)', {
  skip: existsSync(prototypeFile) ? false : 'experiments/ is not checked out here',
}, async () => {
  type Prototype = { UnicodeOffsets: new (text: string) => { convert(o: number, f: Unit, t: Unit): number | null } };
  // The prototype uses parameter properties, which Node's type stripping refuses; esbuild compiles it.
  const { code } = await transform(readFileSync(prototypeFile, 'utf8'), { loader: 'ts', format: 'esm' });
  const { UnicodeOffsets } = (await import(
    `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
  )) as Prototype;
  let checked = 0;
  for (const text of corpus()) {
    const ours = offsetIndex(text);
    const theirs = new UnicodeOffsets(text);
    const limit = new TextEncoder().encode(text).length + 1;
    for (const from of units) {
      for (const to of units) {
        for (let at = 0; at <= limit; at++) {
          assert.equal(
            ours.convert(at, from, to),
            theirs.convert(at, from, to),
            `${JSON.stringify(text)} ${at} ${from}→${to}`,
          );
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1_000_000, `only ${checked} conversions compared`);
});

test('the invisible code point table equals Unicode 17 Default_Ignorable_Code_Point plus Cf minus prepended marks', {
  skip: process.versions.unicode === '17.0' ? false : `Node has Unicode ${process.versions.unicode}, the table is 17.0`,
}, () => {
  const expected = /^[\p{Default_Ignorable_Code_Point}\p{Cf}]$/u;
  const prepended = new Set([
    0x600, 0x601, 0x602, 0x603, 0x604, 0x605, 0x6dd, 0x70f, 0x890, 0x891, 0x8e2, 0x110bd, 0x110cd,
  ]);
  const inTable = (cp: number) => invisibleCodePointRanges.some(([a, b]) => cp >= a && cp <= b);
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const want = expected.test(String.fromCodePoint(cp)) && !prepended.has(cp);
    if (inTable(cp) !== want) assert.fail(`U+${cp.toString(16)}: table says ${inTable(cp)}, Unicode ${want}`);
  }
});
