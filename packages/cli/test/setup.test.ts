// Setup: verify before HOME write, exact uninstall, re-run, faults (E5, E7, E9).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { helperPath, npmPlatform } from '@murmo/integrity';
import { USER_TEMPLATE } from '@murmo/plugin-shortcuts';
import { main } from '../src/cli.ts';
import { capture, cliPath, makeHome, tree, writePayload } from './helpers.ts';

async function setup(t: ReturnType<typeof makeHome>): Promise<{ code: number; io: ReturnType<typeof capture> }> {
  const io = capture();
  const code = await main(['setup', '--json', '--key', t.keyPem, '--package', t.packageDir], {
    env: t.env,
    out: io.writeOut,
    err: io.writeErr,
  });
  return { code, io };
}

async function uninstall(t: ReturnType<typeof makeHome>): Promise<number> {
  const io = capture();
  return main(['uninstall', '--json'], { env: t.env, out: io.writeOut, err: io.writeErr });
}

test('setup then uninstall restores HOME including a 0600 sentinel and seeded config (E5)', async () => {
  const t = makeHome('murmo-setup-home-');
  try {
    const before = tree(t.home);
    assert.equal(before.sentinel?.mode, 0o600);
    const first = await setup(t);
    assert.equal(first.code, 0, first.io.err.join(''));
    assert.equal(existsSync(join(t.env.XDG_DATA_HOME as string, 'murmo', 'package')), true);
    assert.equal(existsSync(join(t.home, '.local', 'bin', 'murmo')), true);
    mkdirSync(join(t.env.XDG_CACHE_HOME as string, 'bun'), { recursive: true });
    writeFileSync(join(t.env.XDG_CACHE_HOME as string, 'bun', 'session'), 'opencode-bun');
    mkdirSync(t.env.CODEX_HOME as string, { recursive: true });
    writeFileSync(join(t.env.CODEX_HOME as string, 'screen-reader.json'), '{"on":true}');
    assert.equal(await uninstall(t), 0);
    assert.deepEqual(tree(t.home), before);
  } finally {
    t.remove();
  }
});

test('a missing or tampered helper is refused before HOME changes (r12 I4)', async () => {
  for (const kind of ['missing', 'hash'] as const) {
    const t = makeHome(`murmo-setup-${kind}-`);
    try {
      const helper = join(t.packageDir, helperPath(npmPlatform()));
      if (kind === 'missing') rmSync(helper);
      else writeFileSync(helper, `${readFileSync(helper)}TAMPER`);
      const before = tree(t.home);
      const result = await setup(t);
      assert.notEqual(result.code, 0, result.io.out.join(''));
      assert.deepEqual(tree(t.home), before);
    } finally {
      t.remove();
    }
  }
});

test('a second setup with no new hosts leaves an identical tree (E9)', async () => {
  const t = makeHome('murmo-setup-rerun-');
  try {
    assert.equal((await setup(t)).code, 0);
    const afterFirst = tree(t.home);
    const second = await setup(t);
    assert.equal(second.code, 0, second.io.err.join(''));
    assert.match(second.io.out.join(''), /unchanged/);
    assert.deepEqual(tree(t.home), afterFirst);
  } finally {
    t.remove();
  }
});

test('a host installed between runs is registered on re-run (E9)', async () => {
  const t = makeHome('murmo-setup-newhost-');
  try {
    writeFileSync(join(t.bin, 'claude'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(t.bin, 'claude'), 0o755);
    const first = await setup(t);
    assert.equal(first.code, 0, first.io.err.join(''));
    writeFileSync(
      join(t.bin, 'claude'),
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.304"; exit 0; fi
mkdir -p "$CLAUDE_CONFIG_DIR/plugins"
echo '{"installed":true}' > "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json"
exit 0
`,
    );
    chmodSync(join(t.bin, 'claude'), 0o755);
    const second = await setup(t);
    assert.equal(second.code, 0, `${second.io.err.join('')}\nOUT:${second.io.out.join('')}`);
    assert.match(second.io.out.join(''), /reconciled|claude/);
    assert.equal(existsSync(join(t.env.CLAUDE_CONFIG_DIR as string, 'plugins', 'installed_plugins.json')), true);
  } finally {
    t.remove();
  }
});

test('a newer package switches the payload generation (E9)', async () => {
  const t = makeHome('murmo-setup-upgrade-');
  try {
    assert.equal((await setup(t)).code, 0);
    const newer = join(t.root, 'package-v1');
    writePayload(newer, '0.0.1', t.privateKey);
    const io = capture();
    const code = await main(['setup', '--json', '--key', t.keyPem, '--package', newer], {
      env: { ...t.env, MURMO_PACKAGE_ROOT: newer },
      out: io.writeOut,
      err: io.writeErr,
    });
    assert.equal(code, 0, io.err.join(''));
    assert.match(io.out.join(''), /upgraded/);
    const journal = JSON.parse(readFileSync(join(t.env.XDG_DATA_HOME as string, 'murmo', 'install.json'), 'utf8')) as {
      package: { version: string };
      generations: string[];
    };
    assert.equal(journal.package.version, '0.0.1');
    assert.ok(journal.generations.length >= 1);
  } finally {
    t.remove();
  }
});

test('SIGKILL at copied is recovered by the next setup (E7)', async () => {
  const t = makeHome('murmo-setup-sigkill-');
  try {
    const child = spawn(process.execPath, [cliPath, 'setup', '--json', '--key', t.keyPem, '--package', t.packageDir], {
      env: { ...t.env, MURMO_TEST_PAUSE_PHASE: 'copied' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const journal = join(t.env.XDG_DATA_HOME as string, 'murmo', 'install.json');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(journal)) {
        try {
          if (JSON.parse(readFileSync(journal, 'utf8')).phase === 'copied') break;
        } catch {
          // partial write
        }
      }
      if (child.exitCode !== null) throw new Error('setup exited before copied');
      await new Promise((r) => setTimeout(r, 20));
    }
    child.kill('SIGKILL');
    await new Promise((r) => child.once('close', r));
    const recovered = await setup(t);
    assert.equal(recovered.code, 0, recovered.io.err.join(''));
    assert.equal(await uninstall(t), 0);
  } finally {
    t.remove();
  }
});

test('a concurrent setup while the lock is held exits lock busy (E7)', async () => {
  const t = makeHome('murmo-setup-busy-');
  try {
    const child = spawn(process.execPath, [cliPath, 'setup', '--json', '--key', t.keyPem, '--package', t.packageDir], {
      env: { ...t.env, MURMO_TEST_PAUSE_PHASE: 'journal' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const journal = join(t.env.XDG_DATA_HOME as string, 'murmo', 'install.json');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(journal)) break;
      if (child.exitCode !== null) throw new Error('setup exited before journal');
      await new Promise((r) => setTimeout(r, 20));
    }
    const second = await setup(t);
    assert.notEqual(second.code, 0);
    assert.match(second.io.err.join(''), /lock busy/);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('close', r));
  } finally {
    t.remove();
  }
});

test('a first setup writes the starter personal file and says what to try (first-run value)', async () => {
  // After setup a new user had no shortcuts and nothing said so: ;rvw stayed
  // literal until they found `murmo init --user` on their own.
  const t = makeHome('murmo-setup-starter-');
  try {
    const io = capture();
    const code = await main(['setup', '--key', t.keyPem, '--package', t.packageDir], {
      env: t.env,
      out: io.writeOut,
      err: io.writeErr,
    });
    assert.equal(code, 0, io.err.join(''));
    const path = join(t.env.XDG_CONFIG_HOME as string, 'murmo', 'murmo.toml');
    assert.equal(readFileSync(path, 'utf8'), USER_TEMPLATE);
    const out = io.out.join('');
    assert.match(out, /wrote starter shortcuts: .*murmo\.toml/);
    assert.match(out, /Try it: .*type ;rvw then a space/);
    assert.match(out, /\[autocorrect\] enabled = true/);
  } finally {
    t.remove();
  }
});

test('setup never overwrites a personal file, and uninstall keeps one the user edited', async () => {
  // Catches setup replacing a user's own murmo.toml, and uninstall deleting
  // a starter the user has since made their own.
  const mine = makeHome('murmo-setup-mine-');
  try {
    const path = join(mine.env.XDG_CONFIG_HOME as string, 'murmo', 'murmo.toml');
    mkdirSync(join(mine.env.XDG_CONFIG_HOME as string, 'murmo'), { recursive: true });
    writeFileSync(path, '[replace]\n";me" = \'mine\'\n');
    const io = capture();
    assert.equal(
      await main(['setup', '--key', mine.keyPem, '--package', mine.packageDir], {
        env: mine.env,
        out: io.writeOut,
        err: io.writeErr,
      }),
      0,
    );
    assert.equal(readFileSync(path, 'utf8'), '[replace]\n";me" = \'mine\'\n');
    assert.doesNotMatch(io.out.join(''), /wrote starter/);
    assert.match(io.out.join(''), /your shortcuts and settings: .*murmo\.toml/);
    assert.equal(await uninstall(mine), 0);
    assert.equal(readFileSync(path, 'utf8'), '[replace]\n";me" = \'mine\'\n');
  } finally {
    mine.remove();
  }
  const edited = makeHome('murmo-setup-edited-');
  try {
    assert.equal((await setup(edited)).code, 0);
    const path = join(edited.env.XDG_CONFIG_HOME as string, 'murmo', 'murmo.toml');
    writeFileSync(path, `${USER_TEMPLATE}\n[autocorrect]\nenabled = true\n`);
    assert.equal(await uninstall(edited), 0);
    assert.equal(readFileSync(path, 'utf8'), `${USER_TEMPLATE}\n[autocorrect]\nenabled = true\n`);
  } finally {
    edited.remove();
  }
});
