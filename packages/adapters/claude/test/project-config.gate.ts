// Claude loads project config through the real murmo-plugin-host (lesson 73: a
// fake pass that the installed helper breaks). The approval is written by the
// Node trust store, as `murmo trust` does, and checked by the helper's Rust
// loader; fixtures/hosts/project-shortcuts.json is the same check on real
// Claude. The helper runs as Claude 2.1.306 runs it: `--http --socket`, stdin
// closed, one `POST /rpc` per request over the Unix socket.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { approveProject, scanProject } from '@murmo/config/node';
import { helperBinary } from '@murmo/executor/node';
import { decodeDraft } from '@murmo/store';
import { openStore, projectIdOfCwd, storeRootsFromEnv } from '@murmo/store/node';
import { createClaudeHost } from '../src/session.ts';
import { type HostServices, PLUGIN_VERSION, type SpawnChunk } from '../src/types.ts';
import { FakeClaude, typeChars } from './fake-runtime.ts';

const PROJECT = `version = 1\n[replace]\n";hp" = 'harness project shortcut'\n`;

let dir: string;
let env: NodeJS.ProcessEnv;

before(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'murmo-claude-config-')));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.config', 'murmo'), { recursive: true });
  writeFileSync(join(home, '.config', 'murmo', 'murmo.toml'), `version = 1\n[replace]\n";me" = 'personal shortcut'\n`);
  env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
  };
});
after(() => rmSync(dir, { recursive: true, force: true }));

function repo(name: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.murmo.toml'), PROJECT);
  return root;
}

/** Claude's `$.process.spawn` and `$.http.fetch({socketPath})`, on Node. */
function claudeServices(): HostServices & { spawned: string[][]; exits: Promise<number | null>[] } {
  const spawned: string[][] = [];
  const exits: Promise<number | null>[] = [];
  return {
    spawned,
    exits,
    repaint() {},
    after: (ms, callback) => {
      const id = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(id) };
    },
    spawn(argv) {
      spawned.push([...argv]);
      const [binary = '', ...args] = argv;
      const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
      exits.push(new Promise((resolve) => child.once('exit', resolve)));
      child.stdout.setEncoding('utf8');
      const chunks = child.stdout[Symbol.asyncIterator]();
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<SpawnChunk> {
          for (let next = await chunks.next(); !next.done; next = await chunks.next()) {
            yield { stream: 'stdout', text: String(next.value) };
          }
        },
        async return() {
          child.kill();
          return { done: true, value: undefined };
        },
      };
    },
    fetch(url, init) {
      return new Promise((resolve, reject) => {
        const req = request(
          url,
          { method: init.method, headers: init.headers, ...(init.socketPath ? { socketPath: init.socketPath } : {}) },
          (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (piece: string) => {
              text += piece;
            });
            res.on('end', () => resolve({ text }));
          },
        );
        req.on('error', reject);
        req.end(init.body);
      });
    },
  };
}

async function boot(cwd: string) {
  const services = claudeServices();
  const host = createClaudeHost();
  await host.bootPacked({
    payloadRoot: '',
    integrityJson: JSON.stringify({ version: PLUGIN_VERSION }),
    cwd,
    services,
    helperBinaries: [helperBinary()],
    tmpdir: dir,
  });
  return { host, services, fake: new FakeClaude() };
}

async function typed(cwd: string, text: string) {
  const { host, services, fake } = await boot(cwd);
  try {
    await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, text);
    await host.session?.settle();
    return { draft: fake.draft.text, notices: [...host.notices], spawned: services.spawned, services };
  } finally {
    await host.dispose();
  }
}

test('an approved project shortcut expands in Claude, with the personal ones', async () => {
  // Catches the real-host bug: `;rvw` from an approved `murmo init` file stayed
  // literal in Claude because only the personal murmo.toml was read.
  const root = repo('approved');
  const store = await openStore({ roots: storeRootsFromEnv(env, env.HOME) });
  const snapshot = await scanProject(root);
  assert.equal((await approveProject(store, root, snapshot?.fingerprint ?? '')).status, 'ok');
  const project = await typed(root, ';hp ');
  assert.equal(project.draft, 'harness project shortcut ');
  assert.deepEqual(project.notices, ['murmo on · 2 shortcuts · autocorrect off'], 'no trust notice once approved');
  assert.equal(project.spawned.length, 1);
  const socket = project.spawned[0]?.[3] ?? '';
  assert.ok(socket.length < 104, 'socket path under the macOS sun_path limit (E11)');
  // Catches a helper killed at session end, which leaves its socket behind.
  assert.equal(await project.services.exits[0], 0, 'helper exits on shutdown');
  assert.equal(existsSync(socket), false, 'socket removed');
  assert.equal((await typed(root, ';me ')).draft, 'personal shortcut ');
});

test('an unreviewed project shortcut stays literal and the hint says how to review it', async () => {
  // Catches a hostile clone expanding its shortcuts in Claude before the user
  // looked, and a silent off that leaves the user guessing why.
  const root = repo('unreviewed');
  const result = await typed(root, ';hp ');
  assert.equal(result.draft, ';hp ');
  // The short form fits Claude's tail beside its own hint, command included.
  assert.deepEqual(result.notices, [
    '.murmo.toml has 1 shortcut. Run "murmo trust" to review.',
    'murmo on · 1 shortcut · autocorrect off',
  ]);
  assert.equal((await typed(root, ';me ')).draft, 'personal shortcut ');
});

test('without a helper the personal file still loads and project shortcuts are off with a reason', async () => {
  // Catches a missing or broken helper turning into either no shortcuts at all
  // or project shortcuts loaded without their trust check.
  const root = repo('no-helper');
  const store = await openStore({ roots: storeRootsFromEnv(env, env.HOME) });
  const snapshot = await scanProject(root);
  assert.equal((await approveProject(store, root, snapshot?.fingerprint ?? '')).status, 'ok');
  const host = createClaudeHost();
  await host.bootPacked({
    payloadRoot: '',
    integrityJson: JSON.stringify({ version: PLUGIN_VERSION }),
    cwd: root,
    userToml: `version = 1\n[replace]\n";me" = 'personal shortcut'\n`,
    services: claudeServices(),
    helperBinaries: [],
    tmpdir: dir,
  });
  const fake = new FakeClaude();
  try {
    await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, ';hp ;me ');
    assert.equal(fake.draft.text, ';hp personal shortcut ');
    assert.deepEqual(host.notices, [
      'project shortcuts off: the Murmo helper is missing from this install (murmo doctor)',
      'murmo on · 1 shortcut · autocorrect off',
    ]);
  } finally {
    await host.dispose();
  }
});

test('an unsent Claude draft reaches the drafts store through the helper, and a clean quit releases its lock', async () => {
  // Claude kept drafts in memory, so after a SIGKILL the text
  // existed nowhere under $HOME and nothing could be offered.
  const root = repo('rescue');
  const { host, fake } = await boot(root);
  const folder = join(storeRootsFromEnv(env, env.HOME).state, 'drafts', 'v1', await projectIdOfCwd(root), 'claude');
  const files = () => (existsSync(folder) ? readdirSync(folder) : []);
  try {
    await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, 'an unsent claude draft');
    await host.session?.settle();
    const deadline = Date.now() + 3000;
    while (!files().some((name) => name.endsWith('.draft')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const draft = files().find((name) => name.endsWith('.draft'));
    assert.ok(draft, `no draft under ${folder}`);
    assert.ok(files().includes(draft.replace(/\.draft$/, '.lock')), 'the live session holds its lock');
    const bytes = readFileSync(join(folder, draft));
    assert.equal(statSync(join(folder, draft)).mode & 0o777, 0o600);
    const decoded = decodeDraft(bytes);
    assert.equal(decoded.ok && decoded.document.text, 'an unsent claude draft');
  } finally {
    await host.dispose();
  }
  assert.deepEqual(
    files().filter((name) => name.endsWith('.lock')),
    [],
    'a clean quit leaves no lock, so the next session may offer the draft',
  );
});
