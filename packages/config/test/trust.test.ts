// Trust (phase 14 E4, lesson 27): project shortcuts load only for an approved
// fingerprint of the exact snapshot that loads, every r8 change turns them off
// until re-approved, and the 7 hostile reference cases never become active.
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { openStore, type Store } from '@murmo/store/node';
import { REFERENCE_PROBLEMS, type ReferenceProblem } from '../src/index.ts';
import { approveProject, loadSessionConfig, scanProject } from '../src/node/index.ts';
import { hostileConfig, trustCases, type Workspace, workspace } from './repos.ts';

let ws: Workspace;
let store: Store;

before(async () => {
  ws = workspace('murmo-trust-');
  store = await openStore({ roots: ws.roots });
});
after(() => ws.remove());

const load = (cwd: string) => loadSessionConfig({ cwd, store, env: ws.env });

async function approve(root: string): Promise<void> {
  const snapshot = await scanProject(root);
  assert.ok(snapshot?.fingerprint, 'snapshot is approvable');
  assert.equal((await approveProject(store, root, snapshot.fingerprint)).status, 'ok');
}

function projectShortcuts(session: Awaited<ReturnType<typeof load>>): Record<string, string> {
  return Object.fromEntries(
    session.effective.replacements.filter((s) => s.origin === 'project').map((s) => [s.shortcut, s.text]),
  );
}

test('an unapproved project file loads no shortcuts and says how to review it', async () => {
  // Catches a hostile clone expanding its shortcuts before the user looked.
  const root = ws.repo('fresh', trustCases.base);
  const session = await load(root);
  assert.equal(session.trust, 'review');
  assert.deepEqual(projectShortcuts(session), {});
  const notice = session.effective.diagnostics.find((d) => d.code === 'untrusted');
  assert.match(notice?.message ?? '', /^2 shortcuts stay off until you review this file: run "murmo trust"$/);
  await approve(root);
  const approved = await load(root);
  assert.equal(approved.trust, 'approved');
  assert.deepEqual(projectShortcuts(approved), trustCases.expected);
});

test('the r8 fixture loads exactly the expected text once approved', async () => {
  // Catches a reference read that keeps two newlines, or a decoding drift.
  const root = ws.repo('fixture', trustCases.fixture);
  await approve(root);
  assert.deepEqual(projectShortcuts(await load(root)), trustCases.fixtureExpected);
});

for (const change of trustCases.changes.filter((c) => c.name !== 'other-repo')) {
  test(`changing ${change.name} turns project shortcuts off until re-approved`, async () => {
    // Catches an approval that pins less than the bytes and layout that load.
    const root = ws.repo(`change-${change.name}`, trustCases.base);
    await approve(root);
    const before = await scanProject(root);
    ws.apply(root, change.ops);
    const changed = await load(root);
    assert.equal(changed.trust, 'changed');
    assert.deepEqual(projectShortcuts(changed), {});
    // A review of the old snapshot cannot approve the new one.
    assert.deepEqual(await approveProject(store, root, before?.fingerprint ?? ''), { status: 'changed' });
    assert.equal((await load(root)).trust, 'changed');
    await approve(root);
    assert.equal((await load(root)).trust, 'approved');
  });
}

test('the same bytes in another repository need their own approval', async () => {
  // Catches an approval keyed on content alone: a second clone would inherit it.
  const a = ws.repo('repo-a', trustCases.base);
  const b = ws.repo('repo-b', trustCases.base);
  await approve(a);
  const [sa, sb] = [await scanProject(a), await scanProject(b)];
  assert.equal(sa?.fingerprint, sb?.fingerprint, 'identical bytes give an identical fingerprint');
  assert.notEqual(sa?.identity.projectId, sb?.identity.projectId);
  assert.equal((await load(b)).trust, 'review');
  // Even an approval record copied over to b's ID fails on device and inode.
  const record = await store.trust.find(sa?.identity.projectId ?? '');
  assert.ok(record && sb);
  await store.trust.approve({ ...record, projectId: sb.identity.projectId });
  assert.equal((await load(b)).trust, 'changed');
});

test('the 7 hostile references are refused and never become active', async () => {
  // Catches a reference that reads outside the repository, hangs on a FIFO,
  // reads a huge file, or loads mojibake (r8 § 54).
  const opened: string[] = [];
  const realOpen = fsp.open;
  fsp.open = ((path: Parameters<typeof realOpen>[0], ...rest: unknown[]) => {
    opened.push(String(path));
    return (realOpen as (...args: unknown[]) => ReturnType<typeof realOpen>)(path, ...rest);
  }) as typeof realOpen;
  try {
    for (const c of trustCases.hostile) {
      const root = ws.repo(`hostile-${c.name}`, trustCases.base, c.ops, [hostileConfig(c.reference)]);
      opened.length = 0;
      const session = await load(root);
      assert.equal(session.trust, 'not-approvable', c.name);
      assert.deepEqual(projectShortcuts(session), {}, c.name);
      const target = join(await fsp.realpath(root), 'prompt.txt');
      const touched = opened.filter(
        (p) => p === target || p === ws.outside || p.startsWith('/etc') || p.includes('C:'),
      );
      // Only invalid UTF-8 must be read to be found; everything else is refused before open().
      const expected = c.opened.map((p) => (p === 'prompt.txt' ? target : p));
      assert.deepEqual(touched, expected, `${c.name} opened ${touched.join(', ')}`);
      const message = REFERENCE_PROBLEMS[c.problem as ReferenceProblem];
      assert.ok(
        session.effective.diagnostics.some((d) => d.code === 'invalid-reference' && d.message.includes(message)),
        `${c.name}: expected "${message}"`,
      );
      assert.deepEqual(await approveProject(store, root, 'f'.repeat(64)), { status: 'changed' }, c.name);
    }
  } finally {
    fsp.open = realOpen;
  }
});

test('one load reads at most 128 files and 1 MiB', async () => {
  // Catches a config that makes every session read the whole repository (r12 K2).
  const refs = Array.from({ length: 70 }, (_, i) => `x${i} = { file = "r/${i}.md" }`).join('\n');
  const files = Array.from({ length: 70 }, (_, i) => ({
    op: 'write' as const,
    path: `r/${i}.md`,
    repeat: { char: 'a', count: 16_000 },
  }));
  const root = ws.repo('budget', [{ op: 'write', path: '.murmo.toml', text: `[replace]\n${refs}\n` }], files);
  const snapshot = await scanProject(root);
  const budget = snapshot?.config.diagnostics.filter((d) => d.message.includes(REFERENCE_PROBLEMS.budget)) ?? [];
  // 1 MiB minus the config holds 65 files of 16,000 bytes.
  assert.equal(snapshot?.config.replacements.length, 65);
  assert.equal(budget.length, 5);
  assert.equal(snapshot?.fingerprint, undefined, 'a partial snapshot cannot be approved');
});
