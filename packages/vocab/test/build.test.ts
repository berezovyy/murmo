// An edit on a tracked file appears after a rebuild (lesson 30: listing and
// git index mtime do not change on content edits). Build stays off the key path.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createHarness } from '@murmo/core/testing';
import { autocorrectSpec } from '@murmo/plugin-autocorrect';
import { loadEnglishPack } from '@murmo/plugin-autocorrect/node';
import { buildAndWrite, buildProtection } from '../src/node/build.ts';
import { createProtectionLive } from '../src/node/session.ts';
import { englishTable, gitRepo, tempDir } from './helpers.ts';

before(() => {
  loadEnglishPack();
});

test('a new identifier in a tracked file appears in the table on rebuild (lesson 30)', async () => {
  const t = tempDir('murmo-vocab-edit-');
  after(() => t.remove());
  gitRepo(t.dir, { 'src/lib.rs': 'fn adn() {}\n' });
  const { table, hash } = englishTable();
  const cacheDir = join(t.dir, 'cache');
  const first = await buildAndWrite({ root: t.dir, cacheDir, typo: table, typoHash: hash });
  assert.ok(first.keys.includes('adn'), `keys ${first.keys.join(',')}`);
  assert.equal(first.keys.includes('teh'), false);
  writeFileSync(join(t.dir, 'src/lib.rs'), 'fn adn() {}\nfn teh() {}\n');
  const live = createProtectionLive({ cacheDir, extra: [] });
  assert.equal(live.vocabulary().includes('teh'), false);
  const second = await buildAndWrite({ root: t.dir, cacheDir, typo: table, typoHash: hash });
  assert.ok(second.keys.includes('teh'), `keys ${second.keys.join(',')}`);
  assert.equal(live.refresh(), true);
  assert.equal(live.vocabulary().includes('teh'), true);
});

test('plain-key latency is unchanged while a build runs (off the key path)', async () => {
  const h = await createHarness({ plugins: [autocorrectSpec('autocorrect', { enabled: true })] });
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    h.adapter.fill('', 'unknown');
    const start = performance.now();
    await h.driver.type('teh ');
    samples.push(performance.now() - start);
    assert.equal(h.adapter.getDraft().text, 'the ');
  }
  const t = tempDir('murmo-vocab-keypath-');
  after(() => t.remove());
  gitRepo(t.dir, { 'src/lib.rs': 'fn adn() {}\n'.repeat(50) });
  const { table, hash } = englishTable();
  const building = buildProtection({ root: t.dir, cacheDir: join(t.dir, 'cache'), typo: table, typoHash: hash });
  h.adapter.fill('', 'unknown');
  const during = performance.now();
  await h.driver.type('teh ');
  const took = performance.now() - during;
  assert.equal(h.adapter.getDraft().text, 'the ');
  assert.ok(building.keys.includes('adn'));
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
  assert.ok(took <= p95 * 4 + 20, `during ${took.toFixed(2)} ms vs p95 ${p95.toFixed(2)} ms`);
  await h.session?.dispose();
});
