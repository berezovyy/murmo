// Uninstall refusals: live session and changed config (E8).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.ts';
import { capture, makeHome, tree } from './helpers.ts';

test('uninstall with a live session PID exits non-zero and changes nothing (E8)', async () => {
  const t = makeHome('murmo-uninstall-live-');
  try {
    const io = capture();
    assert.equal(
      await main(['setup', '--json', '--key', t.keyPem, '--package', t.packageDir], {
        env: t.env,
        out: io.writeOut,
        err: io.writeErr,
      }),
      0,
    );
    const sessions = join(t.env.XDG_DATA_HOME as string, 'murmo', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      `${sessions}/pi.json`,
      `${JSON.stringify({ pid: process.pid, host: { name: 'pi' }, healthy: true })}\n`,
    );
    const before = tree(t.home);
    const err = capture();
    const code = await main(['uninstall', '--json'], { env: t.env, out: err.writeOut, err: err.writeErr });
    assert.notEqual(code, 0);
    assert.match(err.err.join(''), /close active pi/);
    assert.deepEqual(tree(t.home), before);
  } finally {
    t.remove();
  }
});

test('uninstall keeps a config file the user changed after setup (E8)', async () => {
  const t = makeHome('murmo-uninstall-edit-');
  try {
    const io = capture();
    assert.equal(
      await main(['setup', '--json', '--key', t.keyPem, '--package', t.packageDir], {
        env: t.env,
        out: io.writeOut,
        err: io.writeErr,
      }),
      0,
    );
    const installed = join(t.env.CLAUDE_CONFIG_DIR as string, 'plugins', 'installed_plugins.json');
    const edited = `${JSON.stringify({ installed: true, userEdit: true })}\n`;
    writeFileSync(installed, edited);
    const err = capture();
    const code = await main(['uninstall', '--json'], { env: t.env, out: err.writeOut, err: err.writeErr });
    assert.notEqual(code, 0);
    assert.match(err.err.join(''), /config changed/);
    assert.equal(readFileSync(installed, 'utf8'), edited);
  } finally {
    t.remove();
  }
});
