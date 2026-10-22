// Schema v1, limits and diagnostics. Each test names the failure it catches;
// JS/Rust agreement on the same cases is tools/config-parity.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ConfigFile,
  type ConfigOrigin,
  dropOneNewline,
  formatDiagnostic,
  parseConfig,
  REFERENCE_PROBLEMS,
  resolveShortcuts,
  shortcutProblem,
} from '../src/index.ts';
import { configCases } from './fixtures.ts';
import { sourceOf, type TomlCase } from './parity-cases.ts';

const schema = configCases('schema.json');
const corpus = configCases('toml-corpus.json');

const parse = (text: string, origin: ConfigOrigin = 'user'): ConfigFile =>
  parseConfig(text, { file: 'murmo.toml', origin });
const named = (name: string): ConfigFile => {
  const c = schema.find((x) => x.name === name);
  assert.ok(c, name);
  return parseConfig(sourceOf(c), { file: `${name}.toml`, origin: c.origin ?? 'user' });
};
const codes = (file: ConfigFile) => file.diagnostics.map((d) => d.code);

test('the 15 r8 corpus cases accept and reject as r8 measured, with file:line:col', () => {
  // Catches a parser swap or option that changes what loads (E2).
  for (const c of corpus) {
    const file = parseConfig(sourceOf(c), { file: `${c.name}.toml`, origin: 'user' });
    assert.equal(!codes(file).includes('parse'), c.valid, c.name);
    for (const d of file.diagnostics) assert.match(formatDiagnostic(d), /^[^:]+:\d+:\d+: /);
  }
  // CRLF and BOM files load the same text as LF files (lesson 27).
  const crlf = corpus.find((c) => c.name === 'crlf') as TomlCase;
  const text = parseConfig(sourceOf(crlf), { file: 'c', origin: 'user' }).shortcuts[0];
  assert.ok(text?.kind === 'text' && !text.text.includes('\r'));
  const bom = parseConfig(sourceOf(corpus.find((c) => c.name === 'bom') as TomlCase), { file: 'b', origin: 'user' });
  const fixture = parseConfig(sourceOf(corpus.find((c) => c.name === 'fixture') as TomlCase), {
    file: 'f',
    origin: 'user',
  });
  assert.deepEqual(
    bom.shortcuts.map((s) => s.shortcut),
    fixture.shortcuts.map((s) => s.shortcut),
  );
});

test('the file is ignored alone for a parse error, an unknown version or deep nesting', () => {
  // Catches one bad file taking the session down or loading half of itself.
  assert.deepEqual(codes(named('error-mid-line')), ['parse']);
  assert.equal(named('error-mid-line').diagnostics[0]?.line, 2);
  assert.deepEqual(codes(named('version-2')), ['unsupported-version']);
  assert.deepEqual(codes(named('version-string')), ['unsupported-version']);
  assert.equal(named('version-float').status, 'ok');
  assert.equal(named('version-missing').status, 'ok');
  // An unclosed inline table at the end of the file is reported on its own line.
  assert.deepEqual([named('error-eof').diagnostics[0]?.line], [2]);
});

test('validation diagnostics point at the key in code points, after BOM and CRLF', () => {
  // Catches columns counted in UTF-16 units or bytes, and lines shifted by \r.
  for (const name of ['crlf-positions', 'bom-positions']) {
    const [d] = named(name).diagnostics;
    assert.equal(d?.code, 'invalid-shortcut', name);
    assert.deepEqual([d?.line, d?.column], name === 'crlf-positions' ? [3, 1] : [2, 1], name);
  }
  const [after] = named('multiline-before-key').diagnostics;
  assert.deepEqual([after?.line, after?.column], [5, 1], 'a multi-line string moves later keys down');
  const unicode = named('error-unicode-col').diagnostics[0];
  assert.equal(unicode?.line, 2);
});

test('shortcuts follow the architecture rules, in one order in both languages', () => {
  // Catches host command characters (/ @ ! # - .) becoming shortcuts.
  for (const bad of [
    '/x',
    '@x',
    '!x',
    '#x',
    '-x',
    '.x',
    '',
    'a b',
    'a\u0085b',
    'a\u{a0}b',
    'x'.repeat(33),
    'a\u{202e}b',
  ]) {
    assert.notEqual(shortcutProblem(bad), null, JSON.stringify(bad));
  }
  for (const good of [
    ';rvw',
    ',x',
    '\\x',
    '=x',
    '+x',
    '7x',
    '\u{e9}x',
    '\u{661}x',
    'tst',
    'x'.repeat(32),
    ';\u{1f680}',
  ]) {
    assert.equal(shortcutProblem(good), null, JSON.stringify(good));
  }
  assert.deepEqual(
    named('shortcut-allowed-first').shortcuts.map((s) => s.shortcut),
    ['+x', ',x', '7x', ';x', '=x', '\\x', '\u{e9}x', '\u{661}x'],
  );
  // Sorted in code point order: U+1D400 after U+FF21, which UTF-16 order gets wrong.
  assert.deepEqual(
    named('order').shortcuts.map((s) => s.shortcut),
    ['A', 'z', '\u{e9}', '\u{ff21}', '\u{1d400}'],
  );
});

test('expansions: 16 KiB of UTF-8, tabs and newlines allowed, controls refused', () => {
  // Catches a byte limit counted in UTF-16 units, or an escape sequence inserted into a prompt.
  assert.equal(named('expansion-16k').shortcuts.length, 1);
  assert.deepEqual(codes(named('expansion-16k-plus')), ['expansion-too-large']);
  assert.deepEqual(codes(named('expansion-multibyte-limit')), ['expansion-too-large']);
  assert.equal(named('expansion-tab-lf-cr').shortcuts.length, 1);
  assert.deepEqual(codes(named('expansion-c1')), ['unsafe-text']);
  assert.deepEqual(codes(named('expansion-del')), ['unsafe-text']);
});

test('1,000 shortcuts load and 1,001 load none, with one error', () => {
  // Catches a silently truncated [replace] table.
  assert.equal(named('thousand').shortcuts.length, 1000);
  const many = named('too-many');
  assert.equal(many.shortcuts.length, 0);
  assert.deepEqual(codes(many), ['too-many-shortcuts']);
  assert.equal(many.status, 'ok', 'the rest of the file still applies');
});

test('bad entries are skipped one by one; unknown keys warn and are ignored', () => {
  // Catches one typo disabling the whole file, and a newer file breaking an older Murmo.
  const entries = named('entry-type');
  assert.equal(entries.shortcuts.length, 0);
  assert.deepEqual(codes(entries), ['invalid-type', 'invalid-type', 'invalid-type']);
  const files = named('entry-file');
  assert.deepEqual(
    files.shortcuts.map((s) => [s.shortcut, s.kind]),
    [
      ['x', 'file'],
      ['z', 'file'],
    ],
  );
  assert.deepEqual(codes(files).sort(), ['invalid-type', 'unknown-key']);
  assert.deepEqual(codes(named('unknown')), ['unknown-key', 'unknown-key']);
  const words = named('words');
  assert.deepEqual(words.protect, ['ratatui', 'OutboxWorker']);
  assert.ok(codes(words).includes('unknown-key'));
});

test('excerpts are escaped and cut to 120 code points', () => {
  // Catches an excerpt that prints raw ESC, or a 200-character line in a notice.
  const [escaped] = named('excerpt-escaped').diagnostics;
  assert.ok(escaped?.excerpt?.includes('\\u001b') && !escaped.excerpt.includes('\u001b'));
  assert.ok(escaped?.message.includes('\\u001b'));
  const [long] = named('long-excerpt').diagnostics;
  assert.equal([...(long?.excerpt ?? '')].length, 121);
  assert.ok(long?.excerpt?.endsWith('\u{2026}'));
});

test('[names] loads enabled, key and languages; unknown keys warn', () => {
  const file = parse('[names]\nenabled = true\nkey = "Tab"\nlanguages = ["rust", "go"]\n');
  assert.equal(file.names?.enabled, true);
  assert.equal(file.names?.key, 'Tab');
  assert.deepEqual(file.names?.languages, ['rust', 'go']);
  const bad = parse('[names]\nkey = "Not A Key"\nextra = 1\n');
  assert.ok(codes(bad).includes('invalid-value'));
  assert.ok(codes(bad).includes('unknown-key'));
});

test('a project file can only make Murmo do less', () => {
  // Catches an untrusted repository turning autocorrect, a plugin or the plugin order on.
  assert.equal(named('autocorrect-project').autocorrect, undefined);
  assert.equal(named('autocorrect-off-project').autocorrect, false);
  assert.equal(named('privacy-off-project').private, undefined);
  const plugins = named('plugins-project');
  assert.equal(plugins.pluginOrder, undefined);
  assert.equal(plugins.plugins.menu?.enabled, undefined);
  assert.equal(plugins.plugins.rescue?.enabled, false);
  assert.deepEqual(codes(plugins), ['project-only-reduces', 'project-only-reduces']);
});

test('plugin settings are JSON data; enabled is split off as host-owned', () => {
  // Catches a TOML date, inf or a 2^53+ integer reaching a plugin that expects JSON,
  // and the host switch leaking into the plugin's own settings (phase 03 hand-off).
  const ok = named('plugins');
  assert.deepEqual(ok.pluginOrder, ['autocorrect', 'shortcuts', 'menu', '@me/x']);
  assert.equal(ok.plugins.rescue?.enabled, true);
  assert.deepEqual(ok.plugins.rescue?.settings, {
    big: 9007199254740991,
    idle: 1500,
    list: [1, 'a', true],
    nested: { a: { b: 1 } },
    ratio: 0.5,
  });
  const bad = named('plugins-bad-values');
  assert.deepEqual(bad.plugins.rescue?.settings, {});
  assert.deepEqual(codes(bad).sort(), [
    'invalid-type',
    'invalid-value',
    'invalid-value',
    'invalid-value',
    'invalid-value',
  ]);
  assert.deepEqual(codes(named('integer-big')), ['invalid-value'], 'a 64-bit integer loads the file, skips the value');
  const proto = named('proto-key');
  assert.equal(proto.shortcuts[0]?.shortcut, ';__proto__');
  assert.ok(Object.hasOwn(proto.plugins.menu?.settings ?? {}, '__proto__'));
  assert.equal(Object.getPrototypeOf(proto.plugins.menu?.settings), Object.prototype);
});

test('a file reference drops exactly one trailing newline and refuses unsafe text', () => {
  // Catches a reference that loses a second newline, or one that inserts an escape.
  assert.equal(dropOneNewline('a\n\n'), 'a\n');
  assert.equal(dropOneNewline('a\r\n'), 'a');
  assert.equal(dropOneNewline('a'), 'a');
  const file = parse('[replace]\na = { file = "a.md" }\nb = { file = "b.md" }\nc = { file = "c.md" }\n', 'project');
  const loaded = resolveShortcuts(
    file,
    new Map([
      ['a.md', { status: 'ok', text: 'Line\n' }],
      ['b.md', { status: 'ok', text: 'bad \u001b[2J\n' }],
    ]),
  );
  assert.deepEqual(
    loaded.replacements.map((s) => [s.shortcut, s.text, s.reference]),
    [['a', 'Line', 'a.md']],
  );
  const messages = loaded.diagnostics.map((d) => d.message);
  assert.ok(messages.some((m) => m.includes('contains a control or terminal escape sequence')));
  assert.ok(messages.some((m) => m.includes(REFERENCE_PROBLEMS.unreadable)));
});
