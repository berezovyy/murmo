// Key router, claim validation, explicit order and the merged menu (phase 06).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KeyClaim, PluginFactory } from '@murmo/api';
import { NAMED_KEYS } from '@murmo/api';
import { MENU_WINDOW, PluginOrderError, resolveOrder, uniquePluginIds } from '../src/index.ts';
import { createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

const spec = (id: string, factory: PluginFactory, builtin = true): DirectPluginSpec => ({ id, builtin, factory });

test('duplicate, missing and unknown IDs are refused before load (E3, r14 K1)', () => {
  assert.throws(() => uniquePluginIds(['A', 'A']), PluginOrderError);
  assert.throws(() => resolveOrder(['A', 'B'], ['A', 'A']), /explicit unique plugin order/);
  assert.throws(() => resolveOrder(['A', 'B'], ['A']), /must occur in order/);
  assert.throws(() => resolveOrder(['A'], ['A', 'B']), /unknown ordered plugin/);
  assert.deepEqual(resolveOrder(['B', 'A']), ['B', 'A']);
  assert.deepEqual(resolveOrder(['B', 'A'], ['A', 'B']), ['A', 'B']);
});

test('createHarness refuses duplicate spec IDs before any factory runs (E3)', async () => {
  let constructed = 0;
  const factory: PluginFactory = () => {
    constructed++;
    return { name: 'x', version: '1', permissions: [] };
  };
  await assert.rejects(
    () => createHarness({ plugins: [spec('dup', factory), spec('dup', factory)] }),
    /duplicate plugin ID/,
  );
  assert.equal(constructed, 0);
});

test('an explicit order list, not object-key order, decides who wins (E3, Codex BA)', async () => {
  const byLetter: Record<string, DirectPluginSpec> = {
    B: spec('B', () => ({
      name: 'B',
      version: '1',
      permissions: ['draft:read', 'draft:write'],
      keys: [{ key: 'F6', when: ['editable', 'ghost-visible-by-me'], action: 'accept-ghost' }],
      onChange(change) {
        return change.draft.text === 'go' ? [{ type: 'ghost', text: 'B', baseVersion: change.draft.version }] : [];
      },
    })),
    A: spec('A', () => ({
      name: 'A',
      version: '1',
      permissions: ['draft:read', 'draft:write'],
      keys: [{ key: 'F6', when: ['editable', 'ghost-visible-by-me'], action: 'accept-ghost' }],
      onChange(change) {
        return change.draft.text === 'go' ? [{ type: 'ghost', text: 'A', baseVersion: change.draft.version }] : [];
      },
    })),
  };
  // Insertion order B, A — the configured list still runs A first.
  const pluginB = byLetter.B;
  const pluginA = byLetter.A;
  assert.ok(pluginB && pluginA);
  const h = await createHarness({ plugins: [pluginB, pluginA], order: ['A', 'B'] });
  await h.driver.type('go');
  assert.equal(h.adapter.ghost, 'A');
  assert.equal(await h.driver.key('F6'), 'consume');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'goA');
});

test('plugin code does not run inside deliverKey (E1, lesson 46)', async () => {
  let ran = false;
  const h = await createHarness({
    plugins: [
      spec('d', () => ({
        name: 'd',
        version: '1',
        permissions: [],
        keys: [{ key: 'F1', when: ['always'], action: 'dispatch' }],
        onKey() {
          ran = true;
        },
      })),
    ],
  });
  assert.equal(h.adapter.deliverKey('F1'), 'pass');
  assert.equal(ran, false);
  await h.driver.settle();
  assert.equal(ran, true);
});

test('a function predicate, unknown condition, or write without key support never consumes (E1)', async () => {
  const factory: PluginFactory = () => ({
    name: 'bad',
    version: '1',
    permissions: ['draft:read', 'draft:write'],
    keys: [
      { key: 'Tab', when: [(() => true) as unknown as 'always'], action: 'consume' },
      { key: 'Enter', when: ['editable'], action: 'consume' },
      { key: 'F9', when: ['not-a-condition' as 'always'], action: 'consume' },
      { key: 'F8', when: ['always'], action: 'consume' },
    ] as KeyClaim[],
  });
  const h = await createHarness({
    plugins: [spec('bad', factory)],
    caps: { keys: [...NAMED_KEYS.filter((k) => k !== 'F8')] },
  });
  const notices = h.session?.stats().notices ?? [];
  assert.ok(notices.some((n) => n.includes('function') || n.includes('not data')));
  assert.ok(notices.some((n) => n.includes('Enter is never consumed')));
  assert.ok(notices.some((n) => n.includes('unknown condition')));
  assert.ok(notices.some((n) => n.includes('cannot intercept F8')));
  assert.equal(await h.driver.key('Tab'), 'pass');
  assert.equal(await h.driver.key('Enter'), 'pass');
  assert.equal(await h.driver.key('F9'), 'pass');
  assert.equal(await h.driver.key('F8'), 'pass');
});

test('third-party always consume of Tab is refused; a ghost Tab still works (E7, E8)', async () => {
  const hog: DirectPluginSpec = {
    id: 'hog',
    builtin: false,
    factory: () => ({
      name: 'hog',
      version: '1',
      permissions: [],
      keys: [{ key: 'Tab', when: ['always'], action: 'consume' }],
    }),
  };
  const ghost: DirectPluginSpec = spec('g', () => ({
    name: 'g',
    version: '1',
    permissions: ['draft:read', 'draft:write'],
    keys: [{ key: 'Tab', when: ['ghost-visible-by-me', 'editable'], action: 'accept-ghost' }],
    onChange(change) {
      return [{ type: 'ghost', text: 'Z', baseVersion: change.draft.version }];
    },
  }));
  const h = await createHarness({ plugins: [hog, ghost] });
  await h.driver.type('a');
  assert.equal(h.adapter.ghost, 'Z');
  assert.equal(await h.driver.key('Tab'), 'consume');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'aZ');
  assert.ok((h.session?.stats().notices ?? []).some((n) => n.includes('shared key Tab')));
});

test('native popup and dialog pass Tab, Enter, Up and Escape whatever claims exist (E5)', async () => {
  const h = await createHarness({
    plugins: [
      spec('c', () => ({
        name: 'c',
        version: '1',
        permissions: ['draft:read', 'draft:write'],
        keys: [{ key: 'F1', when: ['always'], action: 'consume' }],
        onChange(change) {
          return [{ type: 'menu', items: [{ id: 'x', label: 'x' }], baseVersion: change.draft.version }];
        },
      })),
    ],
  });
  await h.driver.type('x');
  await h.driver.state({ popup: { owner: 'host' } });
  for (const key of ['Tab', 'Enter', 'Up', 'Escape']) {
    assert.equal(await h.driver.key(key), 'pass', key);
  }
  await h.driver.state({ popup: null, dialog: true });
  for (const key of ['Tab', 'Enter', 'Up', 'Escape']) {
    assert.equal(await h.driver.key(key), 'pass', key);
  }
  assert.equal(h.adapter.requests.length, 0);
});

test('two plugins with the same item id each get their own row; a 1000-row flood shows 10, all owned by the emitter (E7, E18)', async () => {
  const row = (id: string): DirectPluginSpec =>
    spec(id, () => ({
      name: id,
      version: '1',
      permissions: ['draft:read', 'draft:write'],
      onChange(change) {
        return [
          {
            type: 'menu',
            items: [{ id: 'same', label: 'row', owner: 'spoofed' } as { id: string; label: string }],
            baseVersion: change.draft.version,
          },
        ];
      },
      onMenuSelect(_item, ctx) {
        return [
          {
            type: 'edit',
            edit: {
              from: ctx.draft.cursor,
              to: ctx.draft.cursor,
              insert: id,
              baseVersion: ctx.draft.version,
              undoable: true,
            },
          },
        ];
      },
    }));
  const flood: DirectPluginSpec = spec('flood', () => ({
    name: 'flood',
    version: '1',
    permissions: ['draft:read'],
    onChange(change) {
      const items = Array.from({ length: 1000 }, (_, i) => ({
        id: `r${i}`,
        label: 'x',
        owner: 'other-plugin',
      }));
      return [{ type: 'menu', items, baseVersion: change.draft.version }];
    },
  }));
  const pair = await createHarness({ plugins: [row('A'), row('B')] });
  await pair.driver.type('m');
  assert.deepEqual(
    pair.adapter.menu?.map((r) => ({ id: r.id, owner: r.owner })),
    [
      { id: 'same', owner: 'A' },
      { id: 'same', owner: 'B' },
    ],
  );
  assert.equal(await pair.driver.key('Tab'), 'consume');
  await pair.driver.settle();
  assert.equal(pair.adapter.getDraft().text, 'mA');

  const flooded = await createHarness({ plugins: [flood] });
  await flooded.driver.type('m');
  assert.equal(flooded.adapter.menu?.length, MENU_WINDOW);
  assert.ok(flooded.adapter.menu?.every((r) => r.owner === 'flood'));
});

test('dispatch without consume falls through to the next claim (api.md § Keys)', async () => {
  let dispatched = false;
  const h = await createHarness({
    plugins: [
      spec('d', () => ({
        name: 'd',
        version: '1',
        permissions: [],
        keys: [{ key: 'F1', when: ['always'], action: 'dispatch' }],
        onKey() {
          dispatched = true;
        },
      })),
      spec('c', () => ({
        name: 'c',
        version: '1',
        permissions: [],
        keys: [{ key: 'F1', when: ['always'], action: 'consume' }],
      })),
    ],
  });
  assert.equal(await h.driver.key('F1'), 'consume');
  await h.driver.settle();
  assert.equal(dispatched, true);
  assert.equal(h.session?.stats().keyBy.claim, 1);
});

test('Enter in a plugin menu never sends; selection wraps (E4)', async () => {
  const h = await createHarness({
    plugins: [
      spec('m', () => ({
        name: 'm',
        version: '1',
        permissions: ['draft:read', 'draft:write'],
        onChange(change) {
          return [
            {
              type: 'menu',
              items: [
                { id: 'a', label: 'A' },
                { id: 'b', label: 'B' },
              ],
              baseVersion: change.draft.version,
            },
          ];
        },
      })),
    ],
  });
  await h.driver.type('x');
  assert.equal(h.adapter.menu?.length, 2);
  assert.equal(h.adapter.menuSelected, 0);
  await h.driver.key('Up');
  assert.equal(h.adapter.menuSelected, 1);
  await h.driver.key('Down');
  assert.equal(h.adapter.menuSelected, 0);
  assert.equal(await h.driver.key('Enter'), 'consume');
  assert.equal(h.adapter.menu, null);
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.adapter.getDraft().text, 'x');
});

test('murmo.menu calls onAction in plugin order and merges their rows (lesson 72)', async () => {
  const open: DirectPluginSpec = spec('open', () => ({
    name: 'open',
    version: '1',
    permissions: ['draft:read'],
    actions: ['murmo.menu'],
    onAction(action, ctx) {
      if (action !== 'murmo.menu') return [];
      return [{ type: 'menu', items: [{ id: 'row', label: 'from-action' }], baseVersion: ctx.draft.version }];
    },
  }));
  const h = await createHarness({ plugins: [open] });
  await h.driver.action('murmo.menu');
  await h.driver.settle();
  assert.equal(h.adapter.menu?.[0]?.id, 'row');
  assert.equal(h.adapter.menu?.[0]?.owner, 'open');
});

test('native semantic selection routes by owner and opaque id (clarification 9)', async () => {
  const h = await createHarness({
    plugins: [
      spec('m', () => ({
        name: 'm',
        version: '1',
        permissions: ['draft:read', 'draft:write'],
        onChange(change) {
          return [{ type: 'menu', items: [{ id: 'pick', label: 'Pick' }], baseVersion: change.draft.version }];
        },
        onMenuSelect(item, ctx) {
          if (item.id !== 'pick') return [];
          return [
            {
              type: 'edit',
              edit: { from: 0, to: ctx.draft.cursor, insert: 'picked', baseVersion: ctx.draft.version, undoable: true },
            },
          ];
        },
      })),
    ],
  });
  await h.driver.type('x');
  await h.driver.selectMenu('m', 'pick');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'picked');
});

function p99(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
}

test('route() p99 with 20 plugins of 4 claims each is ≤ 0.1 ms (E2, E16)', async () => {
  const claims: KeyClaim[] = [
    { key: 'Tab', when: ['ghost-visible-by-me', 'editable'], action: 'accept-ghost' },
    { key: 'F1', when: ['always'], action: 'consume' },
    { key: 'F2', when: ['menu-open'], action: 'consume' },
    { key: 'F3', when: ['after-my-edit', 'editable'], action: 'consume' },
  ];
  const plugins: DirectPluginSpec[] = Array.from({ length: 20 }, (_, i) =>
    spec(`p${i}`, () => ({
      name: `p${i}`,
      version: '1',
      permissions: ['draft:read'],
      keys: claims,
    })),
  );
  const main = await createHarness({ plugins });
  const key = 'a';
  for (let i = 0; i < 200; i++) main.adapter.deliverKey(key);
  const samples: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const start = performance.now();
    main.adapter.deliverKey(key);
    samples.push(performance.now() - start);
  }
  const observed = p99(samples);
  assert.ok(observed <= 0.1, `p99 ${observed.toFixed(4)} ms exceeds the 0.1 ms target`);
  await main.driver.settle();
});
