// On-request prose aliases replace the matched words; never by themselves (E10).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness } from '@murmo/core/testing';
import { PROJECT_REF_ID } from '../src/index.ts';
import { FIXTURE, pluginOf } from './helpers.ts';

test('outbox worker on the names key offers OutboxWorker with file', async () => {
  const h = await createHarness({ plugins: [pluginOf(undefined, { key: 'Ctrl+n' })] });
  await h.driver.type('outbox worker');
  await h.driver.action('murmo.menu');
  await h.driver.settle();
  const labels = h.adapter.menu?.map((r) => r.label) ?? [];
  assert.ok(
    labels.some((l) => l.includes('OutboxWorker') && l.includes('worker.rs')),
    `${labels.join(' | ')}`,
  );
  await h.session?.dispose();
});

test('accept replaces the matched words in one edit; Backspace restores them', async () => {
  const h = await createHarness({ plugins: [pluginOf(undefined, { key: 'Ctrl+n' })] });
  await h.driver.type('outbox worker');
  await h.driver.action('murmo.menu');
  await h.driver.settle();
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'OutboxWorker');
  await h.driver.key('Backspace');
  assert.equal(h.adapter.getDraft().text, 'outbox worker');
  await h.session?.dispose();
});

test('second action inserts the name plus its path', async () => {
  const h = await createHarness({ plugins: [pluginOf(undefined, { key: 'Ctrl+n' })] });
  await h.driver.type('outbox worker');
  await h.driver.action('murmo.menu');
  await h.driver.settle();
  const pathRow = h.adapter.menu?.find((r) => r.id.startsWith('p:'));
  assert.ok(pathRow, 'path action missing');
  await h.driver.key('Down');
  await h.driver.key('Tab');
  await h.driver.settle();
  assert.match(h.adapter.getDraft().text, /OutboxWorker \(`src\/outbox\/worker\.rs`\)/);
  await h.session?.dispose();
});

test('semicolon menu row Insert project reference then lists aliases', async () => {
  const h = await createHarness({ plugins: [pluginOf()] });
  await h.driver.type('outbox worker ;');
  await h.driver.settle();
  const labels = h.adapter.menu?.map((r) => r.label) ?? [];
  assert.ok(
    labels.some((l) => l.includes('Insert project reference')),
    labels.join(' | '),
  );
  const row = h.adapter.menu?.find((r) => r.id === PROJECT_REF_ID);
  assert.ok(row);
  await h.session?.dispose();
});

test('no Insert project reference row when it has nothing to insert', async () => {
  // Pi showed a dead row on every `;` with an empty name index.
  for (const [entries, typed] of [
    [[], 'outbox worker ;'],
    [FIXTURE, ';'],
  ] as const) {
    const h = await createHarness({ plugins: [pluginOf([...entries])] });
    await h.driver.type(typed);
    await h.driver.settle();
    assert.equal(
      h.adapter.menu?.find((r) => r.id === PROJECT_REF_ID),
      undefined,
      `${entries.length} names, ${typed}`,
    );
    await h.session?.dispose();
  }
});

test('accept replaces matched words on all four host profiles with Backspace revert', async () => {
  const hosts = [
    { name: 'pi', caps: {} },
    { name: 'opencode', caps: {} },
    { name: 'codex', caps: { inline: { maxBytes: 900 } } },
    {
      name: 'claude',
      caps: { edit: { atomic: false }, inline: { nativeCompletion: true, maxBytes: 1024 } },
      single: true,
    },
  ] as const;
  for (const host of hosts) {
    const h = await createHarness({
      plugins: [pluginOf(undefined, { key: 'Ctrl+n' }, host.name)],
      caps: host.caps,
    });
    const typed = 'single' in host && host.single ? 'worker' : 'outbox worker';
    await h.driver.type(typed);
    await h.driver.action('murmo.menu');
    await h.driver.settle();
    assert.ok((h.adapter.menu?.length ?? 0) >= 1, `${host.name} rows`);
    await h.driver.key('Tab');
    await h.driver.settle();
    assert.match(h.adapter.getDraft().text, /OutboxWorker/, host.name);
    await h.driver.key('Backspace');
    assert.equal(h.adapter.getDraft().text, typed, `${host.name} revert`);
    await h.session?.dispose();
  }
});

test('Claude native completion is single-word only for aliases', async () => {
  const h = await createHarness({
    plugins: [pluginOf(undefined, { key: 'Ctrl+n' })],
    caps: { inline: { nativeCompletion: true } },
  });
  await h.driver.type('worker');
  await h.driver.action('murmo.menu');
  await h.driver.settle();
  const labels = h.adapter.menu?.map((r) => r.label) ?? [];
  assert.ok(
    labels.some((l) => l.includes('OutboxWorker')),
    labels.join(' | '),
  );
  await h.session?.dispose();
});
