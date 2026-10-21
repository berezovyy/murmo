// Real names stay uncorrected with protection and are corrected without it
// (lesson 16, r6 `ratatui` → `ratatouille`). Engine round 4: `legacy-api`
// keeps teh/recieve/wich; `app` still corrects them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarness } from '@murmo/core/testing';
import { findEntry, lookup } from '@murmo/lang';
import { autocorrectSpec, lookupWord } from '@murmo/plugin-autocorrect';
import { loadEnglishPack } from '@murmo/plugin-autocorrect/node';
import { decodeProtection, encodeProtection, isProtectedKey, protectedWords } from '../src/index.ts';
import { englishTable } from './helpers.ts';

const collisionsFile = join(dirname(fileURLToPath(import.meta.url)), 'collisions.json');

before(() => {
  loadEnglishPack();
});

test('every r6 collision that is a lang-en key is protected, and is a typo without protection', () => {
  const { table } = englishTable();
  const data = JSON.parse(readFileSync(collisionsFile, 'utf8')) as { repos: Record<string, string[]> };
  const terms = [...new Set(Object.values(data.repos).flat())];
  const inTable = terms.filter((term) => findEntry(table, term) >= 0);
  // r6 collisions that remain in lang-en (many, including ratatui, were frozen
  // into the pack's protected terms and are already absent). Always include a
  // live typo key so protection still has something to prove.
  const keys = inTable.length > 0 ? inTable : ['teh', 'recieve', 'wich'];
  const packed = encodeProtection({ keys, cacheKey: 'test' });
  const decoded = decodeProtection(packed);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  for (const term of keys) {
    if (findEntry(table, term) < 0) continue;
    assert.equal(isProtectedKey(decoded.table.packed, term), true, term);
    assert.equal(lookupWord({ token: term, context: {} }).fix, lookup(table, term) ?? null);
    assert.deepEqual(lookupWord({ token: term, context: { vocabulary: [term] } }), { fix: null });
  }
});

test('legacy-api vocabulary keeps teh recieve wich; app still corrects them (r4)', async () => {
  const legacy = await createHarness({
    plugins: [autocorrectSpec('autocorrect', { enabled: true }, ['teh', 'recieve', 'wich'])],
  });
  await legacy.driver.type('teh recieve wich ');
  assert.equal(legacy.adapter.getDraft().text, 'teh recieve wich ');
  await legacy.session?.dispose();

  const app = await createHarness({ plugins: [autocorrectSpec('autocorrect', { enabled: true })] });
  await app.driver.type('teh recieve wich ');
  assert.equal(app.adapter.getDraft().text, 'the receive which ');
  await app.session?.dispose();
});

test('[words] protect and allowlist are always included even if not typo keys', () => {
  const words = protectedWords(undefined, ['teh', 'OutboxWorker']);
  assert.ok(words.includes('teh'));
  assert.ok(words.includes('outboxworker'));
});

test('protection table stays tiny for the r6 collision lists', () => {
  const data = JSON.parse(readFileSync(collisionsFile, 'utf8')) as { repos: Record<string, string[]> };
  for (const [repo, terms] of Object.entries(data.repos)) {
    const bytes = encodeProtection({ keys: terms, cacheKey: repo });
    assert.ok(bytes.byteLength < 64 * 1024, `${repo} ${bytes.byteLength}`);
  }
});
