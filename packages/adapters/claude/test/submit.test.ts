// Managed transform/block, classic final-boundary, menu-Enter drop (E9, E12).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLASSIC_GUARD_TIMEOUT_MS } from '../src/types.ts';
import { boot, type } from './boot.ts';
import { classicNext, submitNext } from './fake-runtime.ts';

test('a required guard blocks a managed send and keeps the draft (C8)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'TODO');
  const result = await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
  assert.ok(result.drop);
  assert.equal(fake.sent.length, 0);
  assert.equal(fake.draft.text, 'TODO');
  await host.dispose();
});

test('classic UserPromptSubmit blocks what a later peer appends (E9, lesson 51)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'hello');
  const result = await host.adapter.handleClassic({ prompt: `${fake.draft.text} TODO` }, classicNext(fake));
  assert.ok(result.block);
  assert.equal(fake.sent.length, 0);
  await host.dispose();
});

test('Enter with a displayed plugin menu drops the send (E12, r14 H2)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'hello');
  host.adapter.showMenu([{ owner: 'lint', id: '1', label: 'fix' }], 0, host.adapter.getDraft().version);
  const result = await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
  assert.ok(result.drop);
  assert.equal(fake.sent.length, 0);
  await host.dispose();
});

test('a forwarded send reports a draft clear so the core can infer commit (phase 08)', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'hello');
  const result = await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
  assert.equal(result.drop, undefined);
  assert.deepEqual(fake.sent, ['hello']);
  assert.equal(host.adapter.getDraft().text, '');
  await host.dispose();
});

test('classic guard timeout is the shipped 1 s (task 8a, E20)', () => {
  assert.equal(CLASSIC_GUARD_TIMEOUT_MS, 1000);
});
