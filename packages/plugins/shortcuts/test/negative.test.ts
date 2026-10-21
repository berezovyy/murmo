// Must-not-expand: only typed shortcuts at a typed boundary (lesson 26, r8 negatives).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '@murmo/core/testing';
import { pluginOf } from './helpers.ts';

const rvw = 'Review the change.';

async function session() {
  return createHarness({ plugins: [pluginOf({ rvw, tst: 'run tests' })] });
}

test('pasted, recalled and filled rvw stay literal', async () => {
  const h = await session();
  await h.driver.paste('rvw');
  await h.driver.type(' ');
  assert.equal(h.adapter.getDraft().text, 'rvw ');
  h.adapter.fill('', 'unknown');
  await h.driver.history('rvw');
  await h.driver.type(' ');
  assert.equal(h.adapter.getDraft().text, 'rvw ');
  h.adapter.fill('', 'unknown');
  await h.driver.fill('rvw', 'fill');
  await h.driver.type(' ');
  assert.equal(h.adapter.getDraft().text, 'rvw ');
  await h.session?.dispose();
});

test('quoted, path, command-prefix and case-mismatched names stay literal', async () => {
  const h = await session();
  for (const typed of ['"rvw" ', '`rvw` ', 'src/rvw/ ', '/rvw ', '@rvw ', '!rvw ', 'Rvw ']) {
    h.adapter.fill('', 'unknown');
    await h.driver.type(typed);
    assert.equal(h.adapter.getDraft().text, typed, typed);
  }
  await h.session?.dispose();
});

test('tst.ts stays literal because shortcuts never fire at `.`', async () => {
  const h = await session();
  await h.driver.type('tst.ts');
  assert.equal(h.adapter.getDraft().text, 'tst.ts');
  await h.session?.dispose();
});

test('shell mode, Vim Normal and an open menu do not expand', async () => {
  const h = await session();
  await h.driver.state({ mode: 'shell' });
  await h.driver.type('rvw ');
  assert.equal(h.adapter.getDraft().text, 'rvw ');
  h.adapter.fill('', 'unknown');
  await h.driver.state({ mode: 'prose', editorMode: 'normal' });
  await h.driver.type('rvw ');
  assert.equal(h.adapter.getDraft().text, 'rvw ');
  h.adapter.fill('', 'unknown');
  await h.driver.state({ editorMode: 'insert', popup: { owner: 'host' } });
  await h.driver.type('rvw ');
  assert.equal(h.adapter.getDraft().text, 'rvw ');
  await h.session?.dispose();
});

test('Enter sends the typed shortcut and never expands', async () => {
  const h = await session();
  await h.driver.type('rvw');
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'send');
  assert.deepEqual(
    h.adapter.requests.map((r) => r.text),
    ['rvw'],
  );
  await h.session?.dispose();
});
