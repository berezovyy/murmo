// Manifest preflight on Node: every case in manifest-cases.json (each names the
// failure it catches), plus the error text authors read. The same cases run on
// Bun, QuickJS-wasm and rquickjs in `pnpm test:portable` (portable-parity.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ManifestError, negotiate, type PluginManifest, validateManifest } from '../src/index.ts';
import { type CaseFile, run } from './manifest-cases.ts';

const file: CaseFile = JSON.parse(readFileSync(new URL('./manifest-cases.json', import.meta.url), 'utf8'));
const verdicts = new Map(run(file).map((v) => [v.id, v]));

for (const c of file.cases) {
  test(`${c.fn} ${c.id}: ${c.reason}`, () => {
    const { id: _, ...outcome } = verdicts.get(c.id) ?? { id: c.id };
    assert.deepEqual(outcome, c.output);
  });
}

test('case ids are unique, so a parity diff names exactly one case', () => {
  assert.equal(new Set(file.cases.map((c) => c.id)).size, file.cases.length);
});

test('a ^1.x manifest is refused with a message that says what to do (lesson 72: authors follow messages)', () => {
  const legacy = { ...file.base, api: '^1.2.0' } as unknown as PluginManifest;
  const caps = file.caps['managed-host'];
  assert.ok(caps);
  assert.throws(
    () => negotiate(legacy, caps),
    (error: unknown) =>
      error instanceof ManifestError &&
      /targets API \^1\.2\.0; this core implements 2\.0\.0/.test(error.message) &&
      /rewrite the plugin for \^2\.0\.0/.test(error.message),
  );
});

test('the validated manifest is a detached copy, so a later change to the source object cannot alter what was checked', () => {
  const source = JSON.parse(JSON.stringify(file.base));
  const checked = validateManifest(source);
  source.permissions.push({ name: 'network', reason: 'Added after preflight.' });
  assert.equal(checked.permissions.length, 1);
});
