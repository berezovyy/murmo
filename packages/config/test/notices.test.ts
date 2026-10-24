// The lines a host shows when a session starts. A wrong or broken personal
// `murmo.toml` failed silently on every host, and nothing said Murmo was on.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configProblemNotices, mergeConfig, parseConfig, resolveShortcuts, sessionHint } from '../src/index.ts';

const USER = '/home/u/.config/murmo/murmo.toml';

function problems(text: string): string[] {
  return configProblemNotices(parseConfig(text, { file: USER, origin: 'user' }).diagnostics);
}

test('the natural wrong guesses each give one notice with file and line', () => {
  // Catches the silent failures users hit: `[shortcuts]` instead of
  // `[replace]`, an unclosed table header, and a key that lands inside the
  // `[replace.";greet"]` table above it.
  assert.deepEqual(problems('version = 1\n[shortcuts]\nhi = "hello"\n'), [
    'murmo.toml:2: unknown key "shortcuts" ignored',
  ]);
  assert.deepEqual(problems('version = 1\n[replace\n";a" = "b"\n'), [
    'murmo.toml:2: not valid TOML: illegal character in key; file ignored',
  ]);
  assert.deepEqual(problems('version = 1\n[replace.";greet"]\ntext = "hello"\nhi = "x"\n'), [
    'murmo.toml:4: unknown key "hi" in ";greet" ignored',
  ]);
});

test('several problems in one file are one notice that counts the rest', () => {
  // Catches a broken file pushing every other notice (trust, the session line) off a one-line status.
  assert.deepEqual(problems('version = 1\nfoo = 1\nbar = 2\nbaz = 3\n'), [
    'murmo.toml:2: unknown key "foo" ignored (and 2 more)',
  ]);
});

test('skipped shortcut entries and merge notices are left to the shortcuts compiler', () => {
  // Catches the same problem shown twice: the compiler already says "Skipped 1 shortcut in murmo.toml".
  assert.deepEqual(problems('version = 1\n[replace]\n"bad name" = "x"\n'), []);
  const project = resolveShortcuts(
    parseConfig('version = 1\n[replace]\n";p" = "x"\n', { file: '/r/.murmo.toml', origin: 'project' }),
    new Map(),
  );
  assert.deepEqual(configProblemNotices(mergeConfig({ project, projectTrusted: false }).diagnostics), []);
});

test('the session line says murmo is on, what it loaded, and who turned autocorrect off', () => {
  // Catches Claude and OpenCode looking stock after install, and Pi telling a
  // user whose personal file turns autocorrect on to "opt in" when the
  // project file turned it off.
  const user = resolveShortcuts(
    parseConfig('version = 1\n[autocorrect]\nenabled = true\n[replace]\n";a" = "1"\n";b" = "2"\n', {
      file: USER,
      origin: 'user',
    }),
    new Map(),
  );
  const projectOff = resolveShortcuts(
    parseConfig('version = 1\n[autocorrect]\nenabled = false\n', { file: '/r/.murmo.toml', origin: 'project' }),
    new Map(),
  );
  assert.equal(
    sessionHint({ effective: mergeConfig({ user, projectTrusted: false }) }),
    'murmo on · 2 shortcuts · autocorrect on',
  );
  assert.equal(
    sessionHint({
      effective: mergeConfig({ user, project: projectOff, projectTrusted: false }),
      project: { file: '/r/.murmo.toml', shortcuts: 0, autocorrect: false },
    }),
    'murmo on · 2 shortcuts · autocorrect off in .murmo.toml',
  );
  assert.equal(
    sessionHint({ effective: mergeConfig({ projectTrusted: false }) }),
    'murmo on · no shortcuts · autocorrect off',
  );
});
