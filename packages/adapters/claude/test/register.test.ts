// The Claude `register(on)` entry forwards prompt.edit and session.start (E21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTestPolicy } from '@murmo/plugin-autocorrect';
import { debugHost, register, resetHost } from '../src/register.ts';
import { HELPER_FALLBACK_NOTICE } from '../src/session.ts';
import { CLASSIC_GUARD_TIMEOUT_MS, type PromptEditInput } from '../src/types.ts';
import { FakeClaude, type NativeApply, submitNext, typeChars } from './fake-runtime.ts';

test('register hooks session.start, prompt.edit, classic guard and autocomplete', () => {
  resetHost();
  const fake = new FakeClaude();
  register(fake.on);
  const names = [...fake.hooks.keys()];
  assert.ok(names.includes('session.start'));
  assert.ok(names.includes('session.end'));
  assert.ok(names.includes('prompt.edit'));
  assert.ok(names.includes('prompt.submit'));
  assert.ok(names.includes('classic.UserPromptSubmit'));
  assert.ok(names.includes('prompt.autocomplete'));
  const classic = fake.hooks.get('classic.UserPromptSubmit')?.[0];
  assert.deepEqual(classic?.options, { timeout: CLASSIC_GUARD_TIMEOUT_MS });
  resetHost();
});

test('session.start returns alive with packed table so keyed teh rewrites (helper must not block)', async () => {
  resetHost();
  const fake = new FakeClaude({
    files: { '/config/murmo/murmo.toml': '[autocorrect]\nenabled = true\n' },
  });
  register(fake.on);
  const start = fake.hooks.get('session.start')?.[0]?.handler as (
    $: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<unknown>;
  await start(fake.$, {}, (event) => event);
  assert.equal(debugHost()?.alive, true);
  const edit = fake.hooks.get('prompt.edit')?.[0]?.handler as (
    $: unknown,
    event: PromptEditInput,
    next: NativeApply,
  ) => Promise<{ text: string; cursor: number }>;
  await typeChars((event, next) => edit(fake.$, event, next), fake, 'teh ');
  assert.equal(fake.draft.text, 'the ');
  resetHost();
  installTestPolicy();
});

test('the prompt hint tail says murmo is on and what it loaded, until the first send (real-host bug)', async () => {
  // Claude looked stock after install: the tail showed only when a project
  // notice existed, so nothing said Murmo was on, how many shortcuts it had,
  // or that autocorrect was off; and the notices it did show stayed all session.
  resetHost();
  const fake = new FakeClaude({
    files: { '/config/murmo/murmo.toml': 'version = 1\n[replace]\n";hi" = \'Hello\'\n' },
  });
  register(fake.on);
  const start = fake.hooks.get('session.start')?.[0]?.handler as (
    $: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<unknown>;
  await start(fake.$, {}, (event) => event);
  const render = fake.hooks
    .get('ui.render')
    ?.find((h) => (h.options as { component?: string } | undefined)?.component === 'PromptHint')?.handler as (
    $: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<{ props: { tail?: string } }>;
  const tail = async () =>
    (await render(fake.$, { component: 'PromptHint', props: { hint: '? for shortcuts' } }, (e) => e)).props.tail;
  const host = debugHost();
  assert.ok(host);
  // The fake has no helper, so the fallback comes first; at 120 columns the
  // hint row has room for it whole and not for the second line.
  const fallback = HELPER_FALLBACK_NOTICE;
  assert.deepEqual(host.notices, [fallback, 'murmo on · 1 shortcut · autocorrect off']);
  assert.equal(await tail(), fallback);
  await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, 'hello');
  await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
  await host.session?.settle();
  assert.equal(await tail(), undefined, 'startup lines leave at the first send');
  resetHost();
});

test('a status change asks Claude to redraw the prompt hint (real-host bug)', async () => {
  // On Claude 2.1.304 "Shortcut expanded. Backspace right after undoes it."
  // never appeared: the tail is read only when Claude renders PromptHint, and
  // nothing asked it to, so the startup lines stayed after every later key.
  resetHost();
  const fake = new FakeClaude({
    files: { '/config/murmo/murmo.toml': 'version = 1\n[replace]\n";hi" = \'Hello\'\n' },
  });
  register(fake.on);
  const start = fake.hooks.get('session.start')?.[0]?.handler as (
    $: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<unknown>;
  await start(fake.$, {}, (event) => event);
  const host = debugHost();
  assert.ok(host);
  fake.invalidated.length = 0;
  await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, ';hi ');
  await host.session?.settle();
  assert.equal(fake.draft.text, 'Hello ');
  assert.match(host.adapter.statusLine(), /^Shortcut expanded\./);
  assert.ok(fake.invalidated.includes('ui.render'), 'the new status is drawn without waiting for a host render');
  resetHost();
});

test('the tail keeps only whole rows beside the parts of the row Claude draws (real-host bug)', async () => {
  // Claude 2.1.306 at 120 columns in auto mode drew
  // `  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents · murmo on · 5 shortcut…  ◐ medium · /effort`:
  // the hint prop is only `(shift+tab to cycle) · ← for agents`, and the width
  // was a fixed 120, so a second row was budgeted and then cut mid-word.
  resetHost();
  const fake = new FakeClaude();
  register(fake.on);
  const start = fake.hooks.get('session.start')?.[0]?.handler as (
    $: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<unknown>;
  await start(fake.$, {}, (event) => event);
  const render = fake.hooks
    .get('ui.render')
    ?.find((h) => (h.options as { component?: string } | undefined)?.component === 'PromptHint')?.handler as (
    $: unknown,
    event: unknown,
    next: (event: unknown) => unknown,
  ) => Promise<{ props: { tail?: string } }>;
  const host = debugHost();
  assert.ok(host);
  const trust = '.murmo.toml has 1 shortcut. Run "murmo trust" to review.';
  const second = 'murmo on · 3 shortcuts · autocorrect off';
  host.adapter.notices.length = 0;
  host.adapter.showStatus(`${trust} | ${second}`, host.adapter.getDraft().version);
  const tail = async (hint: string, columns?: number) =>
    (
      await render(
        fake.$,
        { component: 'PromptHint', ...(columns ? { viewport: { columns, rows: 40 } } : {}), props: { hint } },
        (e) => e,
      )
    ).props.tail;
  assert.equal(await tail('(shift+tab to cycle) · ← for agents', 120), trust, 'no second row to cut');
  assert.equal(
    await tail('(shift+tab to cycle) · ← for agents', 200),
    `${trust} | ${second}`,
    'a wide terminal has room',
  );
  assert.equal(await tail('? for shortcuts', 80), trust, 'the first row stays whole; Claude ends it with …');
  assert.equal(await tail('? for shortcuts'), trust, 'no viewport: 120 columns');
  // The live case: the fallback and the summary, 82 columns, once budgeted as fitting.
  host.adapter.showStatus(`${HELPER_FALLBACK_NOTICE} | ${second}`, host.adapter.getDraft().version);
  assert.equal(await tail('(shift+tab to cycle) · ← for agents', 120), HELPER_FALLBACK_NOTICE);
  resetHost();
});
