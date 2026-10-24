// Inline rules on the key path (phase 07): data only, `.` waits, bursts,
// commit acknowledgement, shortcut sizes, registration refusals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory } from '@murmo/api';
import type { InlineRules } from '@murmo/api/adapter';
import { encodeTable, mapTable, validateTable } from '@murmo/lang';
import { utf8Length } from '@murmo/text';
import {
  createInlineRewriter,
  InlineRegistrationError,
  openTable,
  receiptForTable,
  registerRuleSet,
} from '../src/index.ts';
import { createHarness, testInlinePlugin, testInlineRules } from '../src/testing/index.ts';

const factory: PluginFactory = () => ({
  name: 'autocorrect',
  version: '1',
  permissions: ['draft:read', 'draft:write'],
});

test('several typed typos in one chunk become three independent corrections (E4)', async () => {
  const h = await createHarness({ plugins: [testInlinePlugin('ac')] });
  await h.driver.burst([{ origin: 'typed', text: 'teh adn adress ' }]);
  assert.equal(h.adapter.getDraft().text, 'the and address ');
  assert.equal(h.session?.stats().inlineCorrections, 3);
  await h.driver.key('F6');
  assert.equal(h.adapter.getDraft().text, 'the and adress ');
  await h.driver.key('F6');
  assert.equal(h.adapter.getDraft().text, 'the adn adress ');
  await h.driver.key('F6');
  assert.equal(h.adapter.getDraft().text, 'teh adn adress ');
});

test('teh.🙂 confirms the pending dot; char.length === 1 would have skipped it (E17)', async () => {
  const h = await createHarness({ plugins: [testInlinePlugin('ac')] });
  await h.driver.type('teh.🙂');
  assert.equal(h.adapter.getDraft().text, 'the.🙂');
});

test('at a final boundary Enter after teh. sends teh.: the box cannot change first (E8, lesson 42)', async () => {
  // Catches a final-boundary send that differs from the text the host shows and sends.
  const h = await createHarness({ plugins: [testInlinePlugin('ac')] });
  await h.driver.type('teh.');
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'send');
  assert.deepEqual(
    h.adapter.requests.map((r) => r.text),
    ['teh.'],
  );
});

test('a fallback acknowledgement arms neither undo nor pending-dot (E21)', async () => {
  const h = await createHarness({ plugins: [testInlinePlugin('ac')] });
  h.adapter.inlineCommitStatus = 'fallback';
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'teh ');
  h.adapter.inlineCommitStatus = 'applied';
  await h.driver.key('Backspace');
  assert.equal(h.adapter.getDraft().text, 'teh');
  await h.driver.type(' ');
  assert.equal(h.adapter.getDraft().text, 'the ');
});

test('stale and cancelled acknowledgements also refuse to arm (E21)', async () => {
  for (const status of ['stale', 'cancelled'] as const) {
    const h = await createHarness({ plugins: [testInlinePlugin('ac')] });
    h.adapter.inlineCommitStatus = status;
    await h.driver.type('teh.');
    h.adapter.inlineCommitStatus = 'applied';
    await h.driver.type(' ');
    assert.equal(h.adapter.getDraft().text, 'teh. ', status);
  }
});

test('≤ 1,024 UTF-8 bytes expand inline; 1,025 bytes take the deferred path (E9)', async () => {
  const small = 'a'.repeat(1024);
  const large = 'a'.repeat(1025);
  const inline = await createHarness({
    plugins: [testInlinePlugin('ac', { replacements: { s: small } })],
  });
  await inline.driver.type('s ');
  assert.equal(inline.adapter.getDraft().text, `${small} `);
  assert.equal(inline.adapter.edits.length, 0, 'inline must not go through async edit');

  const deferred = await createHarness({
    plugins: [testInlinePlugin('ac', { replacements: { s: large } })],
  });
  await deferred.driver.type('s ');
  await deferred.driver.settle();
  assert.equal(deferred.adapter.getDraft().text, `${large} `);
  assert.equal(deferred.adapter.edits.length, 1, 'oversize shortcuts are versioned edits');
});

test('256 emoji (1,024 bytes) inline and 257 (1,028) deferred (E9)', async () => {
  const emoji = '\u{1F600}';
  assert.equal(utf8Length(emoji), 4);
  const n256 = emoji.repeat(256);
  const n257 = emoji.repeat(257);
  assert.equal(utf8Length(n256), 1024);
  assert.equal(utf8Length(n257), 1028);
  const a = await createHarness({ plugins: [testInlinePlugin('ac', { replacements: { s: n256 } })] });
  await a.driver.type('s ');
  assert.equal(a.adapter.getDraft().text, `${n256} `);
  assert.equal(a.adapter.edits.length, 0);
  const b = await createHarness({ plugins: [testInlinePlugin('ac', { replacements: { s: n257 } })] });
  await b.driver.type('s ');
  await b.driver.settle();
  assert.equal(b.adapter.getDraft().text, `${n257} `);
  assert.equal(b.adapter.edits.length, 1);
});

test('a 16,384-byte expansion applies as a deferred edit; newer typing cancels it (E9)', async () => {
  const huge = 'a'.repeat(16384);
  const applied = await createHarness({ plugins: [testInlinePlugin('ac', { replacements: { s: huge } })] });
  await applied.driver.type('s ');
  assert.equal(applied.adapter.getDraft().text, `${huge} `);
  assert.equal(applied.adapter.edits.length, 1);

  const h = await createHarness({ plugins: [testInlinePlugin('ac', { replacements: { s: huge } })] });
  h.adapter.holdCommits(true);
  await h.driver.type('s ');
  assert.equal(h.adapter.getDraft().text, 's ');
  await h.driver.type('z');
  h.adapter.releaseCommits();
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, 's z', 'typing before the deferred edit lands leaves the trigger');
});

test('an adapter cap of 900 bytes sends a 950-byte shortcut down the deferred path (E10)', async () => {
  const body = 'a'.repeat(950);
  const h = await createHarness({
    plugins: [testInlinePlugin('ac', { replacements: { s: body }, inlineMaxInsertBytes: 1024 })],
    caps: { inline: { maxBytes: 900 } },
  });
  await h.driver.type('s ');
  await h.driver.settle();
  assert.equal(h.adapter.getDraft().text, `${body} `);
  assert.equal(h.adapter.edits.length, 1, '900–1,024 must not pass natively unchanged');
});

test('next-key without a deferred ledger abstains; a matching ledger repairs (E21)', async () => {
  const h = await createHarness({
    plugins: [testInlinePlugin('ac')],
    caps: { inlineRewrite: 'next-key' },
  });
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'teh ', 'next-key is not burst correction');

  const repair = await createHarness({
    plugins: [testInlinePlugin('ac')],
    caps: { inlineRewrite: 'next-key' },
  });
  repair.adapter.fill('teh ', 'unknown');
  const now = repair.adapter.getDraft();
  repair.adapter.burst([], 'space', {
    before: { text: '', cursor: 0, version: 0, certainty: 'authoritative', typedSpans: [] },
    deltas: [{ origin: 'typed', from: 0, to: 0, insert: 'teh ' }],
    atVersion: now.version,
  });
  assert.equal(repair.adapter.getDraft().text, 'the ');
});

test('third-party specs, functions, a wrong owner and a bad hash are refused (E6, E11)', async () => {
  const bundle = testInlineRules('ac');
  const third = await createHarness({
    plugins: [{ id: 'ac', builtin: false, factory, inline: [bundle.rules], assets: bundle.assets }],
  });
  await third.driver.type('teh ');
  assert.equal(third.adapter.getDraft().text, 'teh ');
  assert.ok((third.session?.stats().notices ?? []).some((n) => /inline registration rejected/.test(n)));

  const owner = await createHarness({
    plugins: [{ id: 'other', builtin: true, factory, inline: [bundle.rules], assets: bundle.assets }],
  });
  assert.ok((owner.session?.stats().notices ?? []).some((n) => /inline registration rejected/.test(n)));

  const withFn = {
    ...bundle.rules,
    propose: () => null,
  } as InlineRules;
  const fn = await createHarness({
    plugins: [{ id: 'ac', builtin: true, factory, inline: [withFn], assets: bundle.assets }],
  });
  assert.ok((fn.session?.stats().notices ?? []).some((n) => /data only/.test(n)));

  assert.throws(
    () =>
      registerRuleSet(bundle.rules, {
        owner: 'ac',
        builtin: true,
        permissions: ['draft:read', 'draft:write'],
        assets: bundle.assets,
        transportMaxBytes: 1024,
        sha256: () => 'deadbeef',
      }),
    InlineRegistrationError,
  );
});

test('a refused inline rule set leaves the plugin’s async hooks running (E11)', async () => {
  let changes = 0;
  const h = await createHarness({
    plugins: [
      {
        id: 'ac',
        builtin: false,
        factory: () => ({
          name: 'ac',
          version: '1',
          permissions: ['draft:read', 'draft:write'],
          onChange() {
            changes++;
          },
        }),
        inline: [testInlineRules('ac').rules],
        assets: testInlineRules('ac').assets,
      },
    ],
  });
  await h.driver.type('a');
  assert.ok(changes > 0);
  assert.equal(h.session?.stats().disabled.length, 0);
});

test('mapTable with a receipt is well under 10 ms even for a large table (E12)', () => {
  const rows: [string, string][] = [];
  for (let i = 0; i < 8000; i++) {
    const key = `k${i.toString(36).padStart(4, '0')}`;
    rows.push([key, 'v']);
  }
  const bytes = encodeTable(rows);
  const receipt = receiptForTable(bytes, () => 'hash');
  validateTable(mapTable(bytes));
  const start = performance.now();
  for (let i = 0; i < 20; i++) openTable(bytes, receipt);
  const ms = (performance.now() - start) / 20;
  assert.ok(ms < 10, `session-start map was ${ms.toFixed(3)} ms`);
});

test('whole-word inline transaction p99 stays under 1.3 ms on Node (E15)', () => {
  const bundle = testInlineRules('ac');
  const rule = registerRuleSet(bundle.rules, {
    owner: 'ac',
    builtin: true,
    permissions: ['draft:read', 'draft:write'],
    assets: bundle.assets,
    transportMaxBytes: 16384,
  });
  const rewriter = createInlineRewriter(rule, true);
  const snapshot = {
    transactionId: '1',
    version: 0,
    text: '',
    cursor: 0,
    typedSpans: [] as const,
    certainty: 'authoritative' as const,
    origin: 'typed' as const,
    deltas: [{ origin: 'typed' as const, from: 0, to: 0, insert: 'teh ' }],
    key: { id: 'space', inputText: 'teh ', from: 0, to: 0 },
    state: {
      mode: 'prose' as const,
      popup: null,
      dialog: false,
      busy: false,
      editorMode: 'insert' as const,
      history: false,
    },
  };
  for (let i = 0; i < 30; i++) {
    rewriter.clear();
    rewriter.plan(snapshot);
  }
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    rewriter.clear();
    const start = performance.now();
    const answer = rewriter.plan(snapshot);
    samples.push(performance.now() - start);
    assert.equal(answer.action, 'replace');
    if (answer.action === 'replace') assert.equal(answer.text, 'the ');
  }
  samples.sort((a, b) => a - b);
  const p99 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))] ?? 0;
  assert.ok(p99 <= 1.3, `p99 ${p99.toFixed(3)} ms`);
});

test('the inline path records zero executor calls (lesson 46, E1)', async () => {
  const h = await createHarness({ plugins: [testInlinePlugin('ac')] });
  await h.driver.burst([{ origin: 'typed', text: 'teh adn adress ' }]);
  assert.equal(h.session?.stats().faults, 0);
  assert.equal(h.adapter.getDraft().text, 'the and address ');
});

test('protected vocabulary wins before the typo map', async () => {
  const h = await createHarness({ plugins: [testInlinePlugin('ac', { vocabulary: ['teh'] })] });
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'teh ');
});

test('shortcuts are checked before typos and never fire at `.`', async () => {
  const h = await createHarness({
    plugins: [testInlinePlugin('ac', { replacements: { teh: 'REVIEW' } })],
  });
  await h.driver.type('teh ');
  assert.equal(h.adapter.getDraft().text, 'REVIEW ');
  h.adapter.fill('', 'unknown');
  await h.driver.type('teh.ts');
  assert.equal(h.adapter.getDraft().text, 'teh.ts');
});

test('shortcut matching is exact: a declared rvw does not expand ;rvw (phase 15)', async () => {
  // Catches the prototype's extra "; plus a bare declared trigger" match.
  const h = await createHarness({
    plugins: [testInlinePlugin('ac', { replacements: { rvw: 'REVIEW' } })],
  });
  await h.driver.type(';rvw ');
  assert.equal(h.adapter.getDraft().text, ';rvw ');
  h.adapter.fill('', 'unknown');
  await h.driver.type('rvw ');
  assert.equal(h.adapter.getDraft().text, 'REVIEW ');
});
