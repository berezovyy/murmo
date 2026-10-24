// `;?` search, Tab insert as one edit, Enter never sends, opt-in default (E10, E18).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStore } from '../src/memory.ts';
import { PROJECT, withHistory } from './helpers.ts';

const PROMPT = 'Review the OutboxWorker drain_queue path for timeouts.';

test('enabled=false records 0 prompts on a typed send', async () => {
  const memory = createMemoryStore();
  const h = await withHistory(memory, { enabled: false });
  await h.driver.type(PROMPT);
  await h.driver.submit('send');
  await h.driver.settle();
  assert.equal(memory.records().length, 0);
});

test('enabled=true stores a typed send and skips paste', async () => {
  const memory = createMemoryStore();
  const h = await withHistory(memory, { enabled: true });
  await h.driver.type(PROMPT);
  await h.driver.submit('send');
  await h.driver.settle();
  assert.equal(
    memory.records().some((r) => r.text === PROMPT),
    true,
  );

  const pasted = createMemoryStore();
  const p = await withHistory(pasted, { enabled: true });
  await p.driver.paste(PROMPT);
  await p.driver.submit('send');
  await p.driver.settle();
  assert.equal(pasted.records().length, 0);
  assert.equal(PROJECT.length, 64);
});

test('typing ;? opens history rows; Tab inserts byte-exact text and never submits', async () => {
  const memory = createMemoryStore();
  memory.record([{ text: PROMPT, host: 'pi', project: PROJECT, at: Date.now() }]);
  const h = await withHistory(memory, { enabled: true });
  await h.driver.type(';?review');
  await h.driver.settle();
  assert.ok((h.adapter.menu?.length ?? 0) >= 1, 'history rows');
  const before = h.adapter.getDraft().text;
  assert.equal(before.startsWith(';?'), true);
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, PROMPT);
  assert.equal(h.adapter.requests.length, 0);
});

test('Enter with the history menu open sends 0 requests and picks the prompt, as Tab does', async () => {
  const memory = createMemoryStore();
  memory.record([{ text: PROMPT, host: 'pi', project: PROJECT, at: Date.now() }]);
  const h = await withHistory(memory, { enabled: true });
  await h.driver.type(';?review');
  await h.driver.settle();
  assert.ok(h.adapter.menu);
  assert.equal(await h.driver.key('Enter'), 'consume');
  await h.driver.settle();
  assert.equal(h.adapter.menu, null);
  assert.equal(h.adapter.getDraft().text, PROMPT);
  assert.equal(h.adapter.requests.length, 0);
});

test('ordinary keys with the menu closed do not increment history lookups', async () => {
  const memory = createMemoryStore();
  memory.record([{ text: PROMPT, host: 'pi', project: PROJECT, at: 1 }]);
  const h = await withHistory(memory, { enabled: true });
  const before = memory.lookups;
  await h.driver.type('hello world this is not a history query');
  await h.driver.settle();
  assert.equal(memory.lookups, before);
});
