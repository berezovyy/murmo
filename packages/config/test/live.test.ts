// A config edited while a session runs: which built-ins reload, which settings
// need a restart, and the idle re-check loop.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changedBuiltins,
  type EffectiveConfig,
  mergeConfig,
  parseConfig,
  resolveShortcuts,
  restartNotice,
  restartSettings,
  watchConfig,
} from '../src/index.ts';

const effective = (...lines: string[]): EffectiveConfig =>
  mergeConfig({
    user: resolveShortcuts(
      parseConfig(['version = 1', ...lines].join('\n'), { file: 'murmo.toml', origin: 'user' }),
      new Map(),
    ),
    projectTrusted: false,
  });

const base = effective('[replace]', '";a" = "one"');

test('a new shortcut reloads the shortcuts and the menu, and nothing else', () => {
  // Catches a shortcut edit that never reached a running session, and a reload
  // of every plugin (which drops autocorrect's rejection memory, E5).
  assert.deepEqual(changedBuiltins(base, effective('[replace]', '";a" = "one"', '";b" = "two"')), [
    'shortcuts',
    'menu',
  ]);
  assert.deepEqual(
    changedBuiltins(base, effective('[replace]', '";a" = "one"')),
    [],
    'an unchanged file reloads nothing',
  );
});

test('protected words and the autocorrect switch reload autocorrect alone', () => {
  // `murmo words add` lands in `protect`; a running session must stop fixing the word.
  const words = { ...base, protect: [...base.protect, 'ratatui'] };
  assert.deepEqual(changedBuiltins(base, words), ['autocorrect']);
  assert.deepEqual(changedBuiltins(base, { ...base, autocorrect: true }), ['autocorrect']);
});

test('event hooks and the plugin list need a restart, and the notice says so', () => {
  // Catches a change a running session can't take being dropped in silence.
  const events = effective('[replace]', '";a" = "one"', '[events]', 'enabled = true');
  assert.deepEqual(restartSettings(base, events), ['[events]']);
  assert.deepEqual(changedBuiltins(base, events), []);
  assert.deepEqual(restartNotice(restartSettings(base, events)), ['Restart the agent to apply the [events] change.']);
  assert.deepEqual(restartNotice(restartSettings(base, base)), [], 'turned back: no notice');
});

test('the re-check keeps going after a failed round and stops when told', async () => {
  // Catches one failed check (Claude's helper mid-restart) ending every later
  // one, so the session froze on the config it had.
  const timers: (() => void)[] = [];
  let checks = 0;
  const stop = watchConfig({
    everyMs: 5,
    after: (_ms, callback) => {
      timers.push(callback);
      return () => {};
    },
    check: async () => {
      checks++;
      if (checks === 1) throw new Error('helper restarting');
    },
  });
  for (let round = 0; round < 3; round++) {
    timers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(checks, 3);
  stop();
  timers.shift()?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(checks, 3, 'no round after stop');
});
