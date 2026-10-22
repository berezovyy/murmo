// Per-key compare-and-set so two sessions do not clobber one key (M7, D4).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createStorageBroker } from '../src/index.ts';

test('cas writes only when the stored revision matches (M7)', async () => {
  const a = createStorageBroker().forPlugin('p');
  const created = await a.cas('k', 0, { n: 1 });
  assert.equal(created.status, 'ok');
  assert.equal(created.revision, 1);
  const lost = await a.cas('k', 0, { n: 2 });
  assert.equal(lost.status, 'conflict');
  assert.equal(((await a.get('k')).value as { n: number }).n, 1);
  const won = await a.cas('k', 1, { n: 3 });
  assert.equal(won.status, 'ok');
  assert.equal(((await a.get('k')).value as { n: number }).n, 3);
});
