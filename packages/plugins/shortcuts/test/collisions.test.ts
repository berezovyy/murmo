// r8 matched-pair corpus: 46/50 bare names collide, 0/50 `;`-prefixed (lesson 27, E3).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { collisionKind, compileShortcuts, lexiconFromSets } from '../src/index.ts';
import { seeds } from './helpers.ts';

const corpusPath = fileURLToPath(new URL('../../../../fixtures/shortcuts/collisions.json', import.meta.url));

test('the r8 corpus warns for 46/50 bare names and 0/50 prefixed names', () => {
  const file = JSON.parse(readFileSync(corpusPath, 'utf8')) as {
    cases: { input: { shortcuts: { shortcut: string; group: string }[]; words: string[]; names: string[] } }[];
  };
  const c = file.cases[0];
  assert.ok(c);
  const lexicon = lexiconFromSets({ words: c.input.words, names: c.input.names });
  const bare = c.input.shortcuts.filter((s) => s.group === 'bare');
  const prefixed = c.input.shortcuts.filter((s) => s.group === 'prefixed');
  assert.equal(bare.length, 50);
  assert.equal(prefixed.length, 50);
  const bareHits = bare.filter((s) => collisionKind(s.shortcut, lexicon) !== null);
  const prefixHits = prefixed.filter((s) => collisionKind(s.shortcut, lexicon) !== null);
  assert.equal(bareHits.length, 46, 'a lexicon that missed identifiers/project names would drop below 46');
  assert.equal(prefixHits.length, 0);

  const compiled = compileShortcuts({
    replacements: seeds(Object.fromEntries(c.input.shortcuts.map((s) => [s.shortcut, 'x']))),
    lexicon,
  });
  const warned = compiled.notices.filter((n) => n.kind === 'collision');
  assert.equal(warned.length, 46);
});
