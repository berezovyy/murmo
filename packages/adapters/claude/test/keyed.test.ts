// Only keyed single-character deltas are typed. A draft:read plugin must see
// typed text and a pasted secret as masked (E3, lesson 80).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MASKED_UNIT } from '@murmo/api';
import { projectTyped } from '@murmo/provenance';
import { boot, pasteText, type } from './boot.ts';

test('typed letters are host-labeled so a draft:read view is unmasked', async () => {
  const { fake, host } = await boot();
  await type(host, fake, 'ab');
  assert.deepEqual(host.adapter.getDraft().typedSpans, [[0, 2]]);
  // What plugins see is the core's draft: each key's change must add up from
  // the draft before it, or the core resyncs it as untyped and masks it all.
  const draft = host.session?.draft();
  assert.deepEqual(draft?.typedSpans, [[0, 2]]);
  assert.equal(draft && projectTyped(draft, 'host-labeled').text, 'ab');
  await host.dispose();
});

test('pasted sk_FAKE_PASTED_SECRET is masked for draft:read (E3)', async () => {
  const { fake, host } = await boot();
  await pasteText(host, fake, 'sk_FAKE_PASTED_SECRET');
  const draft = host.adapter.getDraft();
  assert.deepEqual(draft.typedSpans, []);
  const seen = projectTyped(draft, 'host-labeled').text;
  assert.equal(seen.includes('sk_'), false);
  assert.ok(seen.includes(MASKED_UNIT));
  assert.equal(fake.draft.text, 'sk_FAKE_PASTED_SECRET');
  await host.dispose();
});

test('keyless bursts add no typed coverage so they abstain (E3)', async () => {
  const { fake, host } = await boot();
  await pasteText(host, fake, 'teh ');
  assert.deepEqual(host.adapter.getDraft().typedSpans, []);
  await host.dispose();
});
