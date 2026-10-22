// Template parse, literal values, field walk, no-send, Claude cursor, undo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHarness, createManualClock, ReferenceAdapter } from '@murmo/core/testing';
import { compileShortcuts, offerShortcut, parseTemplate, shortcutsPlugin, unfilledMessage } from '../src/index.ts';
import { HOST_CAPS, seeds } from './helpers.ts';

const PARSE_CASES: {
  name: string;
  source: string;
  defaults?: Record<string, string>;
  expansion: string;
  names: string[];
}[] = [
  { name: 'plain', source: 'hello', expansion: 'hello', names: [] },
  { name: 'one-field', source: 'Review <change>.', expansion: 'Review <change>.', names: ['change'] },
  {
    name: 'two-fields',
    source: 'Review <change> for <concern>.',
    expansion: 'Review <change> for <concern>.',
    names: ['change', 'concern'],
  },
  {
    name: 'same-name-together',
    source: '<x> and <x>',
    expansion: '<x> and <x>',
    names: ['x'],
  },
  { name: 'vec-t', source: 'Vec<T>', expansion: 'Vec<T>', names: [] },
  { name: 'html-escape', source: '<<div>', expansion: '<div>', names: [] },
  { name: 'escape-lt', source: 'a << b', expansion: 'a < b', names: [] },
  { name: 'crlf', source: 'a\r\n<b>\r\n', expansion: 'a\r\n<b>\r\n', names: ['b'] },
  { name: 'file-body', source: 'From file: <name>', expansion: 'From file: <name>', names: ['name'] },
  { name: 'uppercase-t', source: 'see <T>', expansion: 'see <T>', names: [] },
  { name: 'close-div', source: '</div>', expansion: '</div>', names: [] },
  { name: 'html-attr', source: '<div class=', expansion: '<div class=', names: [] },
  {
    name: 'default',
    source: 'Review <change>.',
    defaults: { change: 'this change' },
    expansion: 'Review this change.',
    names: ['change'],
  },
  {
    name: 'default-holds-shortcut',
    source: '<body>',
    defaults: { body: 'run tst please' },
    expansion: 'run tst please',
    names: ['body'],
  },
  {
    name: 'default-holds-placeholder',
    source: '<body>',
    defaults: { body: 'see <field>' },
    expansion: 'see <field>',
    names: ['body'],
  },
  { name: 'underscore', source: '<change_id>', expansion: '<change_id>', names: ['change_id'] },
  { name: 'hyphen', source: '<change-id>', expansion: '<change-id>', names: ['change-id'] },
  { name: 'digit-in-name', source: '<a1>', expansion: '<a1>', names: ['a1'] },
  { name: 'leading-digit', source: '<1a>', expansion: '<1a>', names: [] },
  { name: 'empty-angles', source: '<>', expansion: '<>', names: [] },
  { name: 'trailing-lt', source: 'foo <', expansion: 'foo <', names: [] },
  { name: 'escaped-placeholder', source: '<<change>', expansion: '<change>', names: [] },
  { name: 'field-at-start', source: '<x> rest', expansion: '<x> rest', names: ['x'] },
  { name: 'field-at-end', source: 'rest <x>', expansion: 'rest <x>', names: ['x'] },
  { name: 'only-field', source: '<x>', expansion: '<x>', names: ['x'] },
  { name: 'a-b-c', source: 'a<b>c', expansion: 'a<b>c', names: ['b'] },
  { name: 'mixed-generic', source: 'Vec<T> and <item>', expansion: 'Vec<T> and <item>', names: ['item'] },
  { name: 'triple-lt', source: '<<<x>', expansion: '<<x>', names: ['x'] },
  { name: 'field-then-gt', source: '<x>>', expansion: '<x>>', names: ['x'] },
  { name: 'html-escaped-attr', source: '<<div class="x">', expansion: '<div class="x">', names: [] },
  { name: 'see-escaped-t', source: 'see <<T>', expansion: 'see <T>', names: [] },
  { name: 'empty-default', source: '<x>', defaults: { x: '' }, expansion: '', names: ['x'] },
  { name: 'unused-default', source: 'plain', defaults: { x: 'nope' }, expansion: 'plain', names: [] },
  { name: 'newline-default', source: '<x>', defaults: { x: 'a\nb' }, expansion: 'a\nb', names: ['x'] },
  { name: 'concern-sentence', source: 'Pay <concern>.', expansion: 'Pay <concern>.', names: ['concern'] },
  { name: 'name-32', source: `<${'a'.repeat(32)}>`, expansion: `<${'a'.repeat(32)}>`, names: ['a'.repeat(32)] },
  { name: 'name-33-literal', source: `<${'a'.repeat(33)}>`, expansion: `<${'a'.repeat(33)}>`, names: [] },
  {
    name: 'sixteen-fields',
    source: Array.from({ length: 16 }, (_, i) => `<f${i.toString(16)}>`).join(''),
    expansion: Array.from({ length: 16 }, (_, i) => `<f${i.toString(16)}>`).join(''),
    names: Array.from({ length: 16 }, (_, i) => `f${i.toString(16)}`),
  },
  {
    name: 'seventeenth-literal',
    source: `${Array.from({ length: 16 }, (_, i) => `<a${i}>`).join('')}<z>`,
    expansion: `${Array.from({ length: 16 }, (_, i) => `<a${i}>`).join('')}<z>`,
    names: Array.from({ length: 16 }, (_, i) => `a${i}`),
  },
  { name: 'space-in-angles', source: '<not a field>', expansion: '<not a field>', names: [] },
];

test('parse fixture 40/40: Vec<T>, HTML, <<, CRLF, file body stay literal or become fields', () => {
  assert.equal(PARSE_CASES.length, 40);
  for (const c of PARSE_CASES) {
    const parsed = parseTemplate(c.source, c.defaults ?? {});
    assert.equal(parsed.expansion, c.expansion, c.name);
    assert.deepEqual([...parsed.names], c.names, c.name);
  }
});

test('a bad field setting does not drop the other shortcuts in the file', () => {
  // Fail-open per entry: the sibling still loads (E3).
  const compiled = compileShortcuts({
    replacements: [
      { shortcut: 'ok', text: 'Review <change>.', origin: 'user', fields: { change: { default: 'x' } } },
      { shortcut: 'plain', text: 'hi', origin: 'user' },
    ],
  });
  assert.equal(compiled.inline.entries.ok, 'Review x.');
  assert.equal(compiled.inline.entries.plain, 'hi');
});

const HOSTILE_DEFAULTS = [
  'a\u0000b',
  'a\u0007b',
  'a\u001bb',
  'a\u007fb',
  'a\u0085b',
  'a\u202eb',
  'a\u202db',
  'a\u2066b',
  'a\ud800b',
  'a\udfffb',
  '\u202aX',
  'a\u0008b',
  'a\u001fb',
  'a\u009fb',
  'a\u0002b',
  'a\u0003b',
  '\u202b',
  '\u202cX',
  'ok\u0001',
  'a\u2067b',
];

test('literal safety: defaults with a shortcut or placeholder are not re-expanded; unsafe defaults are refused', async () => {
  const compiled = compileShortcuts({
    replacements: [
      { shortcut: 'tst', text: 'EXPANDED', origin: 'user' },
      {
        shortcut: 'tmpl',
        text: 'Go <body> now',
        origin: 'user',
        fields: { body: { default: 'run tst please and <field>' } },
      },
    ],
  });
  assert.equal(compiled.inline.entries.tmpl, 'Go run tst please and <field> now');
  const h = await createHarness({ plugins: [shortcutsPlugin(compiled)] });
  await h.driver.type('tmpl ');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 'Go run tst please and <field> now ');
  assert.equal(h.adapter.getDraft().text.includes('EXPANDED'), false);
  await h.session?.dispose();

  assert.equal(HOSTILE_DEFAULTS.length, 20);
  for (const raw of HOSTILE_DEFAULTS) {
    const parsed = parseTemplate('<x>', { x: raw });
    assert.equal(parsed.expansion, '<x>', JSON.stringify(raw));
  }
});

const TEMPLATES: Record<string, string> = {
  t0: 'A <a0> B',
  t1: 'X <a> Y <b> Z',
  t2: '<only>',
  t3: 'p <one> q <two> r <three>',
  t4: 'same <n> and <n>',
  t5: 'Review <change> for <concern>.',
  t6: 'hi <name>',
  t7: '<x><y>',
  t8: 'end <z>',
  t9: 'Lead <a> mid <b> tail',
};

async function expandOn(host: 'pi' | 'opencode' | 'codex' | 'claude', entries: Record<string, string>, typed: string) {
  const profile = HOST_CAPS[host];
  const compiled = compileShortcuts({ replacements: seeds(entries), ...profile.compile });
  const clock = createManualClock();
  const adapter = new ReferenceAdapter({
    clock,
    host: { name: host, version: '0' },
    caps: profile.caps,
  });
  const h = await createHarness({
    adapter,
    plugins: [shortcutsPlugin(compiled, { ...profile.compile, host })],
  });
  await h.driver.type(typed);
  await h.driver.settle();
  return h;
}

test('field walk: Tab visits every field in order on Pi, OpenCode and Codex (10 templates)', async () => {
  for (const host of ['pi', 'opencode', 'codex'] as const) {
    for (const [name, text] of Object.entries(TEMPLATES)) {
      const h = await expandOn(host, { [name]: text }, `${name} `);
      const parsed = parseTemplate(text);
      assert.ok(parsed.names.length > 0, name);
      const first = parsed.fields[0];
      assert.ok(first);
      assert.equal(h.adapter.getDraft().cursor, first.from, `${host} ${name} lands on first field`);
      for (let i = 1; i < parsed.names.length; i++) {
        const routing = await h.driver.key('Tab');
        await h.driver.settle();
        assert.equal(routing, 'consume', `${host} ${name} tab ${i}`);
        const field = parsed.fields.find((f) => f.name === parsed.names[i]);
        assert.ok(field);
        assert.deepEqual(h.adapter.highlight, [[field.from, field.to]], `${host} ${name} field ${parsed.names[i]}`);
      }
      const extra = await h.driver.key('Tab');
      assert.equal(extra, 'consume', `${host} ${name} last tab consumed`);
      await h.session?.dispose();
    }
  }
});

test('no send from a session: Enter and last Tab send 0 of 8 tries; multi-line stays in the draft', async () => {
  const text = 'Line <a>\nLine <b>\n';
  for (const host of ['pi', 'opencode', 'codex'] as const) {
    const h = await expandOn(host, { ml: text }, 'ml ');
    assert.equal(h.adapter.getDraft().text.includes('\n'), true);
    assert.equal(h.adapter.requests.length, 0);
    for (let i = 0; i < 8; i++) {
      const tab = await h.driver.key('Tab');
      assert.equal(tab, 'consume');
      await h.driver.settle();
    }
    const blocked = await h.driver.submit('send');
    assert.equal(blocked.action, 'block');
    assert.match(String('reason' in blocked ? blocked.reason : ''), /template field/);
    assert.equal(h.adapter.requests.length, 0);
    await h.session?.dispose();
  }
});

test('on OpenCode, Shift+Tab is not claimed during a field session (r11 O4)', async () => {
  const h = await expandOn('opencode', { t: 'A <a> B <b>' }, 't ');
  for (let i = 0; i < 10; i++) {
    const routing = await h.driver.key('Shift+Tab');
    assert.equal(routing, 'pass', `try ${i}`);
  }
  await h.session?.dispose();
});

test('Claude: inline expansion puts the cursor on the first field; unfilled warning 10/10 and 0/10 filled', async () => {
  for (let i = 0; i < 10; i++) {
    const h = await expandOn('claude', { t: 'Review <change> for <concern>.' }, 't ');
    const parsed = parseTemplate('Review <change> for <concern>.');
    assert.equal(h.adapter.getDraft().cursor, parsed.fields[0]?.from);
    const blocked = await h.driver.submit('send');
    assert.equal(blocked.action, 'block');
    assert.equal('reason' in blocked ? blocked.reason : '', unfilledMessage(2));
    await h.session?.dispose();
  }
  for (let i = 0; i < 10; i++) {
    const h = await expandOn('claude', { t: 'Review <change>.' }, 't ');
    // Fill by replacing the placeholder.
    const draft = h.adapter.getDraft();
    h.adapter.fill(draft.text.replace('<change>', 'the patch'), 'plugin', draft.text.length);
    await h.driver.settle();
    const sent = await h.driver.submit('send');
    assert.equal(sent.action, 'send', `filled ${i}`);
    await h.session?.dispose();
  }
});

test('immediate Backspace restores the shortcut on all four hosts', async () => {
  for (const host of ['pi', 'opencode', 'codex', 'claude'] as const) {
    const h = await expandOn(host, { rv: 'Review <change>.' }, 'rv ');
    assert.match(h.adapter.getDraft().text, /^Review /);
    await h.driver.key('Backspace');
    await h.driver.settle();
    assert.equal(h.adapter.getDraft().text, 'rv ', host);
    await h.session?.dispose();
  }
});

test('offerShortcut is a print-only seam and never writes', () => {
  const line = offerShortcut('please review this', 5);
  assert.match(line.status, /Used 5× — save as shortcut\? \(murmo shortcuts save\)/);
});
