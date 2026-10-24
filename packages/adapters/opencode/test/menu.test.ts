// The `;` menu on OpenCode: drawn by the prompt box, clipped to the terminal,
// and its keys (Down, Tab, Enter, Escape) never reach OpenCode while it is open.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EffectiveConfig } from '@murmo/config';
import { createInProcessExecutor } from '@murmo/executor';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { startSession } from '../src/session.ts';
import { FakeBox, FakeOpenCode } from './fake-opencode.ts';

const config = (): EffectiveConfig => ({
  replacements: [
    { shortcut: ';hp', text: 'harness project shortcut', origin: 'user' },
    { shortcut: ';tst', text: 'Run the project test suite only.', origin: 'user' },
  ],
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
});

async function menuSession() {
  const host = new FakeOpenCode();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core });
  const started = await startSession({
    adapter,
    config: config(),
    loadLanguagePack: false,
    executor: createInProcessExecutor({ pressure: () => 1 }),
  });
  host.focusPrompt();
  return { host, adapter, started };
}

/** Plugin hooks run asynchronously: let them finish and the menu render. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
};

const key = (name: string) => ({ name, sequence: name === 'return' ? '\r' : name === 'tab' ? '\t' : '' });

test('the menu opens on ; and is drawn right above the prompt box, not in the top rows', async () => {
  // Assigning the read-only `plainText` of OpenCode's TextRenderable threw
  // after the rows were set: the node stayed at the top-left corner of the
  // screen and the core never learnt the menu was open.
  const { host, started } = await menuSession();
  host.type(';hp');
  await settle();
  const menu = host.overlayNode('menu');
  assert.ok(menu?.visible, 'menu node shown');
  assert.equal(menu.content, '> ;hp  harness project shortcut');
  const box = host.prompt.parent;
  assert.ok(box);
  assert.ok(box.children.includes(menu), 'drawn inside the prompt box, so it moves with it');
  assert.equal(menu.top, -1, 'one row, directly above the box');
  assert.equal(menu.left, 0);
  assert.equal(menu.width, box.width);
  await started.close();
});

test('rows show no built-in owner tag', async () => {
  // Rows ended in `[menu]` and `[names]`: the built-ins are not owned by `murmo…`.
  const { host, started } = await menuSession();
  host.type(';');
  await settle();
  const content = host.overlayNode('menu')?.content ?? '';
  assert.match(content, /;hp {2}harness project shortcut/);
  assert.doesNotMatch(content, /\[(menu|names|shortcuts)\]/);
  await started.close();
});

test('Down and Tab pick a row and never reach OpenCode', async () => {
  // Down opened OpenCode's Subagents panel and Tab went to the host; the
  // draft kept `;hp`.
  const { host, adapter, started } = await menuSession();
  host.type(';hp');
  await settle();
  host.press(key('down'));
  host.press(key('tab'));
  await settle();
  assert.equal(adapter.getDraft().text, 'harness project shortcut');
  assert.deepEqual(
    host.hostKeys.filter((name) => name === 'down' || name === 'tab'),
    [],
  );
  assert.equal(host.overlayNode('menu')?.visible ?? false, false);
  await started.close();
});

test('Enter in the open menu picks the row and never sends', async () => {
  // Enter sent the raw `;t` to the model although the core menu promises it never sends.
  const { host, adapter, started } = await menuSession();
  host.type(';hp');
  await settle();
  host.press(key('return'));
  await settle();
  assert.equal(adapter.getDraft().text, 'harness project shortcut');
  assert.deepEqual(host.dispatched, []);
  await started.close();
});

test('Escape closes the menu and keeps the typed query', async () => {
  // Escape went to OpenCode and left the overlay up.
  const { host, adapter, started } = await menuSession();
  host.type(';hp');
  await settle();
  host.press(key('escape'));
  await settle();
  assert.equal(adapter.getDraft().text, ';hp');
  assert.equal(host.overlayNode('menu')?.visible ?? false, false);
  assert.ok(!host.hostKeys.includes('escape'));
  await started.close();
});

test('at 50×15 the menu fits the terminal width and leaves the prompt box uncovered', async () => {
  // A fixed 88-cell node filled the whole 50×15 screen and buried the composer.
  const { host, started } = await menuSession();
  host.resize(50, 15, { x: 0, y: 8, width: 50, height: 5 });
  host.type(';');
  await settle();
  const menu = host.overlayNode('menu');
  assert.ok(menu?.visible);
  const rows = menu.content.split('\n');
  assert.ok(
    rows.every((row) => row.length <= 50),
    `rows wider than 50: ${JSON.stringify(rows)}`,
  );
  assert.ok(menu.width <= 50);
  assert.ok(menu.top + menu.height <= 0, 'ends above the box');
  assert.ok(8 + menu.top >= 0, 'starts on screen');
  await started.close();
});

test('the menu clips its rows to the rows above the box and keeps the selection in view', async () => {
  // With the prompt two rows from the top there is room for two rows only.
  const { host, started } = await menuSession();
  host.resize(60, 30, { x: 0, y: 2, width: 60, height: 20 });
  host.type(';');
  await settle();
  const menu = host.overlayNode('menu');
  assert.ok(menu?.visible);
  assert.equal(menu.height, 2);
  assert.equal(menu.top, -2);
  host.press(key('down'));
  host.press(key('down'));
  await settle();
  assert.match(host.overlayNode('menu')?.content ?? '', /^> /m, 'selected row still shown');
  await started.close();
});

test('the menu hides while an OpenCode panel has the prompt and comes back after', async () => {
  // The overlay stayed drawn over OpenCode's panels.
  const { host, started } = await menuSession();
  host.type(';hp');
  await settle();
  host.openPanel();
  assert.equal(host.overlayNode('menu')?.visible, false);
  host.focusPrompt();
  assert.equal(host.overlayNode('menu')?.visible, true);
  await started.close();
});

test('when OpenCode rebuilds the prompt box the menu moves to the new box and never writes the old node', async () => {
  // A route change destroys the prompt with Murmo's node in it; writing to a
  // destroyed native renderable kills OpenCode's renderer.
  const { host, started } = await menuSession();
  host.type(';h');
  await settle();
  const old = host.prompt.parent;
  assert.ok(old);
  old.destroy();
  host.prompt.parent = new FakeBox('prompt-2', { x: 10, y: 30, width: 70, height: 5 });
  host.type('p');
  await settle();
  const menu = host.overlayNode('menu');
  assert.ok(menu?.visible);
  assert.ok(host.prompt.parent.children.includes(menu));
  assert.equal(menu.content, '> ;hp  harness project shortcut');
  await started.close();
});
