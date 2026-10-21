// murmo trust: full print, per-shortcut hash diff, approve-only-reviewed-fingerprint.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openStore } from '@murmo/store/node';
import { INIT_TEMPLATE } from '../src/index.ts';
import { TRUST_USAGE, trustCommand } from '../src/node/index.ts';
import { gitRepo, storeRoots, tempDir } from './helpers.ts';

const cleanup: Array<{ remove: () => void }> = [];
after(() => {
  for (const t of cleanup) t.remove();
});

async function setup(toml: string) {
  const t = tempDir('murmo-trust-');
  cleanup.push(t);
  const root = gitRepo(join(t.dir, 'repo'), { '.murmo.toml': toml });
  const store = await openStore({ roots: storeRoots(t.dir) });
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    store,
    cwd: root,
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    now: () => 1,
  };
  return { root, store, out, err, ctx };
}

const starter = INIT_TEMPLATE;

test('trust prints every shortcut in full and refuses a fingerprint that changed during review', async () => {
  // Catches truncated print (a 4 KiB expansion hidden) and the r8 approve race (E9).
  const { root, ctx, out, err } = await setup(`version = 1\n[replace]\n";rvw" = 'Review it.'\n";tst" = 'Run tests.'\n`);
  let asked = 0;
  const code = await trustCommand([], {
    ...ctx,
    ask: async () => {
      asked++;
      writeFileSync(join(root, '.murmo.toml'), `version = 1\n[replace]\n";rvw" = 'CHANGED.'\n`);
      return 'y';
    },
  });
  assert.equal(asked, 1);
  assert.equal(code, 1);
  assert.match(err.join('\n'), /changed during review/);
  assert.match(out.join('\n'), /;rvw/);
  assert.match(out.join('\n'), /Review it\./);
  assert.match(out.join('\n'), /;tst/);
  assert.match(out.join('\n'), /Run tests\./);
});

test('--yes --fingerprint approves only that snapshot', async () => {
  const { ctx, store, root } = await setup(`version = 1\n[replace]\n";rvw" = 'Review it.'\n`);
  const first = await trustCommand(['--yes', '--fingerprint', '0'.repeat(64)], ctx);
  assert.equal(first, 1);
  const { scanProject } = await import('@murmo/config/node');
  const snapshot = await scanProject(root);
  assert.ok(snapshot?.fingerprint);
  const code = await trustCommand(['--yes', '--fingerprint', snapshot.fingerprint], ctx);
  assert.equal(code, 0);
  const approval = await store.trust.find(snapshot.identity.projectId);
  assert.equal(approval?.fingerprint, snapshot.fingerprint);
  assert.ok(approval?.hashes?.[';rvw']);
});

test('--list and --revoke round-trip', async () => {
  const { ctx, root } = await setup(starter);
  const { scanProject } = await import('@murmo/config/node');
  const snapshot = await scanProject(root);
  assert.ok(snapshot?.fingerprint);
  assert.equal(await trustCommand(['--yes', '--fingerprint', snapshot.fingerprint], ctx), 0);
  const listed: string[] = [];
  assert.equal(await trustCommand(['--list'], { ...ctx, out: (s) => listed.push(s) }), 0);
  assert.match(listed.join('\n'), /shortcut/);
  assert.equal(await trustCommand(['--revoke'], ctx), 0);
  const empty: string[] = [];
  assert.equal(await trustCommand(['--list'], { ...ctx, out: (s) => empty.push(s) }), 0);
  assert.match(empty.join('\n'), /No approved/);
});

test('--yes without --fingerprint is usage', async () => {
  const { ctx, err } = await setup(starter);
  assert.equal(await trustCommand(['--yes'], ctx), 2);
  assert.match(err.join('\n'), /together/);
  assert.ok(err.join('\n').includes(TRUST_USAGE.split('\n')[0] as string));
});

test('a named diff reports the changed shortcut without storing expansion text', async () => {
  const { ctx, root, store } = await setup(`version = 1\n[replace]\n";rvw" = 'Review it.'\n`);
  const { scanProject } = await import('@murmo/config/node');
  const first = await scanProject(root);
  assert.ok(first?.fingerprint);
  assert.equal(await trustCommand(['--yes', '--fingerprint', first.fingerprint], ctx), 0);
  writeFileSync(join(root, '.murmo.toml'), `version = 1\n[replace]\n";rvw" = 'Review it now.'\n";new" = 'New one.'\n`);
  const printed: string[] = [];
  await trustCommand([], { ...ctx, out: (s) => printed.push(s), ask: async () => 'n' });
  const text = printed.join('\n');
  assert.match(text, /changed: ;rvw/);
  assert.match(text, /added: ;new/);
  const record = JSON.stringify(await store.trust.read());
  assert.equal(record.includes('Review it now.'), false);
});
