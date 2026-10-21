// Payload handshake: refuse a version mismatch; no Node verify call (E21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locatePayload } from '../src/payload.ts';
import { PLUGIN_VERSION } from '../src/types.ts';
import { FakeClaude } from './fake-runtime.ts';

test('a matching integrity.json is accepted', async () => {
  const fake = new FakeClaude();
  const located = await locatePayload(fake.$);
  assert.ok(located);
  assert.equal(located.integrity.version, PLUGIN_VERSION);
  assert.equal(located.notice, undefined);
});

test('a different payload version is refused (handshake)', async () => {
  const fake = new FakeClaude({
    files: {
      '/data/murmo/package/integrity.json': JSON.stringify({ version: '9.9.9', files: {} }),
    },
  });
  const located = await locatePayload(fake.$);
  assert.ok(located?.notice?.includes('does not match'));
});
