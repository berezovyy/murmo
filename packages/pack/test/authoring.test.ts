// The packed product is a folder with no node_modules: everything `murmo plugin
// new|test|dev` needs must be inside the tarball. These run the real CLI bundle
// from an `npm install`ed tarball, the way a user gets it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pack } from '../src/index.ts';

const root = mkdtempSync(join(tmpdir(), 'murmo-pack-authoring-'));
let installed = '';
after(() => rmSync(root, { recursive: true, force: true }));

before(() => {
  const key = join(root, 'signing.pem');
  const pair = generateKeyPairSync('ed25519');
  writeFileSync(key, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const result = pack({
    outDir: join(root, 'release'),
    signingKey: key,
    skipBinaries: true,
    skipScan: true,
  });
  assert.ok(result.tarball);
  const prefix = join(root, 'prefix');
  mkdirSync(prefix);
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--offline',
      '--prefix',
      prefix,
      '--cache',
      join(root, 'npm-cache'),
      result.tarball,
    ],
    { stdio: 'pipe' },
  );
  installed = realpathSync(join(prefix, 'node_modules', 'murmo'));
});

function murmo(args: readonly string[], cwd: string) {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [join(installed, 'cli.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CONFIG_HOME: join(home, 'config'),
    },
  });
}

test('murmo plugin new scaffolds from the installed tarball, types included', () => {
  // The shipped CLI marked @murmo/devkit external and the tarball has no
  // node_modules, so every `plugin new|test|dev` died with "Cannot find
  // package '@murmo/devkit'".
  const work = join(root, 'work-new');
  mkdirSync(work);
  const run = murmo(['plugin', 'new', 'hello'], work);
  assert.equal(run.status, 0, run.stderr);
  for (const file of ['murmo.plugin.json', 'plugin.mjs', 'plugin.test.mjs', 'README.md', 'murmo-api/index.d.ts']) {
    assert.ok(existsSync(join(work, 'hello', file)), `${file} missing`);
  }
  assert.match(run.stdout, /AUTHORING\.md/);
  const guide = run.stdout.match(/(\S+AUTHORING\.md)/)?.[1] as string;
  assert.ok(guide.startsWith(installed), guide);
  assert.match(readFileSync(guide, 'utf8'), /^# Writing a Murmo plugin/);
});

test('murmo plugin test runs the scaffold from the installed tarball', () => {
  // The author conformance sweep read fixtures/ from the repo at run time;
  // the tarball has none.
  const work = join(root, 'work-test');
  mkdirSync(work);
  assert.equal(murmo(['plugin', 'new', 'hello'], work).status, 0);
  const run = murmo(['plugin', 'test', 'hello'], work);
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout) as {
    executors: string[];
    skipped: { executor: string; reason: string }[];
    authorTests: number;
    contract: { cases: { passed: number; failed: number } };
  };
  assert.deepEqual(report.executors, ['in-process']);
  assert.equal(report.authorTests, 1);
  assert.ok(report.contract.cases.passed > 0);
  assert.equal(report.contract.cases.failed, 0);
  assert.deepEqual(report.skipped.map((s) => s.executor).sort(), ['helper', 'quickjs']);
});
