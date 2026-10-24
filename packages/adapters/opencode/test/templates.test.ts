// Template fields on OpenCode through its prompt API: Tab is Murmo's inside a
// field session, Shift+Tab stays OpenCode's agent switch, and the unfilled-field
// warning shows beside the rest of the status line.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EffectiveConfig } from '@murmo/config';
import { createInProcessExecutor } from '@murmo/executor';
import { OpenCodeAdapter } from '../src/adapter.ts';
import { startSession } from '../src/session.ts';
import type { StatusSurface } from '../src/status.ts';
import { FakeOpenCode } from './fake-opencode.ts';

const REVIEW: EffectiveConfig['replacements'] = [
  {
    shortcut: ';rv',
    text: 'Review <change> for <concern>.',
    origin: 'user',
    fields: { concern: { default: 'races' } },
  },
];

function recordingStatus(): StatusSurface & { text: string } {
  return {
    text: '',
    set(value) {
      this.text = value ?? '';
    },
    get() {
      return this.text;
    },
    present: () => true,
    bounds: () => null,
    suppress() {},
    dispose() {},
    claimed: true,
  };
}

async function start(replacements: EffectiveConfig['replacements']) {
  const host = new FakeOpenCode();
  const status = recordingStatus();
  const adapter = new OpenCodeAdapter({ api: host.api, core: host.core, status });
  const started = await startSession({
    adapter,
    loadLanguagePack: false,
    executor: createInProcessExecutor({ pressure: () => 1 }),
    config: {
      replacements,
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
    },
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await started.session?.settle();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const sent = () => host.dispatched.filter((c) => c === 'prompt.submit').length;
  return { host, adapter, status, started, settle, sent };
}

const TAB = { name: 'tab', sequence: '\t' };
const SHIFT_TAB = { name: 'tab', sequence: '\x1b[Z', shift: true };
const ENTER = { name: 'return', sequence: '\r' };

test('template fields: typing replaces the placeholder and Tab moves on; Shift+Tab stays OpenCode (real-host bug)', async () => {
  // Typing landed in front of the placeholder ("Review the patch<change> ..."),
  // and Shift+Tab was taken by a claim made for no host in particular, so
  // OpenCode's agent switch stopped working inside a template.
  const t = await start(REVIEW);
  try {
    const text = () => t.adapter.getDraft().text;
    t.host.type(';rv');
    t.host.press({ name: 'space', sequence: ' ' });
    await t.settle();
    t.host.type('the patch');
    await t.settle();
    assert.equal(text(), 'Review the patch for races. ');
    assert.match(t.status.text, /Template field 1 of 2: Tab next, Esc done/);
    assert.doesNotMatch(t.status.text, /Shift\+Tab/);
    t.host.press(TAB);
    await t.settle();
    assert.equal(t.adapter.getDraft().cursor, 21);
    t.host.type('locking');
    await t.settle();
    assert.equal(text(), 'Review the patch for locking. ');
    const keysBefore = t.host.hostKeys.length;
    t.host.press(SHIFT_TAB);
    await t.settle();
    assert.equal(t.host.hostKeys.length, keysBefore + 1, 'Shift+Tab reaches OpenCode');
    t.host.press(ENTER);
    await t.settle();
    assert.equal(t.sent(), 1);
    assert.doesNotMatch(t.status.text, /Template field/, 'the hint leaves with the sent prompt');
  } finally {
    await t.started.close();
  }
});

test('an unfilled field warns once beside the field hint (real-host bug)', async () => {
  // OpenCode wrote the refusal over Murmo's status line, so the hint vanished
  // and the core, whose line had not changed, never put it back.
  const t = await start(REVIEW);
  try {
    t.host.type(';rv');
    t.host.press({ name: 'space', sequence: ' ' });
    await t.settle();
    t.host.press(ENTER);
    await t.settle();
    assert.equal(t.sent(), 0);
    assert.match(t.status.text, /1 template field not filled; Enter again to send anyway/);
    assert.match(t.status.text, /Template field 1 of 2/);
    t.host.press(ENTER);
    await t.settle();
    assert.equal(t.sent(), 1);
  } finally {
    await t.started.close();
  }
});

test('Tab then Enter in one read sends what the Tab picked from the ; menu (real-host bug)', async () => {
  // OpenCode delivered a fast Tab, Enter back to back: the menu pick's edit was
  // dropped as stale and the typed ;rvw went out.
  const t = await start([{ shortcut: ';rvw', text: 'Review this change.', origin: 'user' }]);
  try {
    const texts: string[] = [];
    t.host.inbox.push((event) => texts.push(String(event.item.payload.text)));
    t.host.type(';rv');
    await t.settle();
    t.host.press(TAB);
    t.host.press(ENTER);
    await t.settle();
    assert.deepEqual(texts, ['Review this change.']);
  } finally {
    await t.started.close();
  }
});
