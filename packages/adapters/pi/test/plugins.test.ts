// Installed loader registers literal shortcut settings as inline rules
// (r14 H1: `;r14␠` stayed literal because the loader never did this).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBuiltins } from '../src/plugins.ts';

test('loadBuiltins registers shortcut literals as inline replacements (E18)', () => {
  const loaded = loadBuiltins({
    ids: ['shortcuts', 'menu', 'names'],
    config: {
      language: 'en',
      replacements: [{ shortcut: 'r14', text: 'round fourteen', origin: 'user' }],
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
  const shortcuts = loaded.specs.find((spec) => spec.id === 'shortcuts');
  assert.ok(shortcuts?.inline?.length, 'shortcuts spec must carry inline rules');
  const entries = shortcuts?.inline?.[0]?.replacements?.entries ?? {};
  assert.equal(entries.r14, 'round fourteen');
  const semi = loadBuiltins({
    ids: ['shortcuts'],
    config: {
      replacements: [{ shortcut: ';r14', text: 'round fourteen', origin: 'user' }],
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
  assert.equal(semi.specs[0]?.inline?.[0]?.replacements?.entries?.[';r14'], 'round fourteen');
  assert.deepEqual(loaded.order, ['shortcuts', 'menu', 'names']);
});

test('default builtins include the names plugin so Tab can open project names (phase 36)', () => {
  const loaded = loadBuiltins();
  assert.ok(loaded.specs.some((spec) => spec.id === 'names'));
  assert.ok(loaded.order.includes('names'));
});

test('explicit pluginOrder AB/BA is honored when it names every spec (E20)', () => {
  const ba = loadBuiltins({
    ids: ['shortcuts', 'menu'],
    config: {
      replacements: [],
      overrides: [],
      protect: [],
      autocorrect: false,
      phrasesLearn: false,
      historyEnabled: false,
      pluginOrder: ['menu', 'shortcuts'],
      plugins: {},
      private: false,
      events: false,
      eventsFailOpen: false,
      diagnostics: [],
    },
  });
  assert.deepEqual(ba.order, ['menu', 'shortcuts']);
});
