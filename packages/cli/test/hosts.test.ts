// Codex setup must not write 12 command hooks: that is the packed TUI
// "Hooks need review" wall. Events stay off; murmo hook fail-opens.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
