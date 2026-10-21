// Compile: trust notice, overrides, collisions, skipped entries, Claude size gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { utf8Length } from '@murmo/text';
import {
  compileShortcuts,
  defaultLexicon,
  lexiconFromSets,
  listShortcuts,
  replacementsForSpace,
} from '../src/index.ts';
import { seeds } from './helpers.ts';

test('an untrusted project file expands nothing of its own and shows one notice', () => {
  // Catches a hostile clone putting text into prompts before review (lesson 27, E8).
  const compiled = compileShortcuts({
    replacements: seeds({ ';mine': 'from me' }),
    trust: 'review',
    projectFile: '/tmp/repo/.murmo.toml',
    projectShortcutCount: 12,
  });
  assert.equal(compiled.inline.entries[';mine'], 'from me');
  assert.deepEqual(Object.keys(compiled.inline.entries), [';mine']);
  assert.equal(compiled.notices.filter((n) => n.kind === 'trust').length, 1);
  assert.equal(
    compiled.notices.find((n) => n.kind === 'trust')?.text,
    '.murmo.toml has 12 shortcuts. Run "murmo trust" to review.',
  );
});

test('a project override is listed once, with the phase-15 wording', () => {
  const compiled = compileShortcuts({
    replacements: seeds({ ';rvw': 'from project' }, 'project'),
    overrides: [';rvw'],
    trust: 'approved',
  });
  assert.equal(compiled.sources[';rvw'], 'project');
  assert.deepEqual(
    compiled.notices.filter((n) => n.kind === 'override').map((n) => n.text),
    ['Project shortcut ;rvw overrides your personal one.'],
  );
});

test('skipped entries become one notice with the file and first line', () => {
  const compiled = compileShortcuts({
    replacements: [],
    diagnostics: [
      { code: 'invalid-shortcut', file: '.murmo.toml', line: 14, message: 'shortcut "/" starts with "/"; skipped' },
      { code: 'invalid-shortcut', file: '.murmo.toml', line: 15, message: 'shortcut "@x" starts with "@"; skipped' },
    ],
  });
  assert.equal(
    compiled.notices.find((n) => n.kind === 'skipped')?.text,
    'Skipped 2 shortcuts in .murmo.toml (line 14: starts with "/").',
  );
});

test('entries over 1 KiB stay in long; Claude omits them from Space and warns once', () => {
  // Catches registering ;big for Space on a host with no async CAS (lesson 70, E5).
  const big = 'a'.repeat(1025);
  assert.equal(utf8Length(big), 1025);
  const compiled = compileShortcuts({
    replacements: seeds({ ';big': big, ';ok': 'short' }),
    asyncEdits: false,
  });
  assert.equal(compiled.inline.entries[';ok'], 'short');
  assert.equal(compiled.long[';big'], big);
  assert.deepEqual(Object.keys(replacementsForSpace(compiled, false)), [';ok']);
  assert.equal(
    compiled.notices.find((n) => n.kind === 'claude-size')?.text,
    ';big is over 1 KiB: in Claude Code, insert it from the ; menu with Tab',
  );
  assert.ok(listShortcuts(compiled).some((row) => row.name === ';big' && row.bytes === 1025));
});

test('the default lexicon warns for fix and not for ;fix', () => {
  const compiled = compileShortcuts({
    replacements: seeds({ fix: 'patch it', ';fix': 'patch it' }),
    lexicon: defaultLexicon(),
  });
  const collisions = compiled.notices.filter((n) => n.kind === 'collision').map((n) => n.text);
  assert.deepEqual(collisions, ['Shortcut "fix" is also an English word; consider ";fix".']);
});

test('a custom lexicon can flag a project name', () => {
  const compiled = compileShortcuts({
    replacements: seeds({ ratatui: 'the crate' }),
    lexicon: lexiconFromSets({ names: ['ratatui'] }),
  });
  assert.equal(
    compiled.notices.find((n) => n.kind === 'collision')?.text,
    'Shortcut "ratatui" is also a project name; consider ";ratatui".',
  );
});
