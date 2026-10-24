// The helper's `config.load` reply as a host without a file system reads it
// (phase 14, Claude): every session the Node loader makes survives the JSON
// round trip unchanged, and a reply of any other shape is no config at all.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { openStore, type Store } from '@murmo/store/node';
import { sessionFromJson } from '../src/index.ts';
import { approveProject, loadedSession, loadSessionConfig, scanProject } from '../src/node/index.ts';
import { trustCases, type Workspace, workspace } from './repos.ts';

let ws: Workspace;
let store: Store;

before(async () => {
  ws = workspace('murmo-session-json-');
  store = await openStore({ roots: ws.roots });
});
after(() => ws.remove());

async function approve(root: string): Promise<void> {
  const snapshot = await scanProject(root);
  assert.equal((await approveProject(store, root, snapshot?.fingerprint ?? '')).status, 'ok');
}

test('every Node session survives the reply round trip', async () => {
  // Catches a decoder that drops or refuses a field the loader makes (an
  // override notice, template fields, a referenced file), so Claude would load
  // different shortcuts than Pi from the same files.
  const fresh = ws.repo('fresh', trustCases.base);
  const fixture = ws.repo('fixture', trustCases.fixture);
  await approve(fixture);
  for (const root of [fresh, fixture, ws.repo('bare')]) {
    const session = await loadSessionConfig({ cwd: root, store, env: ws.env });
    const wire = JSON.parse(JSON.stringify({ trust: session.trust, effective: session.effective }));
    assert.deepEqual(sessionFromJson(wire), wire, root);
  }
  const approved = sessionFromJson(
    JSON.parse(JSON.stringify(await loadSessionConfig({ cwd: fixture, store, env: ws.env }))),
  );
  assert.equal(approved?.trust, 'approved');
  assert.deepEqual(
    Object.fromEntries(approved?.effective.replacements.map((s) => [s.shortcut, s.text]) ?? []),
    trustCases.fixtureExpected,
  );
});

test('a reply of another shape is no config', async () => {
  // Catches a broken or mismatched helper turning into a config: a session
  // that acts on half a reply could expand the wrong text.
  const session = await loadSessionConfig({ cwd: ws.repo('shape', trustCases.base), store, env: ws.env });
  const good = JSON.parse(JSON.stringify({ trust: session.trust, effective: session.effective }));
  const broken = [
    undefined,
    { ...good, trust: 'trusted' },
    { trust: good.trust },
    { ...good, effective: { ...good.effective, autocorrect: 'yes' } },
    { ...good, effective: { ...good.effective, replacements: [{ shortcut: ';x', text: 1, origin: 'user' }] } },
    { ...good, effective: { ...good.effective, replacements: [{ shortcut: ';x', text: 'x', origin: 'peer' }] } },
    { ...good, effective: { ...good.effective, diagnostics: [{ code: 'untrusted' }] } },
    { ...good, effective: { ...good.effective, plugins: { rescue: { enabled: true } } } },
  ];
  for (const reply of broken) assert.equal(sessionFromJson(reply), undefined, JSON.stringify(reply));
  assert.ok(sessionFromJson(good));
});

test('a full reply gives Claude the project summary Node hosts read from the load', async () => {
  // Catches Claude's session and Pi's or OpenCode's disagreeing about the
  // project file: its shortcut count in the trust notice, or the file that
  // turned autocorrect off.
  const fresh = ws.repo('summary', trustCases.base);
  for (const root of [fresh, ws.repo('summary-bare')]) {
    const session = await loadSessionConfig({ cwd: root, store, env: ws.env });
    const { stamps: _stamps, ...reply } = session;
    assert.deepEqual(sessionFromJson(JSON.parse(JSON.stringify(reply))), loadedSession(session), root);
  }
  const summary = loadedSession(await loadSessionConfig({ cwd: fresh, store, env: ws.env })).project;
  assert.equal(summary?.shortcuts, (await scanProject(fresh))?.config.replacements.length);
});
