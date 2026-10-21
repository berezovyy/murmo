// murmo words add|remove|list.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { openStore } from '@murmo/store/node';
import { wordsCommand } from '../src/node/words.ts';
import { tempStore } from './helpers.ts';

test('words add/list/remove round-trip', async () => {
  const t = tempStore('murmo-vocab-words-');
  after(() => t.remove());
  const store = await openStore({ roots: t.roots });
  const out: string[] = [];
  const err: string[] = [];
  const ctx = { store, cwd: t.dir, out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
  assert.equal(await wordsCommand(['add', 'ratatui'], ctx), 0);
  assert.equal(await wordsCommand(['list'], ctx), 0);
  assert.equal(out.at(-1), 'ratatui');
  assert.equal(await wordsCommand(['remove', 'ratatui'], ctx), 0);
  out.length = 0;
  assert.equal(await wordsCommand(['list'], ctx), 0);
  assert.equal(out.at(-1), '');
});
