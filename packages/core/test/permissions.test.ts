// Typed-only projection and grant evaluation (S6, PERMISSION_DEFAULTS).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import { grantedPermissions, isGranted } from '../src/index.ts';
import { projectDraft } from '../src/plugins/projection.ts';
import { createHarness, type DirectPluginSpec } from '../src/testing/index.ts';

const pasted = {
  text: 'sk_FAKE_PASTED_SECRETtyped',
  cursor: 26,
  version: 1,
  certainty: 'authoritative' as const,
  typedSpans: [[21, 26] as const],
};

test('draft:read masks pasted text and keeps a typed secret; full read does not (S6, E3)', () => {
  const masked = projectDraft(pasted, ['draft:read'], 'host-labeled');
  assert.equal(masked.text.slice(0, 21), '█'.repeat(21));
  assert.equal(masked.text.slice(21), 'typed');
  const full = projectDraft(pasted, ['draft:read:full'], 'host-labeled');
  assert.equal(full.text, pasted.text);
  const none = projectDraft(pasted, [], 'host-labeled');
  assert.equal(none.text, '');
});

test('without host-labeled evidence every unit is masked (E15, Claude)', () => {
  const view = projectDraft(pasted, ['draft:read'], 'unknown');
  assert.equal(view.text, '█'.repeat(pasted.text.length));
  assert.deepEqual(view.typedSpans, []);
});

test('no permission is granted unless declared; draft:read:full needs builtin or an explicit map (PERMISSION_DEFAULTS)', () => {
  const third = { id: 'x', builtin: false, declared: ['draft:read', 'draft:read:full', 'network'] as const };
  assert.equal(isGranted(third, 'draft:read'), true);
  assert.equal(isGranted(third, 'draft:read:full'), false);
  assert.equal(isGranted(third, 'network'), false);
  assert.deepEqual(grantedPermissions(third, { x: ['draft:read:full'] }), ['draft:read', 'draft:read:full']);
  const builtin = { id: 'g', builtin: true, declared: ['draft:read:full'] as const };
  assert.equal(isGranted(builtin, 'draft:read:full'), true);
});

test('a session with draft:read stores typed text and never the pasted secret (S6)', async () => {
  const reader: DirectPluginSpec = {
    id: 'reader',
    builtin: false,
    factory: () => ({
      name: 'reader',
      version: '1',
      permissions: ['draft:read'],
      onChange(change, ctx) {
        return ctx.storage.set('seen', { text: change.draft.text, ctx: ctx.draft.text }).then(() => []);
      },
    }),
  };
  const h = await createHarness({ plugins: [reader] });
  await h.driver.fill('sk_FAKE_PASTED_SECRET', 'paste');
  await h.driver.settle();
  const stored = h.runner.storage().reader ?? '';
  assert.ok(!stored.includes('sk_FAKE_PASTED_SECRET'), stored);
  await h.driver.type('typed');
  const later = h.runner.storage().reader ?? '';
  assert.ok(later.includes('typed'), later);
  await h.session?.dispose();
});

test('draft:read:full with an explicit grant sees the paste (S6)', async () => {
  const full: PluginFactory = () => ({
    name: 'full',
    version: '1',
    permissions: ['draft:read:full'],
    onChange(change, ctx) {
      return ctx.storage.set('text', change.draft.text).then(() => []);
    },
  });
  const h = await createHarness({
    plugins: [{ id: 'full', builtin: false, factory: full }],
    grants: { full: ['draft:read:full'] },
  });
  await h.driver.fill('secret', 'paste');
  await h.driver.settle();
  assert.ok((h.runner.storage().full ?? '').includes('secret'));
  await h.session?.dispose();
});
