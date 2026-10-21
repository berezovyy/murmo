import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routesFor } from '../src/adapter.ts';
import { isCanonicalKey } from '../src/index.ts';

test('one physical key has one canonical ID, so two adapters cannot route the same key under different names', () => {
  for (const id of ['a', ';', 'é', 'space', 'Tab', 'F12', 'Ctrl+x', 'Alt+Enter', 'Shift+Tab', 'Ctrl+Alt+Down']) {
    assert.ok(isCanonicalKey(id), id);
  }
  // A literal space, a capital under Ctrl, Shift on a printable, wrong modifier
  // order, words and controls would each be a second name for an existing key.
  for (const id of [' ', 'Ctrl+X', 'Shift+a', 'Alt+Ctrl+x', 'tab', 'ab', '\u0007', 'Ctrl+', '']) {
    assert.ok(!isCanonicalKey(id), JSON.stringify(id));
  }
});

test('network opens no hook or service: it is declaration-only until phase 32 adds a broker', () => {
  assert.deepEqual(routesFor(['network']).services, ['clock', 'storage']);
  assert.deepEqual(
    routesFor(['network']).hooks,
    routesFor([]).hooks,
    'network must not open any hook beyond the ungated ones',
  );
});

test('draft:read:full opens everything draft:read does, so a full-read plugin never loses onChange', () => {
  const typed = routesFor(['draft:read']);
  const full = routesFor(['draft:read:full']);
  for (const hook of typed.hooks) assert.ok(full.hooks.includes(hook), hook);
  for (const effect of typed.effects) assert.ok(full.effects.includes(effect), effect);
});

test('committed events need submit:observe, never submit: observing a send grants no authority over it (K7/E1)', () => {
  assert.ok(!routesFor(['submit', 'draft:read']).hooks.includes('onSubmitCommitted'));
  assert.ok(routesFor(['submit:observe', 'draft:read']).hooks.includes('onSubmitCommitted'));
  assert.ok(!routesFor(['submit:observe', 'draft:read']).hooks.includes('onBeforeSubmit'));
});
