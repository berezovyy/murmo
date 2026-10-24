// The Claude `register(on)` entry forwards prompt.edit and session.start (E21).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installTestPolicy } from '@murmo/plugin-autocorrect';
import { debugHost, register, resetHost } from '../src/register.ts';
import { CLASSIC_GUARD_TIMEOUT_MS, type PromptEditInput } from '../src/types.ts';
import { boot } from './boot.ts';
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
  const fallback = 'project shortcuts off: the Murmo helper is missing from this install (murmo doctor)';
  assert.deepEqual(host.notices, [fallback, 'murmo on · 1 shortcut · autocorrect off']);
  assert.equal(await tail(), fallback);
  await typeChars((event, next) => host.adapter.handleEdit(event, next), fake, 'hello');
  await host.adapter.handleSubmit({ text: fake.draft.text }, submitNext(fake));
  await host.session?.settle();
  assert.equal(await tail(), undefined, 'startup lines leave at the first send');
  resetHost();
});

test('the tail keeps the trust notice whole beside a long host hint (real-host bug)', async () => {
  // On the auto-mode footer Claude cut the untrusted-project notice before the
  // command: `.murmo.toml: 1 shortcut stays off … run "murmo tr…`.
  const { host } = await boot();
  const trust = '.murmo.toml has 1 shortcut. Run "murmo trust" to review.';
  host.adapter.showStatus(`${trust} | murmo on · 3 shortcuts · autocorrect off`, host.adapter.getDraft().version);
  host.adapter.measureHint('⏵⏵ auto mode on (shift+tab to cycle)');
  assert.equal(host.adapter.statusLine(), trust);
  host.adapter.measureHint('! for shell mode');
  assert.equal(host.adapter.statusLine(), `${trust} | murmo on · 3 shortcuts · autocorrect off`);
  await host.dispose();
});
