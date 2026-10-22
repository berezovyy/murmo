// Network broker denials from network-tests.mjs (C3, E6).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyAddress, createMemoryNetwork, originAllowed } from '../src/index.ts';

test('another origin, rebinding, and origin spoofs are denied (E6)', async () => {
  const net = createMemoryNetwork({
    origins: ['http://allowed.test:80'],
    resolve: () => ['127.0.0.1'],
  });
  assert.equal((await net.request({ url: 'http://other.test/' })).status, 'denied');
  assert.equal((await net.request({ url: 'http://allowed.test/private' })).status, 'denied');
  for (const url of [
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://allowed.test.evil.invalid/',
    'http://allowed.test@other.test/',
  ]) {
    assert.equal((await net.request({ url })).status, 'denied', url);
  }
});

test('one pinned resolution per request (E6)', async () => {
  let n = 0;
  const net = createMemoryNetwork({
    origins: ['http://allowed.test:80'],
    allowLoopback: true,
    resolve: () => {
      n++;
      return ['127.0.0.1'];
    },
  });
  await net.request({ url: 'http://allowed.test/pinned' });
  assert.equal(n, 1);
});

test('classifyAddress names loopback, private and link-local (E6)', () => {
  assert.equal(classifyAddress('127.0.0.1'), 'loopback');
  assert.equal(classifyAddress('10.0.0.1'), 'private');
  assert.equal(classifyAddress('169.254.1.1'), 'link-local');
  assert.equal(classifyAddress('8.8.8.8'), 'public');
  assert.ok(originAllowed('http://allowed.test/x', ['http://allowed.test']));
});
