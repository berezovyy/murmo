// Doctor tells the truth: never only "healthy" (lessons 71, 76 / E10).
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { helperPath, npmPlatform } from '@murmo/integrity';
import { main } from '../src/cli.ts';
import { capture, makeHome } from './helpers.ts';

async function run(
  t: ReturnType<typeof makeHome>,
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const io = capture();
  const code = await main(argv, { env: t.env, out: io.writeOut, err: io.writeErr });
  return { code, out: io.out.join(''), err: io.err.join('') };
}

test('doctor passes on a clean install and fails for a tampered helper (E10)', async () => {
  const t = makeHome('murmo-doctor-clean-');
  try {
    assert.equal((await run(t, ['setup', '--json', '--key', t.keyPem, '--package', t.packageDir])).code, 0);
    const clean = await run(t, ['doctor', '--json', '--key', t.keyPem]);
    assert.equal(clean.code, 0, clean.out + clean.err);
    const helper = join(t.env.XDG_DATA_HOME as string, 'murmo', 'package', helperPath(npmPlatform()));
    writeFileSync(helper, `${readFileSync(helper)}X`);
    const bad = await run(t, ['doctor', '--json', '--key', t.keyPem]);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /payload-integrity/);
  } finally {
    t.remove();
  }
});

test('doctor fails for a disabled plugin in a healthy session and a killed helper (E10)', async () => {
  const t = makeHome('murmo-doctor-false-healthy-');
  try {
    assert.equal((await run(t, ['setup', '--json', '--key', t.keyPem, '--package', t.packageDir])).code, 0);
    const sessions = join(t.env.XDG_DATA_HOME as string, 'murmo', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      `${sessions}/pi.json`,
      `${JSON.stringify({
        pid: process.pid,
        host: { name: 'pi', version: '1.3.0' },
        healthy: true,
        helper: { pid: 999999, down: true, transport: 'real-rquickjs-process' },
        capabilities: {
          readDraft: true,
          inlineRewrite: 'same-transaction',
          inline: { rewrite: true, commitAcknowledged: true },
        },
        plugins: [{ id: 'stranger', enabled: false, fault: { kind: 'cpu', message: 'slice exceeded' } }],
        boundaries: [{ boundary: 'tmux-tab', evidence: '$TMUX', action: 'move Tab behind the prefix' }],
      })}\n`,
    );
    const report = await run(t, ['doctor', '--json', '--key', t.keyPem]);
    assert.equal(report.code, 1);
    assert.match(report.out, /plugin-disabled:stranger/);
    assert.match(report.out, /helper transport down/);
    assert.match(report.out, /healthy/);
    assert.doesNotMatch(report.out, /"ok": true, "detail": "healthy"/);
  } finally {
    t.remove();
  }
});

test('doctor reports a changed host version as restart-and-check-probes (E10)', async () => {
  const t = makeHome('murmo-doctor-drift-');
  try {
    assert.equal((await run(t, ['setup', '--json', '--key', t.keyPem, '--package', t.packageDir])).code, 0);
    writeFileSync(
      join(t.bin, 'pi'),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
exit 0
`,
    );
    chmodSync(join(t.bin, 'pi'), 0o755);
    const report = await run(t, ['doctor', '--json', '--key', t.keyPem]);
    assert.equal(report.code, 1);
    assert.match(report.out, /host-version:pi/);
    assert.match(report.out, /restart the session/);
  } finally {
    t.remove();
  }
});
