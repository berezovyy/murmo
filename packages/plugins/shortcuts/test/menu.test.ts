// `;` menu: never-open, Tab insert, Enter/Esc, Space, closed-menu lookups,
// host profiles (docs/plan/16).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { HostState } from '@murmo/api';
import { createHarness } from '@murmo/core/testing';
import { compileShortcuts, filterNames, menuPlugin, r9MenuShortcuts, SAMPLE_SHORTCUTS } from '../src/index.ts';
import { expectedPath, HOST_CAPS, menuOf, pluginOf, seeds } from './helpers.ts';

const expected = JSON.parse(readFileSync(expectedPath, 'utf8')) as Record<string, string>;

test('x;, backticks, fences, /, @, !, shell, Vim, popup and paste never open the menu', async () => {
  // Catches a regex-on-draft trigger that hijacks typing (r9 midword / code / commands).
  for (const typed of ['x;', '`x;', '```\n;', '/;', '@;', '!;']) {
    const h = await createHarness({ plugins: [menuOf(SAMPLE_SHORTCUTS)] });
    await h.driver.type(typed);
    assert.equal(h.adapter.menu, null, typed);
    await h.session?.dispose();
  }
  const states: Array<[string, Partial<HostState>]> = [
    ['shell', { mode: 'shell' }],
    ['vim', { editorMode: 'normal' }],
    ['popup', { popup: { owner: 'host' } }],
  ];
  for (const [label, patch] of states) {
    const h = await createHarness({ plugins: [menuOf(SAMPLE_SHORTCUTS)] });
    await h.driver.state(patch);
    await h.driver.type(';');
    assert.equal(h.adapter.menu, null, label);
    await h.session?.dispose();
  }
  const pasted = await createHarness({ plugins: [menuOf(SAMPLE_SHORTCUTS)] });
  await pasted.driver.paste(';');
  assert.equal(pasted.adapter.menu, null);
  await pasted.session?.dispose();
});

test('typing ; at a word start opens a filtered menu', async () => {
  const h = await createHarness({ plugins: [menuOf(SAMPLE_SHORTCUTS)] });
  await h.driver.type(';');
  assert.ok((h.adapter.menu?.length ?? 0) >= 1);
  await h.driver.type('rvw');
  assert.deepEqual(
    h.adapter.menu?.map((r) => r.id),
    ['rvw'],
  );
  await h.session?.dispose();
});

test('Tab inserts each r9 fixture byte-exact; Backspace restores ;query on every host profile', async () => {
  // Catches a UTF-16 cap, a dropped newline, or Claude Tab that does not restore (E5).
  for (const [host, profile] of Object.entries(HOST_CAPS)) {
    const native = host === 'claude';
    const caps = native
      ? {
          ...profile.caps,
          inline: { ...profile.caps.inline, nativeCompletion: true },
          edit: { ...profile.caps.edit, atomic: false },
        }
      : profile.caps;
    for (const [name, text] of Object.entries(expected)) {
      const trigger = name.startsWith(';') ? name : `;${name}`;
      const h = await createHarness({ plugins: [menuOf(expected)], caps });
      await h.driver.type(trigger);
      assert.ok(
        h.adapter.menu?.some((r) => r.id === name || r.id === trigger),
        `${host} ${name} row`,
      );
      const routing = await h.driver.key('Tab');
      await h.driver.settle();
      assert.equal(routing, native ? 'pass' : 'consume', `${host} ${name} Tab`);
      assert.equal(h.adapter.getDraft().text, text, `${host} ${name}`);
      assert.equal(h.adapter.getDraft().cursor, text.length, `${host} ${name} cursor`);
      assert.equal(h.adapter.requests.length, 0, `${host} ${name} send`);
      await h.driver.key('Backspace');
      assert.equal(h.adapter.getDraft().text, trigger, `${host} ${name} backspace`);
      await h.session?.dispose();
    }
  }
});

test('Enter with the menu open sends 0 requests and leaves the draft in both plugin orders', async () => {
  // Catches Claude submitting the raw ;rvw (lessons 32, 74).
  for (const [host, profile] of Object.entries(HOST_CAPS)) {
    for (const order of ['menu-first', 'shortcuts-first'] as const) {
      const compiled = compileShortcuts({ replacements: seeds(SAMPLE_SHORTCUTS) });
      const menu = menuPlugin(compiled);
      const shortcuts = pluginOf(SAMPLE_SHORTCUTS, profile.compile);
      const plugins = order === 'menu-first' ? [menu, shortcuts] : [shortcuts, menu];
      const caps =
        host === 'claude'
          ? { ...profile.caps, inline: { ...profile.caps.inline, nativeCompletion: true } }
          : profile.caps;
      const h = await createHarness({ plugins, caps });
      await h.driver.type(';rvw');
      assert.ok(h.adapter.menu);
      assert.equal(await h.driver.key('Enter'), 'consume');
      assert.equal(h.adapter.menu, null, `${host} ${order}`);
      assert.equal(h.adapter.getDraft().text, ';rvw', `${host} ${order} draft`);
      assert.equal(h.adapter.requests.length, 0, `${host} ${order} send`);
      await h.session?.dispose();
    }
  }
});

test('Space closes the menu without inserting the row; an exact ;name still expands', async () => {
  // Catches Space inserting the highlighted row instead of running the inline rule.
  const text = 'Review this change.';
  const compiled = compileShortcuts({ replacements: seeds({ ';rvw': text }) });
  const h = await createHarness({
    plugins: [pluginOf({ ';rvw': text }), menuPlugin(compiled)],
  });
  await h.driver.type(';rv');
  assert.ok(h.adapter.menu);
  await h.driver.type('w ');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, `${text} `);
  assert.equal(h.adapter.menu, null);
  await h.session?.dispose();
});

test('Escape closes without inserting', async () => {
  const h = await createHarness({ plugins: [menuOf(SAMPLE_SHORTCUTS)] });
  await h.driver.type(';rvw');
  assert.equal(await h.driver.key('Escape'), 'consume');
  assert.equal(h.adapter.menu, null);
  assert.equal(h.adapter.getDraft().text, ';rvw');
  assert.equal(h.adapter.requests.length, 0);
  await h.session?.dispose();
});

test('closed-menu keys do no name lookups', async () => {
  // Catches filtering on every key while the menu is closed (E12, r9 history guard).
  const spec = menuOf(SAMPLE_SHORTCUTS);
  const h = await createHarness({ plugins: [spec] });
  const before = spec.state.table.lookups;
  for (let i = 0; i < 10_000; i++) h.adapter.deliverKey('a');
  await h.driver.settle();
  assert.equal(spec.state.table.lookups, before);
  await h.session?.dispose();
});

test('filtering 1,006 shortcuts stays ≤ 1 ms p99', () => {
  // Catches a scan that misses the per-boundary budget (architecture speed).
  const compiled = compileShortcuts({ replacements: seeds(r9MenuShortcuts(expected)) });
  const spec = menuPlugin(compiled);
  const queries = ['', 's', 's0', 's09', 's099', 'rvw', 'zzz'];
  for (let i = 0; i < 200; i++) filterNames(spec.state.table, queries[i % queries.length] as string);
  const samples: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const q = queries[i % queries.length] as string;
    const start = performance.now();
    filterNames(spec.state.table, q);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))] ?? 0;
  assert.ok(p99 <= 1, `p99 ${p99.toFixed(3)} ms exceeds 1 ms`);
});

test('history option adds a ;? last row (E10)', async () => {
  const h = await createHarness({ plugins: [menuOf(SAMPLE_SHORTCUTS, { history: true })] });
  await h.driver.type(';');
  const last = h.adapter.menu?.[h.adapter.menu.length - 1];
  assert.equal(last?.id, '?');
  assert.equal(last?.detail, 'Search prompt history');
  await h.session?.dispose();
});
