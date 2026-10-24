// OpenCode sets up every TUI plugin before it mounts the prompt, so Murmo's
// session must not start against a prompt that isn't there yet.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EffectiveConfig } from '@murmo/config';
import { createInProcessExecutor } from '@murmo/executor';
import { openStore, storeRootsFromEnv } from '@murmo/store/node';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { createTuiPlugin } from '../src/plugin.ts';
import { prepareRescue, startSession } from '../src/session.ts';
import { FakeOpenCode } from './fake-opencode.ts';

const config: EffectiveConfig = {
  replacements: [],
  overrides: [],
  protect: [],
  autocorrect: false,
  phrasesLearn: false,
  historyEnabled: false,
  plugins: {},
  private: false,
  events: false,
  eventsFailOpen: false,
  diagnostics: [],
};

const executor = () => createInProcessExecutor({ pressure: () => 1 });

async function until(done: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

function homeEnv(dir: string): NodeJS.ProcessEnv {
  const home = join(dir, 'home');
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_CACHE_HOME: join(home, '.cache'),
  };
}

test('the footer says murmo is on as soon as OpenCode mounts its prompt, before any key', async () => {
  // On OpenCode 2.1 nothing from Murmo showed until the first key: the
  // session started during plugin setup, read "no prompt" as a dialog, hid
  // its status, and never drew it again once the prompt appeared.
  const host = new FakeOpenCode({ promptMounted: false });
  const handle = await createTuiPlugin(host.api, host.core, { config, loadLanguagePack: false, executor: executor() });
  host.mountPrompt();
  await until(() => host.footerText().includes('murmo on'));
  const lines = host.footerText().split('\n');
  assert.ok(lines.includes('murmo on · no shortcuts · autocorrect off'), lines.join('\n'));
  // Plugins activated too: autocorrect reports the table these tests leave out.
  assert.ok(lines.includes('Autocorrect is off: the English table failed to load.'), lines.join('\n'));
  await handle.dispose();
});

test('a saved draft is offered as soon as OpenCode mounts its prompt, before any key', async () => {
  // The rescue offer came from `activate`, which was cancelled as stale while
  // there was no prompt: after a crash the offer never appeared, and the
  // first key went to an empty prompt.
  const dir = mkdtempSync(join(tmpdir(), 'murmo-oc-startup-'));
  try {
    const env = homeEnv(dir);
    const cwd = join(dir, 'proj');
    mkdirSync(cwd);
    const first = await prepareRescue(cwd, env);
    const before = new FakeOpenCode();
    const started = await startSession({
      adapter: new OpenCodeAdapter({ api: before.api, core: before.core }),
      executor: executor(),
      loadLanguagePack: false,
      rescue: first,
    });
    before.type('an unsent opencode draft');
    const store = await openStore({ roots: storeRootsFromEnv(env) });
    await until(async () => (await store.drafts.read(first.identity))?.text === 'an unsent opencode draft');
    await started.close();
    const rescue = await prepareRescue(cwd, env);
    assert.equal(rescue.offer?.text, 'an unsent opencode draft');

    const host = new FakeOpenCode({ promptMounted: false });
    const handle = await createTuiPlugin(host.api, host.core, {
      config,
      rescue,
      loadLanguagePack: false,
      executor: executor(),
    });
    host.mountPrompt();
    await until(() => host.footerText().includes('Restore your last draft'));
    assert.match(host.footerText(), /Restore your last draft from \d\d:\d\d\? \(Tab\)/);
    host.press({ name: 'tab', sequence: '\t' });
    await until(() => host.prompt.plainText === 'an unsent opencode draft');
    assert.equal(host.prompt.plainText, 'an unsent opencode draft');
    await handle.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Murmo closed before OpenCode mounts its prompt never starts a session', async () => {
  // OpenCode can unload a plugin before the prompt exists (quit during
  // startup); a session started after that would hold keys with no owner.
  const host = new FakeOpenCode({ promptMounted: false });
  const handle = await createTuiPlugin(host.api, host.core, { config, loadLanguagePack: false, executor: executor() });
  await handle.dispose();
  host.mountPrompt();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(host.keypressHandlers().length, 0);
  assert.equal(host.footerText(), '');
});
