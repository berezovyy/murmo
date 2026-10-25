// Live `murmo codex` typed `;` but the picker never opened: a delta-less
// native publish resynced typedSpans to [] so findTrigger refused the `;`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPluginHost, createSession } from '@murmo/core';
import { createInProcessExecutor } from '@murmo/executor';
import { compileShortcuts, menuPlugin } from '@murmo/plugin-shortcuts';
import { asSnap, createAdapter } from '../src/js/adapter.ts';

test('typed semicolon opens the overlay menu from trusted shortcuts', async () => {
  let snap: Record<string, unknown> = {
    draft: { text: '', cursor: 0, version: 0 },
    state: 'idle',
    known: true,
    title: 'Ready',
    probed: true,
  };
  const painted: unknown[] = [];
  const adapter = createAdapter(
    (op, data = {}) => {
      if (op === 'snapshot') return { snapshot: snap };
      if (op === 'ui') {
        painted.push(data.ui);
        return { ok: true };
      }
      return { ok: true, snapshot: snap };
    },
    { menu: true },
  );
  const compiled = compileShortcuts({
    replacements: [{ shortcut: ';rvw', text: 'Review this change.', origin: 'user' }],
  });
  const menu = menuPlugin(compiled, { width: 80 });
  const executor = createInProcessExecutor();
  const session = createSession({
    adapter,
    runner: createPluginHost({
      specs: [{ id: menu.id, builtin: true, factory: menu.factory }],
      executor,
      grants: { menu: ['draft:read', 'draft:write'] },
    }),
    keyBursts: true,
    order: ['menu'],
  });
  await session.ready;

  const before = adapter.draft();
  snap = {
    ...snap,
    draft: { text: ';', cursor: 1, version: 1 },
  };
  adapter.applyNative(asSnap(snap));
  adapter.publish(adapter.adoptNative(before, 'typed', { from: 0, to: 0, length: 1 }));
  await session.settle();

  const last = painted.at(-1) as { menu?: { id?: string; label?: string }[] } | undefined;
  assert.ok(Array.isArray(last?.menu) && last.menu.length > 0, 'overlay received menu rows');
  assert.ok(
    last.menu.some((row) => row.id === ';rvw' || row.id === 'rvw' || String(row.label).includes(';rvw')),
    'picker lists ;rvw',
  );
  await session.dispose();
  await executor.dispose();
});
