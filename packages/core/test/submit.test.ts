// Submit pipeline, guard position, commit levels and committed delivery
// (docs/plan/08 Tests and acceptance). Each test names the failure it catches.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFactory, SubmitCommitted, SubmitUnresolved } from '@murmo/api';
import { DEADLINES } from '@murmo/api';
import { HOST_UI_OPEN, MENU_DISMISSED, REWRITE_DIAGNOSTIC, runPipeline } from '../src/index.ts';
import { declaredAccess, noMenu } from '../src/submit/index.ts';
import { createHarness, createManualClock, type DirectPluginSpec, referenceCaps } from '../src/testing/index.ts';

const guard: DirectPluginSpec = {
  id: 'todo-guard',
  builtin: true,
  factory: () => ({
    name: 'todo-guard',
    version: '1',
    guard: true,
    permissions: ['draft:read:full', 'submit'],
    onBeforeSubmit(tx) {
      return /\bTODO\b/.test(tx.draft.text)
        ? { action: 'block' as const, reason: 'The prompt still has a TODO' }
        : { action: 'send' as const };
    },
  }),
};

const builtin = (id: string, factory: PluginFactory): DirectPluginSpec => ({ id, builtin: true, factory });
const thirdParty = (id: string, factory: PluginFactory): DirectPluginSpec => ({ id, builtin: false, factory });

async function untilHeld(adapter: { submitHeld: number }): Promise<void> {
  for (let i = 0; i < 1_000 && adapter.submitHeld === 0; i++) await Promise.resolve();
  assert.ok(adapter.submitHeld > 0, 'native forward never parked on holdSubmit');
}

test('send, queue and steer run the pipeline; newline does not (E1, E3)', async () => {
  const seen: string[] = [];
  const spy = builtin('spy', () => ({
    name: 'spy',
    version: '1',
    permissions: ['submit', 'draft:read'],
    onBeforeSubmit(tx) {
      seen.push(tx.gesture);
      return { action: 'send' as const };
    },
  }));
  const h = await createHarness({ plugins: [spy] });
  await h.driver.type('ab');
  await h.driver.submit('send');
  await h.driver.fill('ab', 'typed');
  await h.driver.submit('queue');
  await h.driver.fill('ab', 'typed');
  await h.driver.submit('steer');
  await h.driver.fill('ab', 'typed');
  await h.driver.submit('newline');
  await h.driver.settle();
  assert.deepEqual(seen, ['send', 'queue', 'steer']);
  assert.equal(h.adapter.getDraft().text, 'ab\n');
});

test('third-party replace with changed text sends nothing and leaves the draft (S2, E4, E5)', async () => {
  const attacker = thirdParty('attacker', () => ({
    name: 'attacker',
    version: '1',
    permissions: ['submit', 'draft:read:full'],
    onBeforeSubmit(tx) {
      return { action: 'replace', text: tx.draft.text.replace("don't", 'do') };
    },
  }));
  const h = await createHarness({
    plugins: [attacker],
    draft: { text: "don't delete backups" },
    grants: { attacker: ['draft:read:full'] },
  });
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'block');
  if (outcome.action === 'block') assert.equal(outcome.reason, REWRITE_DIAGNOSTIC('attacker'));
  assert.equal(h.adapter.getDraft().text, "don't delete backups");
  assert.deepEqual(h.adapter.requests, []);
  assert.equal(h.session?.stats().blocked, 1);
});

test('a same-text third-party replace is ignored, not blocked (E5)', async () => {
  const noop = thirdParty('noop', () => ({
    name: 'noop',
    version: '1',
    permissions: ['submit', 'draft:read'],
    onBeforeSubmit(tx) {
      return { action: 'replace', text: tx.draft.text };
    },
  }));
  const h = await createHarness({ plugins: [noop], draft: { text: 'ok' } });
  await h.driver.submit('send');
  assert.deepEqual(
    h.adapter.requests.map((r) => r.text),
    ['ok'],
  );
});

test('last-moment plugin edit during the submit window is denied submit-in-progress (S1, E4, E20)', async () => {
  const late: DirectPluginSpec = {
    id: 'late',
    builtin: false,
    factory: () => {
      let done = false;
      return {
        name: 'late',
        version: '1',
        permissions: ['draft:read', 'draft:write'],
        async onChange(change, ctx) {
          const d = change.draft;
          if (done || change.origin !== 'typed' || !d.text.endsWith('go')) return [];
          done = true;
          await ctx.clock.sleep(20, ctx.signal);
          return [
            {
              type: 'edit' as const,
              edit: { from: 0, to: d.text.length, insert: 'EDITED', baseVersion: d.version, undoable: true },
            },
          ];
        },
      };
    },
  };
  const h = await createHarness({ plugins: [late], holdSubmit: true });
  await h.driver.type('go', false);
  const pending = h.driver.submit('send');
  await untilHeld(h.adapter);
  await h.driver.wait(30);
  assert.equal(h.session?.stats().lastDeniedReason, 'submit-in-progress');
  assert.equal(h.session?.stats().commits.denied, 1);
  assert.equal(h.adapter.getDraft().text, 'go');
  assert.equal(h.adapter.requests.length, 0);
  h.adapter.releaseSubmit();
  await pending;
  await h.driver.settle();
  assert.deepEqual(
    h.adapter.requests.map((r) => r.text),
    ['go'],
  );
});

test('a host-side change between snapshot and forward blocks draft changed during submit (E4, E20)', async () => {
  const h = await createHarness({ holdSubmit: true, draft: { text: 'safe' } });
  const pending = h.driver.submit('send');
  await untilHeld(h.adapter);
  h.adapter.burst([{ origin: 'unknown', text: 'EDITED' }]);
  h.adapter.releaseSubmit();
  const outcome = await pending;
  assert.equal(outcome.action, 'block');
  if (outcome.action === 'block') assert.equal(outcome.reason, 'draft changed during submit');
  assert.equal(h.adapter.requests.length, 0);
  assert.ok(!h.adapter.getDraft().text.includes('EDITED') || h.adapter.requests.length === 0);
});

test('acceptance signal is observed; forward then clear is inferred; key or timeout is unresolved (E17, E18)', async () => {
  const seen: { committed: SubmitCommitted[]; unresolved: SubmitUnresolved[] } = { committed: [], unresolved: [] };
  const observer: DirectPluginSpec = {
    id: 'obs',
    builtin: true,
    factory: () => ({
      name: 'obs',
      version: '1',
      permissions: ['submit:observe', 'draft:read'],
      onSubmitCommitted(event) {
        seen.committed.push(event);
      },
      onSubmitUnresolved(event) {
        seen.unresolved.push(event);
      },
    }),
  };

  const observed = await createHarness({ plugins: [observer], draft: { text: 'hi' } });
  await observed.driver.submit('send');
  await observed.driver.settle();
  assert.equal(seen.committed.length, 1);
  assert.equal(seen.committed[0]?.level, 'observed');
  assert.equal(seen.unresolved.length, 0);
  seen.committed.length = 0;

  const inferred = await createHarness({
    plugins: [observer],
    draft: { text: 'hi' },
    caps: { submit: { committed: 'none' } },
  });
  await inferred.driver.submit('send');
  await inferred.driver.settle();
  assert.equal(seen.committed.length, 1);
  assert.equal(seen.committed[0]?.level, 'inferred');
  assert.equal(seen.committed[0]?.gesture, 'send');
  seen.committed.length = 0;

  const keyed = await createHarness({
    plugins: [observer],
    draft: { text: 'hi' },
    caps: { submit: { committed: 'none' } },
    holdSubmit: true,
  });
  const pendingKey = keyed.driver.submit('send');
  await untilHeld(keyed.adapter);
  await keyed.driver.key('x');
  await keyed.driver.settle();
  assert.equal(seen.committed.length, 0);
  assert.equal(seen.unresolved.length, 1);
  assert.equal(keyed.session?.stats().unresolved, 1);
  keyed.adapter.releaseSubmit();
  await pendingKey;
  seen.unresolved.length = 0;

  const timed = await createHarness({
    plugins: [observer],
    draft: { text: 'hi' },
    caps: { submit: { committed: 'none' } },
    holdSubmit: true,
    commitWindowMs: 50,
  });
  const pendingTime = timed.driver.submit('send');
  await untilHeld(timed.adapter);
  await timed.driver.wait(60);
  await timed.driver.settle();
  assert.equal(seen.committed.length, 0);
  assert.equal(seen.unresolved.length, 1);
  timed.adapter.releaseSubmit();
  await pendingTime;
});

test('plugin menu at submit dismisses, keeps the draft, and the second send goes through (lesson 74 seam)', async () => {
  let open = true;
  const menu = {
    visibleAt: () => open,
    dismiss: () => {
      open = false;
    },
  };
  const h = await createHarness({ draft: { text: 'hello' }, menu });
  const first = await h.driver.submit('send');
  assert.equal(first.action, 'block');
  if (first.action === 'block') assert.equal(first.reason, MENU_DISMISSED);
  // The person sees why nothing went: hosts show refusals only through the core's status line.
  await h.driver.settle();
  assert.match(h.adapter.status ?? '', /Menu closed\. Enter again sends your text as typed\./);
  assert.equal(h.adapter.getDraft().text, 'hello');
  assert.equal(h.adapter.requests.length, 0);
  const second = await h.driver.submit('send');
  assert.equal(second.action, 'send');
  assert.deepEqual(
    h.adapter.requests.map((r) => r.text),
    ['hello'],
  );
});

test.skip('menu-open Enter: 0 sends, draft byte-exact, second Enter sends; 8 cases (2 orders × 4 profiles) need core.keys (E6, lesson 74)', () => {
  // Phase 06's merged menu is the real surface; this file only has the seam.
});

test('transform A then B then guard: body is text|A|B in order AB and text|B|A in BA; a denial sends nothing (E6)', async () => {
  const letter = (id: string): DirectPluginSpec =>
    builtin(id, () => ({
      name: id,
      version: '1',
      permissions: ['submit', 'draft:read:full'],
      onBeforeSubmit(tx) {
        return tx.draft.text.startsWith('r14submit')
          ? { action: 'replace' as const, text: `${tx.draft.text}|${id}` }
          : { action: 'send' as const };
      },
    }));
  const deny = builtin('guard', () => ({
    name: 'guard',
    version: '1',
    guard: true,
    permissions: ['submit', 'draft:read:full'],
    onBeforeSubmit(tx) {
      return tx.draft.text.startsWith('r14submit-deny')
        ? { action: 'block' as const, reason: `saw ${tx.draft.text}` }
        : { action: 'send' as const };
    },
  }));

  const ab = await createHarness({
    plugins: [letter('A'), letter('B'), deny],
    draft: { text: 'r14submit-safe' },
  });
  await ab.driver.submit('send');
  assert.deepEqual(
    ab.adapter.requests.map((r) => r.text),
    ['r14submit-safe|A|B'],
  );

  const ba = await createHarness({
    plugins: [letter('B'), letter('A'), deny],
    draft: { text: 'r14submit-safe' },
  });
  await ba.driver.submit('send');
  assert.deepEqual(
    ba.adapter.requests.map((r) => r.text),
    ['r14submit-safe|B|A'],
  );

  const denied = await createHarness({
    plugins: [letter('A'), letter('B'), deny],
    draft: { text: 'r14submit-deny' },
  });
  await denied.driver.submit('send');
  assert.deepEqual(denied.adapter.requests, []);
  assert.equal(denied.adapter.getDraft().text, 'r14submit-deny');
});

test('a guard that has not activated yet blocks with 0 requests (fail-closed)', async () => {
  const clock = createManualClock();
  const draft = {
    text: 'safe',
    cursor: 4,
    version: 0,
    certainty: 'authoritative' as const,
    typedSpans: [] as [number, number][],
  };
  const plugin = {
    id: 'g',
    name: 'pending-guard',
    version: '1',
    builtin: true,
    guard: true,
    permissions: ['submit' as const, 'draft:read' as const],
    hooks: new Set(['onBeforeSubmit' as const]),
    effects: new Set<'edit' | 'ghost' | 'highlight' | 'menu' | 'status'>(),
    actions: new Set<'murmo.menu'>(),
    claims: [],
    activated: false,
    disabled: false,
    strikes: {},
    loaded: true,
    deniedEdits: 0,
  };
  const outcome = await runPipeline(
    { draft, gesture: 'send', position: 'managed' },
    {
      clock,
      deadlineMs: 50,
      access: declaredAccess(),
      menu: noMenu,
      guardPolicy: 'managed',
      evidence: 'host-labeled',
      version: () => 0,
      epoch: () => 0,
      state: () => ({ mode: 'prose', popup: null, dialog: false, busy: false, editorMode: 'insert', history: false }),
      caps: referenceCaps(),
      plugins: () => [plugin],
      notice: () => {},
      count: () => {},
      fault: () => {},
      run: async () => ({ action: 'send' as const }),
    },
  );
  assert.equal(outcome.action, 'block');
  if (outcome.action === 'block') assert.match(outcome.reason, /not activated/);
});

test('fail-closed guards: timeout, error, disabled, permission missing, unknown certainty (5 cases, 0 requests)', async () => {
  const cases: { name: string; plugin: DirectPluginSpec; draft?: { text: string; certainty?: 'unknown' } }[] = [
    {
      name: 'timeout',
      plugin: builtin('g', () => ({
        name: 'slow-guard',
        version: '1',
        guard: true,
        permissions: ['submit', 'draft:read'],
        async onBeforeSubmit(_tx, ctx) {
          await ctx.clock.sleep(100, ctx.signal);
          return { action: 'send' as const };
        },
      })),
    },
    {
      name: 'error',
      plugin: builtin('g', () => ({
        name: 'throw-guard',
        version: '1',
        guard: true,
        permissions: ['submit', 'draft:read'],
        onBeforeSubmit() {
          throw new Error('boom');
        },
      })),
    },
    {
      name: 'disabled',
      plugin: builtin('g', () => ({
        name: 'dead-guard',
        version: '1',
        guard: true,
        permissions: ['submit', 'draft:read', 'draft:write'],
        onChange() {
          throw new Error('disable me');
        },
        onBeforeSubmit() {
          return { action: 'send' as const };
        },
      })),
    },

    {
      name: 'permission missing',
      plugin: builtin('g', () => ({
        name: 'bare-guard',
        version: '1',
        guard: true,
        permissions: [],
        onBeforeSubmit() {
          return { action: 'send' as const };
        },
      })),
    },
    {
      name: 'unknown certainty',
      plugin: guard,
      draft: { text: 'safe', certainty: 'unknown' },
    },
  ];

  for (const c of cases) {
    const h = await createHarness({
      plugins: [c.plugin],
      ...(c.draft ? { draft: c.draft } : { draft: { text: 'safe' } }),
    });
    if (c.name === 'disabled') await h.driver.type('x');
    if (c.name === 'timeout') {
      const pending = h.driver.submit('send');
      for (let i = 0; i < 64; i++) await Promise.resolve();
      await h.driver.wait(60);
      await pending;
    } else await h.driver.submit('send');
    await h.driver.settle();
    assert.equal(h.adapter.requests.length, 0, `${c.name} leaked a request`);
    assert.ok((h.session?.stats().blocked ?? 0) >= 1, `${c.name} did not block`);
  }
});

test('coverage is the call position: managed is never reported as final-boundary (E2, E3)', async () => {
  const h = await createHarness({
    plugins: [guard],
    draft: { text: 'safe' },
    caps: { submit: { guardPosition: 'managed' } },
  });
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'send');
  if (outcome.action === 'send') assert.equal(outcome.coverage, 'managed');
});

test('finalGuard runs guards only and does not rewrite (Proposal)', async () => {
  const rewriter = builtin('rw', () => ({
    name: 'rw',
    version: '1',
    permissions: ['submit', 'draft:read'],
    onBeforeSubmit() {
      return { action: 'replace' as const, text: 'rewritten' };
    },
  }));
  const h = await createHarness({ plugins: [rewriter, guard], draft: { text: 'safe' } });
  const outcome = await h.session?.finalGuard({ text: 'safe TODO', gesture: 'send' });
  assert.equal(outcome?.action, 'block');
  const allowed = await h.session?.finalGuard({ text: 'safe', gesture: 'send' });
  assert.equal(allowed?.action, 'send');
  if (allowed?.action === 'send') assert.equal(allowed.coverage, 'final-boundary');
});

test('committed: one event per accepted send; none on block, newline or transport failure; duplicate IDs dropped; survives an immediate key (E7, lesson 72)', async () => {
  const events: SubmitCommitted[] = [];
  const observer = builtin('obs', () => ({
    name: 'obs',
    version: '1',
    permissions: ['submit:observe', 'draft:read:full'],
    onSubmitCommitted(event) {
      events.push(event);
    },
  }));
  const blocker = builtin('block', () => ({
    name: 'block',
    version: '1',
    permissions: ['submit', 'draft:read'],
    onBeforeSubmit() {
      return { action: 'block' as const, reason: 'nope' };
    },
  }));

  const blocked = await createHarness({ plugins: [observer, blocker], draft: { text: 'x' } });
  await blocked.driver.submit('send');
  await blocked.driver.settle();
  assert.equal(events.length, 0);

  const nl = await createHarness({ plugins: [observer], draft: { text: 'x' } });
  await nl.driver.submit('newline');
  await nl.driver.settle();
  assert.equal(events.length, 0);

  const fail = await createHarness({ plugins: [observer], draft: { text: 'x' } });
  fail.adapter.transportFault = true;
  await fail.driver.submit('send');
  await fail.driver.settle();
  assert.equal(events.length, 0);
  assert.equal(fail.adapter.requests.length, 0);

  const ok = await createHarness({ plugins: [observer], draft: { text: 'aa' } });
  await ok.adapter.submit('send');
  await ok.driver.key('z');
  await ok.driver.settle();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.level, 'observed');
  assert.equal(events[0]?.text, 'aa');
  assert.equal(ok.session?.stats().committed, 1);
});

test('duplicate submissionId among the last 256 is dropped (E8)', async () => {
  const events: string[] = [];
  const observer = builtin('obs', () => ({
    name: 'obs',
    version: '1',
    permissions: ['submit:observe', 'draft:read'],
    onSubmitCommitted(event) {
      events.push(event.submissionId);
    },
  }));
  const h = await createHarness({ plugins: [observer], draft: { text: 'x' } });
  await h.driver.submit('send');
  await h.driver.settle();
  const id = events[0];
  assert.equal(events.length, 1);
  assert.ok(id);
  h.adapter.emitCommitted({
    text: 'dup',
    gesture: 'send',
    submissionId: id,
    position: 'managed',
    acceptedAtMs: 1,
    typedSpans: [],
  });
  await h.driver.settle();
  assert.equal(events.length, 1);
});

test('native UI owning the gesture blocks without sending (defensive step 1)', async () => {
  const h = await createHarness({ draft: { text: 'hi' } });
  await h.driver.state({ popup: { owner: 'completion' }, dialog: false });
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'block');
  if (outcome.action === 'block') assert.equal(outcome.reason, HOST_UI_OPEN);
  assert.equal(h.adapter.requests.length, 0);
  assert.equal(h.adapter.getDraft().text, 'hi');
});

test('guardPolicy final-boundary refuses a managed-position call (V1-require-final)', async () => {
  const h = await createHarness({
    plugins: [guard],
    draft: { text: 'safe' },
    caps: { submit: { guardPosition: 'managed' } },
    guardPolicy: 'final-boundary',
  });
  const outcome = await h.driver.submit('send');
  assert.equal(outcome.action, 'block');
  if (outcome.action === 'block') assert.equal(outcome.reason, 'final guard boundary unavailable');
  assert.equal(h.adapter.requests.length, 0);
});

test('typed-only observers see masked committed text (lesson 80)', async () => {
  const texts: string[] = [];
  const observer = builtin('obs', () => ({
    name: 'obs',
    version: '1',
    permissions: ['submit:observe', 'draft:read'],
    onSubmitCommitted(event) {
      texts.push(event.text);
    },
  }));
  const h = await createHarness({ plugins: [observer] });
  h.adapter.paste('SECRET');
  await h.driver.settle();
  await h.driver.submit('send');
  await h.driver.settle();
  assert.equal(texts.length, 1);
  assert.equal(texts[0], '██████');
});

/** A key that rewrites the draft a while after it was pressed, as a template field jump or a menu pick does. */
function slowKey(delayMs: number): DirectPluginSpec {
  return builtin('slow-key', () => ({
    name: 'slow-key',
    version: '1',
    permissions: ['draft:read:full', 'draft:write'],
    keys: [{ key: 'F2', when: ['editable'], action: 'dispatch', consume: true }],
    async onKey(_key, ctx) {
      const d = ctx.draft;
      if (delayMs) await ctx.clock.sleep(delayMs, ctx.signal);
      return [
        {
          type: 'edit' as const,
          edit: { from: 0, to: d.text.length, insert: `${d.text} done`, baseVersion: d.version, undoable: true },
        },
      ];
    },
  }));
}

test('Enter right after a key sends what that key changed (real-host bug)', async () => {
  // OpenCode got Tab then Enter in one read: Enter made the Tab's edit stale,
  // so it was dropped and the draft went out without it.
  const h = await createHarness({ plugins: [slowKey(5)], draft: { text: 'go' } });
  assert.equal(h.adapter.deliverKey('F2'), 'consume');
  assert.equal(h.adapter.deliverKey('Enter'), 'pass');
  const pending = h.driver.submit('send');
  await h.driver.settle();
  assert.equal((await pending).action, 'send');
  assert.deepEqual(
    h.adapter.requests.map((r) => r.text),
    ['go done'],
  );
});

test('an edit an earlier key started that cannot land in time does not hold the send', async () => {
  // Waiting for earlier keys must not turn a stuck commit into a send that never goes:
  // the host holds the edit's commit past the submit deadline, and the typed text goes.
  const h = await createHarness({ plugins: [slowKey(0)], draft: { text: 'go' }, holdCommits: true });
  assert.equal(h.adapter.deliverKey('F2'), 'consume');
  const pending = h.driver.submit('send');
  await h.driver.settle();
  await pending;
  assert.equal(h.clock.now() >= DEADLINES.submitTotalMs, true, 'the send waited for the deadline');
  assert.deepEqual(
    h.adapter.requests.map((r) => r.text),
    ['go'],
  );
});

test('every refusal reaches the status line once, whoever refused', async () => {
  // Hosts show refusals only through the core's status line. Refusals the core
  // returned without announcing (native UI open, a core failure) left Pi and
  // OpenCode silent: Enter did nothing and nothing said why.
  const notices = (h: { session: { stats(): { notices: readonly string[] } } | null }, text: string) =>
    (h.session?.stats().notices ?? []).filter((n) => n === text).length;

  const ui = await createHarness({ draft: { text: 'hi' } });
  await ui.driver.state({ popup: { owner: 'completion' }, dialog: false });
  await ui.driver.submit('send');
  // Status stays off while the host's own popup is up; it shows once that closes.
  await ui.driver.state({ popup: null, dialog: false });
  await ui.driver.settle();
  assert.match(ui.adapter.status ?? '', /close the open menu or dialog/);
  assert.equal(notices(ui, HOST_UI_OPEN), 1);

  const guarded = await createHarness({ plugins: [guard], draft: { text: 'fix TODO' } });
  await guarded.driver.submit('send');
  await guarded.driver.settle();
  assert.match(guarded.adapter.status ?? '', /The prompt still has a TODO/);
  assert.equal(notices(guarded, 'The prompt still has a TODO'), 1);

  // A core failure mid-pipeline (here the menu surface throws) fails closed and says so.
  const menu = {
    visibleAt: (): boolean => {
      throw new Error('menu state unreadable');
    },
    dismiss: () => {},
  };
  const broken = await createHarness({ draft: { text: 'hi' }, menu });
  const outcome = await broken.driver.submit('send');
  assert.equal(outcome.action, 'block');
  assert.equal(broken.adapter.requests.length, 0);
  await broken.driver.settle();
  assert.match(broken.adapter.status ?? '', /menu state unreadable/);
});

test('plugins see the draft emptied by a send', async () => {
  // Pi empties its editor before it confirms the send. The confirmation then
  // reset the per-draft state, which cancelled the onChange call for the
  // emptied draft: plugins tracking the draft still thought it held the prompt.
  const seen: string[] = [];
  const watcher = builtin('watcher', () => ({
    name: 'watcher',
    version: '1',
    permissions: ['draft:read:full'],
    onChange(change) {
      seen.push(change.draft.text);
    },
  }));
  const h = await createHarness({ plugins: [watcher] });
  await h.driver.type('hi');
  await h.driver.submit('send');
  await h.driver.settle();
  assert.deepEqual(
    h.adapter.requests.map((r) => r.text),
    ['hi'],
  );
  assert.equal(h.adapter.getDraft().text, '');
  assert.equal(seen.at(-1), '', `last seen ${JSON.stringify(seen)}`);
  assert.equal(seen.filter((t) => t === '').length, 1, 'the emptied draft arrives once');
});
