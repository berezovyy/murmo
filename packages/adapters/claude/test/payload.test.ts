// Payload handshake: refuse a version mismatch; no Node verify call (E21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locatePayload } from '../src/payload.ts';
import { PLUGIN_VERSION } from '../src/types.ts';
import { FakeClaude, packedTable } from './fake-runtime.ts';

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

test('payload next to the plugin is found when XDG data is empty (Claude $.fs tree)', async () => {
  const table = packedTable();
  const fake = new FakeClaude({
    pluginRoot: '/tree/adapters/claude',
    env: { XDG_DATA_HOME: '/empty' },
    files: {
      '/tree/integrity.json': JSON.stringify({
        version: PLUGIN_VERSION,
        files: [{ path: 'data/en/english.bin', sha256: 'test', size: table.byteLength }],
      }),
      '/tree/data/en/english.bin': table,
    },
  });
  const located = await locatePayload(fake.$);
  assert.equal(located?.root, '/tree');
  assert.equal(located?.notice, undefined);
});
