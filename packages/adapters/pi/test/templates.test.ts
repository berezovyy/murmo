// Template fields on Pi through its real editor contract: the field session
// moves the cursor with Pi's own completion transaction, and keys arrive as a
// terminal delivers them, several in one read.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EffectiveConfig } from '@murmo/config';
import { loadBuiltins } from '../src/plugins.ts';
import { type LivePi, startLive } from './helpers.ts';

function config(replacements: EffectiveConfig['replacements']): EffectiveConfig {
  return {
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
  };
}

const REVIEW: EffectiveConfig['replacements'] = [
  {
    shortcut: ';rv',
    text: 'Review <change> for <concern>.',
    origin: 'user',
    fields: { concern: { default: 'races' } },
  },
];

async function start(ids: string[], replacements: EffectiveConfig['replacements']): Promise<LivePi> {
  return startLive(loadBuiltins({ ids, config: config(replacements) }).specs);
}

/** Pi's edits (a completion transaction) and sends finish off the key callback; give them time. */
async function until(live: LivePi, done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) {
    await live.session.settle();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function capture(live: LivePi): string[] {
  const sent: string[] = [];
  const original = live.env.editor.onSubmit;
  live.env.editor.onSubmit = (text) => {
    sent.push(text);
    original?.(text);
  };
  return sent;
}

test('template fields: typing replaces the placeholder, Tab and Shift+Tab move between fields (real-host bug)', async () => {
  // Pi opened its own file picker on Tab, and typing landed in front of the
  // placeholder: "Review the patch<change> for ...". Keys go in as one read each
  // word, the way a terminal delivers fast typing.
  const live = await start(['shortcuts'], REVIEW);
  try {
    const sent = capture(live);
    const text = () => live.env.editor.getText();
    live.type(';rv ');
    await until(live, () => text().startsWith('Review'));
    live.type('the patch');
    await until(live, () => !text().includes('<change>'));
    assert.equal(text(), 'Review the patch for races. ');
    live.key('\t');
    await until(live, () => live.adapter.getDraft().cursor === 21);
    live.type('locking');
    await until(live, () => !text().includes('races'));
    assert.equal(text(), 'Review the patch for locking. ');
    live.key('\x1b[Z');
    await until(live, () => live.adapter.getDraft().cursor === 16);
    live.type(' and its tests');
    await until(live, () => text().includes('tests for'));
    assert.equal(text(), 'Review the patch and its tests for locking. ');
    live.key('\r');
    await until(live, () => sent.length > 0);
    assert.deepEqual(sent, ['Review the patch and its tests for locking.']);
  } finally {
    await live.dispose();
  }
});

test('a refused send keeps the rest of the status line (real-host bug)', async () => {
  // Pi wrote the refusal over Murmo's status line itself, so the field hint
  // and every notice beside it vanished, and the core, which had not changed
  // its line, never put them back.
  const live = await start(['shortcuts'], REVIEW);
  try {
    const sent = capture(live);
    live.type(';rv ');
    await until(live, () => live.env.editor.getText().startsWith('Review'));
    live.key('\r');
    await until(live, () => live.adapter.backend.paint.status?.includes('not filled') === true);
    const status = live.adapter.backend.paint.status ?? '';
    assert.match(status, /1 template field not filled; Enter again to send anyway/);
    assert.match(status, /Template field 1 of 2: Tab next, Shift\+Tab back, Esc done/);
    assert.deepEqual(sent, []);
  } finally {
    await live.dispose();
  }
});

test('Tab then Enter in one read sends what the Tab picked from the ; menu', async () => {
  // A terminal delivers a fast Tab, Enter as one read: the send went out before
  // the menu pick's edit landed, with the typed ;rvw instead of the expansion.
  const live = await start(['shortcuts', 'menu'], [{ shortcut: ';rvw', text: 'Review this change.', origin: 'user' }]);
  try {
    const sent = capture(live);
    live.type(';rv');
    await until(live, () => live.adapter.backend.paint.menu !== null);
    live.key('\t');
    live.key('\r');
    await until(live, () => sent.length > 0);
    assert.deepEqual(sent, ['Review this change.']);
  } finally {
    await live.dispose();
  }
});

test('a sent template ends its field session though Pi trims what it sends (real-host bug)', async () => {
  // Pi trims the prompt it sends, and its input event carries the trimmed
  // text. The adapter matched it against the untrimmed draft, so a prompt
  // ending in the space after an expansion was never confirmed: the field
  // hint stayed on the status line and nothing reached onSubmitCommitted.
  const live = await start(['shortcuts'], REVIEW);
  try {
    const sent = capture(live);
    const committed: string[] = [];
    live.adapter.onSubmitCommitted((event) => committed.push(event.text));
    live.type(';rv ');
    await until(live, () => live.env.editor.getText().startsWith('Review'));
    live.type('the patch');
    await until(live, () => !live.env.editor.getText().includes('<change>'));
    assert.match(live.adapter.backend.paint.status ?? '', /Template field 1 of 2/);
    live.key('\r');
    await until(live, () => sent.length > 0);
    // As Pi does: the input event carries the text its editor sent.
    live.env.host.emit('input', { source: 'interactive', text: sent[0] });
    await until(live, () => committed.length > 0 && !(live.adapter.backend.paint.status ?? '').includes('Template'));
    assert.equal(committed.length, 1);
    assert.doesNotMatch(live.adapter.backend.paint.status ?? '', /Template field/);
  } finally {
    await live.dispose();
  }
});
