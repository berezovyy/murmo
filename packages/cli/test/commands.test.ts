// Mounted commands from 11/14/15/19 actually dispatch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { capture, makeHome } from './helpers.ts';

test('words list, data show, private status, trust --list run against a throwaway store', async () => {
  const t = makeHome('murmo-commands-');
  try {
    const io = capture();
    assert.equal(await main(['words', 'list'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(await main(['data', 'show'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(
      await main(['private', 'status', '--json'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }),
      0,
    );
    assert.equal(await main(['trust', '--list'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(await main(['init', '--user'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
    assert.equal(await main(['names', 'status'], { env: t.env, cwd: t.home, out: io.writeOut, err: io.writeErr }), 0);
  } finally {
    t.remove();
  }
});
