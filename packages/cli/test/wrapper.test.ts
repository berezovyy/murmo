// npm-cache wrapper: temp --cache, trap cleanup, SHA-512 check (E3).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeHome, tree } from './helpers.ts';

const installSh = fileURLToPath(new URL('../install.sh', import.meta.url));

function packTgz(packageDir: string, dest: string): string {
  const cache = mkdtempSync(join(tmpdir(), 'murmo-npm-pack-'));
  try {
    const json = execFileSync(
      'npm',
      ['pack', packageDir, '--pack-destination', dest, '--json', '--cache', cache, '--ignore-scripts'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(json) as { filename?: string }[] | { filename?: string };
    const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed.filename;
    return join(dest, filename ?? 'murmo-0.0.0.tgz');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

test('install.sh uses a temp --cache and deletes it; SHA-512 mismatch refuses (E3)', () => {
  const script = readFileSync(installSh, 'utf8');
  assert.match(script, /npm exec --offline --yes --cache/);
  assert.match(script, /trap 'rm -rf "\$cache"' EXIT HUP INT TERM/);
  assert.match(script, /bare npx/);
  assert.match(script, /EXPECTED_SHA512/);

  const t = makeHome('murmo-wrapper-');
  try {
    const dest = join(t.root, 'dist');
    mkdirSync(dest);
    copyFileSync(installSh, join(dest, 'install.sh'));
    chmodSync(join(dest, 'install.sh'), 0o755);
    const tgz = packTgz(t.packageDir, dest);
    const emptyHome = tree(t.home);
    const bad = spawnSync('sh', [join(dest, 'install.sh'), '--version'], {
      env: { ...t.env, MURMO_TGZ_SHA512: 'deadbeef' },
      encoding: 'utf8',
    });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /SHA-512 mismatch/);
    assert.deepEqual(tree(t.home), emptyHome);
    assert.equal(tgz.endsWith('.tgz'), true);
  } finally {
    t.remove();
  }
});

test('wrapper leaves ~/.npm unchanged for empty, seeded, and caller npm_config_cache (E3)', () => {
  const t = makeHome('murmo-wrapper-npm-');
  try {
    const dest = join(t.root, 'dist');
    mkdirSync(dest);
    copyFileSync(installSh, join(dest, 'install.sh'));
    chmodSync(join(dest, 'install.sh'), 0o755);
    packTgz(t.packageDir, dest);

    const cases: { name: string; seed: boolean; override: boolean }[] = [
      { name: 'empty', seed: false, override: false },
      { name: 'seeded', seed: true, override: false },
      { name: 'override', seed: true, override: true },
    ];
    for (const c of cases) {
      const profile = mkdtempSync(join(t.root, `case-${c.name}-`));
      const home = join(profile, 'home');
      mkdirSync(home);
      const npmDir = join(home, '.npm');
      if (c.seed) {
        mkdirSync(npmDir);
        writeFileSync(join(npmDir, 'sentinel'), 'existing npm cache\0');
        chmodSync(join(npmDir, 'sentinel'), 0o640);
      }
      const env = {
        ...t.env,
        HOME: home,
        npm_config_cache: c.override ? npmDir : join(profile, 'caller-cache'),
        TMPDIR: join(profile, 'tmp'),
      };
      mkdirSync(env.TMPDIR, { recursive: true });
      const before = tree(home);
      const run = spawnSync('sh', [join(dest, 'install.sh'), '--version'], { env, encoding: 'utf8' });
      assert.equal(run.status, 0, `${c.name}: ${run.stderr}`);
      assert.deepEqual(tree(home), before, c.name);
      const leftovers = readdirSync(env.TMPDIR).filter((n) => n.includes('murmo-npm.'));
      assert.deepEqual(leftovers, [], c.name);
    }
  } finally {
    t.remove();
  }
});
