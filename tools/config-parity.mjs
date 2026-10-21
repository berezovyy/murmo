// Config parity (phase 14 "Parser parity", "JS and Rust load the same config
// fixtures"). Two legs, both against the Rust twin (packages/config/rust):
//
// - parse: every `config.parse` case in fixtures/config/ (the r8 TOML corpus,
//   the r12 hostile files, one snippet per schema branch) gives the same
//   accept/reject, the same TOML values and the same config result in
//   @murmo/config and in Rust. The four JavaScript runtimes are compared on
//   the same cases by packages/conformance (pnpm test:conformance).
// - session: whole sessions loaded from real repositories (fixtures/config/
//   trust.json) give the same trust state, fingerprint, project identity and
//   effective config in Node and Rust, before and after a JS approval, and
//   after every change case.
//
// The one allowed difference: a parse error's wording and column come from
// each parser (smol-toml, Rust `toml`), so those two fields are not compared.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { targetDir } from './cargo.mjs';
import { root } from './workspace.mjs';

/** Builds a Rust example once and returns its path. */
export function rustExample(pkg, example) {
  const run = spawnSync(
    process.execPath,
    [join(root, 'tools/cargo.mjs'), 'build', '--quiet', '--offline', '--locked', '-p', pkg, '--example', example],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  return join(targetDir(), 'debug', 'examples', example);
}

/** Every `config.parse` fixture case as `{name, source, origin, file, valid}`. */
async function loadCases() {
  const { configCases } = await import('../packages/config/test/fixtures.ts');
  const named = (file, prefix) => configCases(file).map((c) => ({ ...c, name: `${prefix}/${c.name}` }));
  return [
    ...named('toml-corpus.json', 'corpus'),
    ...named('hostile.json', 'hostile'),
    ...named('schema.json', 'schema'),
  ].map((c) => ({
    name: c.name,
    source: c.source,
    origin: c.origin ?? 'user',
    file: `${c.name}.toml`,
    valid: c.valid,
  }));
}

/** A diagnostic list with each parse diagnostic's parser-owned fields removed. */
function comparableDiagnostics(diagnostics) {
  return diagnostics.map((d) => {
    if (d.code !== 'parse') return d;
    const { column: _column, message: _message, excerpt: _excerpt, ...rest } = d;
    return rest;
  });
}

const comparable = (config) => ({ ...config, diagnostics: comparableDiagnostics(config.diagnostics) });

async function parseLeg(binary) {
  const { run } = await import('../packages/config/test/parity-cases.ts');
  const all = await loadCases();
  // Through JSON, as the Rust side arrives: non-finite floats become null.
  const js = JSON.parse(
    JSON.stringify(run({ cases: all.map(({ name, source, origin }) => ({ name, source, origin })) })),
  );
  const rustRun = spawnSync(binary, ['parse'], {
    input: JSON.stringify({ cases: all.map(({ name, source, origin, file }) => ({ name, source, origin, file })) }),
    encoding: 'utf8',
    maxBuffer: 256 << 20,
  });
  assert.equal(rustRun.status, 0, rustRun.stderr);
  const rust = JSON.parse(rustRun.stdout);
  assert.equal(rust.length, all.length);
  for (const [i, c] of all.entries()) {
    const [j, rs] = [js[i], rust[i]];
    assert.equal(rs.name, j.name);
    assert.equal(rs.toml === null, j.toml === null, `${c.name}: Rust and smol-toml disagree on accept/reject`);
    if (j.toml !== null) assert.deepEqual(rs.toml, j.toml, `${c.name}: parsed values differ`);
    assert.deepEqual(comparable(rs.config), comparable(j.config), `${c.name}: config results differ`);
    for (const d of j.config.diagnostics) assert.ok(d.line >= 1 && d.column >= 1, `${c.name}: no file:line:col`);
    if (c.valid !== undefined) {
      const parsed = j.config.diagnostics.every((d) => d.code !== 'parse');
      assert.equal(parsed, c.valid, `${c.name}: expected ${c.valid ? 'valid' : 'invalid'} TOML`);
    }
  }
  return all.length;
}

/** What both languages must agree on for one session. */
function sessionView(session) {
  const s = JSON.parse(JSON.stringify(session));
  const view = { trust: s.trust, effective: comparable(s.effective) };
  if (s.user) view.user = comparable(s.user);
  if (s.project) {
    view.project = { identity: s.project.identity, config: comparable(s.project.config) };
    if (s.project.fingerprint !== undefined) view.project.fingerprint = s.project.fingerprint;
  }
  return view;
}

async function sessionLeg(binary) {
  const { openStore } = await import('../packages/store/src/node/index.ts');
  const { approveProject, loadSessionConfig, scanProject } = await import('../packages/config/src/node/index.ts');
  const { hostileConfig, trustCases, workspace } = await import('../packages/config/test/repos.ts');
  const ws = workspace('murmo-config-session-');
  let checks = 0;
  try {
    const store = await openStore({ roots: ws.roots });
    const userFile = join(ws.home, '.config', 'murmo', 'murmo.toml');
    const agree = async (repo, label, trust) => {
      const js = sessionView(await loadSessionConfig({ cwd: repo, store, env: ws.env }));
      const rustRun = spawnSync(binary, ['session', repo, userFile, ws.roots.data, ws.roots.state, ws.roots.cache], {
        encoding: 'utf8',
        maxBuffer: 64 << 20,
      });
      assert.equal(rustRun.status, 0, `${label}: ${rustRun.stderr}`);
      assert.deepEqual(sessionView(JSON.parse(rustRun.stdout)), js, `${label}: Node and Rust sessions differ`);
      if (trust) assert.equal(js.trust, trust, label);
      // Not vacuous: an approved session loads project shortcuts, any other none.
      const project = js.effective.replacements.filter((s) => s.origin === 'project').length;
      assert.equal(project > 0, js.trust === 'approved', `${label}: ${project} project shortcuts`);
      checks++;
    };
    const approve = async (repo) => {
      const snapshot = await scanProject(repo);
      assert.equal((await approveProject(store, repo, snapshot?.fingerprint ?? '')).status, 'ok');
    };

    const base = ws.repo('base', trustCases.base);
    await agree(base, 'base unapproved', 'review');
    await approve(base);
    await agree(base, 'base approved', 'approved');
    const fixture = ws.repo('fixture', trustCases.fixture);
    await approve(fixture);
    await agree(fixture, 'r8 fixture approved', 'approved');
    for (const c of trustCases.hostile) {
      const repo = ws.repo(`hostile-${c.name}`, trustCases.base, c.ops, [hostileConfig(c.reference)]);
      await agree(repo, `hostile ${c.name}`, 'not-approvable');
    }
    for (const c of trustCases.changes) {
      if (c.name === 'other-repo') {
        await agree(ws.repo('other-repo', trustCases.base), 'other repo', 'review');
        continue;
      }
      const repo = ws.repo(`change-${c.name}`, trustCases.base);
      await approve(repo);
      ws.apply(repo, c.ops);
      await agree(repo, `change ${c.name}`, 'changed');
    }
    // Sessions agree without a project file, and from a subfolder.
    await agree(ws.repo('bare'), 'no project file', 'none');
    await agree(join(base, '.git'), 'from a subfolder', 'approved');
  } finally {
    ws.remove();
  }
  return checks;
}

/** @returns {Promise<{cases: number, sessions: number}>} */
export async function configParity() {
  const binary = rustExample('murmo-config', 'config-parity');
  return { cases: await parseLeg(binary), sessions: await sessionLeg(binary) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await configParity();
  console.log(`config parity: Node and Rust agree on ${result.cases} parse cases and ${result.sessions} sessions`);
}
