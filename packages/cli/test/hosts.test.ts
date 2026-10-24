// Codex setup must not write 12 command hooks: that is the packed TUI
// "Hooks need review" wall. Events stay off; murmo hook fail-opens.
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { homeLayout } from '../src/home.ts';
import { registerHost } from '../src/hosts.ts';
import { makeHome } from './helpers.ts';

test('Codex registration does not write hooks.json (packed TUI review wall)', () => {
  const t = makeHome('murmo-codex-hooks-');
  try {
    mkdirSync(t.env.CODEX_HOME as string, { recursive: true });
    const layout = homeLayout(t.env);
    const results = registerHost(
      { name: 'codex', installed: true, executable: join(t.bin, 'codex') },
      t.packageDir,
      layout,
      t.env,
    );
    assert.equal(existsSync(join(layout.dirs.codex, 'hooks.json')), false);
    assert.equal(
      results.some((r) => r.argv.includes('codex-hooks.json')),
      false,
    );
    assert.equal(
      results.some((r) => r.argv.includes('murmo') && r.argv.includes('codex')),
      true,
    );
  } finally {
    t.remove();
  }
});

test('codexChildEnv sets english.bin and autocorrect from the user file', async () => {
  const t = makeHome('murmo-codex-env-');
  try {
    mkdirSync(join(t.env.XDG_CONFIG_HOME as string, 'murmo'), { recursive: true });
    writeFileSync(join(t.env.XDG_CONFIG_HOME as string, 'murmo', 'murmo.toml'), '[autocorrect]\nenabled = true\n');
    const { codexChildEnv } = await import('../src/cli.ts');
    const child = await codexChildEnv(t.env, t.packageDir);
    assert.equal(child.MURMO_AUTOCORRECT, '1');
    assert.equal(child.MURMO_ENGLISH_TABLE?.endsWith('english.bin'), true);
    assert.equal(existsSync(child.MURMO_ENGLISH_TABLE as string), true);
  } finally {
    t.remove();
  }
});

test("OpenCode registration links the plugin into OpenCode's plugins folder and leaves cli.json alone", () => {
  // OpenCode ignores all of cli.json when one key has the wrong shape (a
  // `"theme": "opencode"` string), so Murmo registered there was silently
  // off; rewriting the file also dropped JSONC comments and key order.
  const t = makeHome('murmo-opencode-link-');
  try {
    const layout = homeLayout(t.env);
    const cli = join(layout.dirs.opencode, 'cli.json');
    const user = '{\n  // mine\n  "theme": "opencode",\n  "keybinds": {}\n}\n';
    writeFileSync(cli, user);
    const opencode = { name: 'opencode', installed: true, executable: join(t.bin, 'opencode') } as const;
    const results = registerHost(opencode, t.packageDir, layout, t.env);
    const link = join(layout.dirs.opencode, 'plugins', 'murmo');
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(realpathSync(link), realpathSync(t.packageDir));
    assert.equal(readFileSync(cli, 'utf8'), user);
    assert.deepEqual(results[0]?.argv, ['opencode-plugin-link', link]);

    // A second setup (or one after the payload moved) points the same link at the payload.
    const moved = join(t.root, 'moved-package');
    mkdirSync(moved);
    registerHost(opencode, moved, layout, t.env);
    assert.equal(realpathSync(link), realpathSync(moved));
  } finally {
    t.remove();
  }
});

test('OpenCode registration refuses to replace a user folder named murmo in the plugins folder', () => {
  const t = makeHome('murmo-opencode-taken-');
  try {
    const layout = homeLayout(t.env);
    const taken = join(layout.dirs.opencode, 'plugins', 'murmo');
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'index.js'), 'export default {}\n');
    const opencode = { name: 'opencode', installed: true, executable: join(t.bin, 'opencode') } as const;
    assert.throws(() => registerHost(opencode, t.packageDir, layout, t.env), /not Murmo's link/);
    assert.equal(readFileSync(join(taken, 'index.js'), 'utf8'), 'export default {}\n');
  } finally {
    t.remove();
  }
});
