// One clean build from the pinned inputs, then everything the plan asks of it
// (docs/plan/12, Tests and acceptance). The build takes about 10 s, so every
// check that needs the real pack shares this one.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { encodeTable, keyAt, lookup, mapTable, type PackedTable, parseCasePolicy, parseManifest } from '@murmo/lang';
import { type BuildReport, buildPack } from '../src/build.ts';
import { r6Dictionary, readGateConfig, runGate } from '../src/gate/index.ts';
import { fixturesDir } from '../src/gate/streams.ts';
import { loadInputs, packageDir } from '../src/inputs.ts';
import { parseProvenance } from '../src/provenance.ts';
import { verifyPack } from '../src/verify.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const expected = JSON.parse(readFileSync(join(packageDir, 'expected.json'), 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'murmo-lang-en-'));
const packDir = join(root, 'pack');
let report: BuildReport;
let table: PackedTable;

before(() => {
  report = buildPack(packDir);
  table = mapTable(new Uint8Array(readFileSync(join(packDir, 'typos.bin'))));
});
after(() => rmSync(root, { recursive: true, force: true }));

test('a clean build reproduces rounds 7, 8 and 13 byte for byte', () => {
  // Catches unpinned inputs (system dictionary, vocab caches) and a port that changes the data (E3, E6).
  const summary = ({ entries, bytes, sha256 }: { entries: number; bytes: number; sha256: string }) => ({
    entries,
    bytes,
    sha256,
  });
  assert.deepEqual(summary(report.base), expected.base, 'strict base (r7 strict.bin)');
  assert.deepEqual(report.combined, expected.combined, 'base + authored (r8 strict-common.bin)');
  assert.deepEqual(report.table, expected.table, 'shipped table (r13 inline-typos.bin)');
  assert.deepEqual([...new Uint32Array(table.keyOffsets.buffer, 0, 8)], expected.header);
  assert.equal(report.authored.kept, 493);
  assert.equal(report.authored.newKeys, 353);
  assert.equal(report.provenanceRows, expected.provenanceRows);
});

test('the independent verifier passes every entry of the built pack', () => {
  // r13's 177,052 index assertions: two per entry, the count, and the absent legacy keys.
  const result = verifyPack(packDir);
  assert.equal(result.entryAssertions, expected.entryAssertions);
  assert.equal(result.generatedRows, expected.base.entries);
  assert.equal(result.reverseChecks, expected.base.entries);
});

/** A copy of the pack with one change, for the verifier to reject. */
function damaged(name: string, edit: (dir: string) => void): string {
  const dir = join(root, name);
  cpSync(packDir, dir, { recursive: true });
  edit(dir);
  return dir;
}

function editTable(dir: string, change: (bytes: Uint8Array, view: DataView) => void): void {
  const bytes = new Uint8Array(readFileSync(join(dir, 'typos.bin')));
  change(bytes, new DataView(bytes.buffer));
  writeFileSync(join(dir, 'typos.bin'), bytes);
}

test('a flipped byte, an unsorted key or an out-of-range offset each fail verification', () => {
  // Catches a corrupt table reaching users (E6). Each damage is checked on its own copy.
  const n = table.entries;
  const dataStart = 32 + 8 * (n + 1);
  const flipped = damaged('flipped', (d) =>
    editTable(d, (b) => {
      b[dataStart + 10] = (b[dataStart + 10] as number) ^ 0x01;
    }),
  );
  assert.throws(() => verifyPack(flipped), /SHA-256/);

  // The other two keep the manifest hash honest, so the entry checks themselves must catch them.
  const rehash = (dir: string) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const bytes = readFileSync(join(dir, 'typos.bin'));
    manifest.table.sha256 = sha256(bytes);
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  };
  const unsorted = damaged('unsorted', (d) => {
    editTable(d, (b) => {
      // The first key starts with "aa…": make it sort after the second.
      b[dataStart] = 'z'.charCodeAt(0);
    });
    rehash(d);
  });
  assert.throws(() => verifyPack(unsorted), /not after entry 0/);
  const outOfRange = damaged('range', (d) => {
    editTable(d, (_b, v) => {
      v.setUint32(32 + 4 * 1, 0xffff, true); // keyOffsets[1]
    });
    rehash(d);
  });
  assert.throws(() => verifyPack(outOfRange), /bad-offsets|outside|past the end/);
});

test('every entry maps to a SCOWL file and line, an authored.txt line, or an override line', () => {
  // Proves the license and no-copied-list claims (E1, E4): no other origin exists.
  const manifest = parseManifest(JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')));
  const rows = parseProvenance(readFileSync(join(packDir, manifest.provenance.file), 'utf8'));
  const origins = new Map<string, number>();
  for (const r of rows) origins.set(r.origin, (origins.get(r.origin) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(origins), { 'scowl-generated': 88170, authored: 493, 'inline-override': 2 });
  for (const r of rows) {
    if (r.origin === 'scowl-generated')
      assert.match(r.file, /^scowl-2020\.12\.07\/final\/(english|american)-words\.(10|20)$/);
    assert.ok(Number.isInteger(r.line) && r.line > 0, `${r.key}: line ${r.line}`);
  }
  const keys = new Set(rows.map((r) => r.key));
  assert.equal(keys.size, table.entries);
  // Every correction source is ours or SCOWL; the pins say so and the pack ships the notices.
  const sources = manifest.sources.filter((s) => s.role === 'correction-source').map((s) => s.name);
  assert.deepEqual(sources, ['scowl', 'authored', 'inline-overrides']);
  assert.match(readFileSync(join(packDir, manifest.licenses[0]?.file as string), 'utf8'), /Kevin Atkinson/);
  assert.match(readFileSync(join(packDir, manifest.notice.file), 'utf8'), /No pair comes from a public typo list/);
});

test('the evaluation gate on the built table matches round 8 within its limits', () => {
  // Catches a data change that raises the wrong-fix rate (E4).
  const config = readGateConfig();
  const result = runGate(table, r6Dictionary(loadInputs()));
  assert.deepEqual(result.failures, []);
  assert.equal(result.clean.tokens, 400000);
  assert.equal(result.clean.wrong, 0);
  assert.equal(result.heldOut.events, config.round8.heldOut.events);
  assert.equal(result.heldOut.wrong, 29);
  // The shipped table adds wich→which and i→I to round 8's combined table: 3 more held-out fixes, 35 on round 6.
  assert.equal(result.heldOut.applied, config.round8.heldOut.applied + 3);
  assert.equal(result.round6.events, config.round6.draws * 4);
  assert.equal(result.round6.wrong, 3);
  assert.deepEqual(
    result.round6.wrongExamples.map((w) => `${w.typed}<${w.intended}`),
    ['adn<dan', 'teh<ten'],
  );
});

test('the gate numbers on the combined table are exactly round 8’s', () => {
  // The same gate code on r8's own table: proves the streams and scoring are r8's, not near it.
  const config = readGateConfig();
  const without = new Map<string, string>();
  for (let i = 0; i < table.entries; i++) {
    const key = keyAt(table, i);
    if (key !== 'wich' && key !== 'i') without.set(key, lookup(table, key) as string);
  }
  const bytes = encodeTable(without);
  assert.equal(sha256(bytes), expected.combined.sha256);
  const combined = mapTable(bytes);
  const result = runGate(combined, r6Dictionary(loadInputs()));
  const counts = ({
    events,
    correct,
    wrong,
    applied,
  }: {
    events: number;
    correct: number;
    wrong: number;
    applied: number;
  }) => ({
    events,
    correct,
    wrong,
    applied,
  });
  assert.deepEqual(counts(result.heldOut), config.round8.heldOut);
  assert.equal(result.clean.wrong, config.round8.clean.wrong);
  // Round 8 scored the round-6 stream with 90,416 right; the overrides don't touch it.
  assert.equal(result.round6.wrong, config.round8.round6.wrong);
});

// --- case policy ---------------------------------------------------------

interface PolicyCase {
  readonly id: string;
  readonly input: {
    readonly token: string;
    readonly context: {
      readonly language?: string;
      readonly origin?: string;
      readonly prose?: boolean;
      readonly vocabulary?: readonly string[];
      readonly rejected?: readonly string[];
    };
  };
  readonly output: { readonly fix: string | null };
}

/**
 * Round 8's lookup.mjs, the case-policy reference, reading the lowercase-only
 * keys from the shipped case-policy.json instead of its hard-coded set. Phase 13
 * owns the real word policy and registers `autocorrect.lookupWord` for these cases.
 */
function referenceLookup(t: PackedTable, lowercaseOnly: ReadonlySet<string>, { token, context }: PolicyCase['input']) {
  const { language = 'en', origin = 'typed', prose = true, vocabulary = [], rejected = [] } = context;
  if (language !== 'en' || origin !== 'typed' || !prose || !/^([a-z]+|[A-Z][a-z]+)$/.test(token)) return null;
  const word = token.toLowerCase();
  if (vocabulary.includes(word) || rejected.includes(word)) return null;
  if (lowercaseOnly.has(word) && token !== word) return null;
  const fix = lookup(t, word);
  if (fix === undefined) return null;
  return token[0] !== word[0] ? (fix[0] as string).toUpperCase() + fix.slice(1) : fix;
}

test('the case policy ships and r8’s policy fixtures pass against the shipped files', () => {
  // Catches the round-13 loss of the lowercase-only rule (E5): Teh, Thier, ADN stay as typed.
  const manifest = parseManifest(JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')));
  assert.equal(manifest.casePolicy.file, 'case-policy.json');
  const policy = parseCasePolicy(JSON.parse(readFileSync(join(packDir, manifest.casePolicy.file), 'utf8')), table);
  assert.deepEqual([...policy.lowercaseOnly], ['adn', 'teh', 'thier']);
  const fixture = JSON.parse(readFileSync(join(fixturesDir, 'case-policy-r8.json'), 'utf8')) as { cases: PolicyCase[] };
  assert.equal(fixture.cases.length, 27, '11 required examples and 16 policy cases');
  for (const c of fixture.cases) {
    assert.equal(referenceLookup(table, policy.lowercaseOnly, c.input), c.output.fix, c.id);
  }
});
