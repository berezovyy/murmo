// Built-in draft rescue: idle save of the unsent draft as typed, never in
// private mode, delete on submit, Tab to restore. IO is injected (the
// store's drafts kind); nothing runs in the key handler beyond marking dirty.

import type {
  Change,
  Clock,
  Draft,
  Effect,
  Plugin,
  PluginContext,
  PluginFactory,
  SubmitCommitted,
  SubmitUnresolved,
} from '@murmo/api';
import {
  checkDraftIdentity,
  createMemoryDrafts,
  DRAFT_MAX_TEXT_BYTES,
  type DraftDocument,
  type DraftIdentity,
  type Drafts,
  type HeldDraftLock,
  utf8Length,
} from '@murmo/store';

export const RESCUE_ID = 'rescue';
export const RESCUE_VERSION = '1.0.0';
/** Idle delay after the last draft change (phase 17 decision). */
export const IDLE_MS = 500;
/** At most this often during continuous typing. */
export const MAX_INTERVAL_MS = 1000;
/** Empty composer this long, while the session lives, means a deliberate clear. */
export const EMPTY_DELETE_MS = 10_000;

const CONFORMANCE_PROJECT = '0'.repeat(64);

export interface RescueOptions {
  readonly drafts: Drafts;
  readonly identity: DraftIdentity;
  readonly isPrivate?: () => boolean | Promise<boolean>;
  /**
   * Snapshot to offer immediately from `activate` (no IO on that hook). The
   * plugin still takes the liveness lock and cleans up in the background.
   */
  readonly offer?: DraftDocument;
}

type Offer = 'none' | 'showing' | 'dismissed' | 'restored';

function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function offerLine(capturedAt: number): string {
  return `Restore your last draft from ${clockTime(capturedAt)}? (Tab)`;
}

const OVERSIZE_STATUS = 'Draft is over 64 KiB; not saved.';

function enqueue(chain: { current: Promise<void> }, work: () => Promise<void>): Promise<void> {
  const run = chain.current.then(work, work);
  chain.current = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function offerEffects(version: number, snapshot: DraftDocument): Effect[] {
  return [
    { type: 'status', text: offerLine(snapshot.header.capturedAt), baseVersion: version },
    { type: 'ghost', text: snapshot.text, baseVersion: version },
  ];
}

function clearUi(version: number): Effect[] {
  return [
    { type: 'status', text: null, baseVersion: version },
    { type: 'ghost', text: null, baseVersion: version },
  ];
}

function savable(draft: Draft): boolean {
  return draft.certainty === 'authoritative' || draft.certainty === 'tracked';
}

export function createRescue(options: RescueOptions): Plugin {
  const drafts = options.drafts;
  const identity = checkDraftIdentity(options.identity);
  const privateOf = options.isPrivate ?? (async () => false);

  const io = { current: Promise.resolve() };
  let lock: HeldDraftLock | undefined;
  let clock: Clock | undefined;
  let last: Draft | undefined;
  let lastSaveAt: number | undefined;
  let cancelIdle: (() => void) | undefined;
  let cancelEmpty: (() => void) | undefined;
  let suppressSave = false;
  let attemptedRevision: number | undefined;
  let oversizeNoted = false;
  let offer: Offer = 'none';
  let snapshot: DraftDocument | undefined;

  const stopIdle = () => {
    cancelIdle?.();
    cancelIdle = undefined;
  };
  const stopEmpty = () => {
    cancelEmpty?.();
    cancelEmpty = undefined;
  };

  const flush = (): void => {
    const time = clock;
    const draft = last;
    if (!time || !draft || suppressSave) return;
    if (draft.text.length === 0 || !savable(draft)) return;
    if (attemptedRevision !== undefined && draft.version === attemptedRevision) return;
    void enqueue(io, async () => {
      if (suppressSave) return;
      const current = last;
      if (!current || current.text.length === 0 || !savable(current)) return;
      if (attemptedRevision !== undefined && current.version === attemptedRevision) return;
      if (await privateOf()) {
        await drafts.delete(identity);
        return;
      }
      if (utf8Length(current.text) > DRAFT_MAX_TEXT_BYTES) {
        await drafts.delete(identity);
        return;
      }
      const result = await drafts.save(identity, {
        text: current.text,
        cursorUTF16: current.cursor,
        revision: current.version,
        now: time.wallTimeMs(),
      });
      if (result.status === 'ok') {
        lastSaveAt = time.now();
        attemptedRevision = undefined;
      }
    });
  };

  const scheduleSave = (ctx: PluginContext) => {
    stopIdle();
    if (suppressSave) return;
    const now = ctx.clock.now();
    const delay =
      lastSaveAt === undefined ? IDLE_MS : Math.min(IDLE_MS, Math.max(0, MAX_INTERVAL_MS - (now - lastSaveAt)));
    cancelIdle = ctx.clock.setTimer(() => {
      cancelIdle = undefined;
      flush();
    }, delay);
  };

  const scheduleEmpty = (ctx: PluginContext) => {
    stopEmpty();
    cancelEmpty = ctx.clock.setTimer(() => {
      cancelEmpty = undefined;
      if (last && last.text.length > 0) return;
      void enqueue(io, async () => {
        if (last && last.text.length > 0) return;
        await drafts.delete(identity);
      });
    }, EMPTY_DELETE_MS);
  };

  const plugin: Plugin = {
    name: RESCUE_ID,
    version: RESCUE_VERSION,
    permissions: ['draft:read:full', 'draft:write', 'submit:observe'],
    keys: [
      { key: 'Tab', when: ['ghost-visible-by-me', 'editable'], action: 'dispatch', consume: true },
      { key: 'Escape', when: ['ghost-visible-by-me', 'editable'], action: 'dispatch', consume: true },
    ],
    async activate(ctx: PluginContext) {
      clock = ctx.clock;
      last = ctx.draft;
      // Lock, cleanup and lookup are off this hook: any `await` here is
      // cancelled (the session ticket goes stale while fs runs; settle on a
      // manual clock also gives up). Offer effects must be returned without IO.
      void enqueue(io, async () => {
        lock = await drafts.holdLock(identity);
        await drafts.cleanup(clock?.wallTimeMs() ?? Date.now());
        if (snapshot || offer !== 'none') return;
        const found = await drafts.findOfferable({
          project: identity.project,
          host: identity.host,
          session: identity.session,
          now: clock?.wallTimeMs() ?? Date.now(),
        });
        if (found) snapshot = found;
      });
      if (ctx.draft.text.length > 0) {
        if (savable(ctx.draft)) scheduleSave(ctx);
        return;
      }
      const found = options.offer;
      if (!found) return;
      offer = 'showing';
      snapshot = found;
      return offerEffects(ctx.draft.version, found);
    },
    async onChange(change: Change, ctx: PluginContext) {
      clock = ctx.clock;
      last = change.draft;
      const version = change.draft.version;
      if (offer === 'showing' && change.draft.text.length > 0) {
        const restored = change.origin === 'plugin' && change.pluginId === RESCUE_ID;
        offer = restored ? 'restored' : 'dismissed';
        snapshot = undefined;
        if (!restored) {
          stopIdle();
          scheduleSave(ctx);
          return clearUi(version);
        }
        scheduleSave(ctx);
        return clearUi(version);
      }
      if (change.draft.text.length === 0 && snapshot && (offer === 'showing' || offer === 'none')) {
        offer = 'showing';
        return offerEffects(version, snapshot);
      }
      if (change.draft.text.length === 0) {
        stopIdle();
        scheduleEmpty(ctx);
        return;
      }
      stopEmpty();
      suppressSave = false;
      if (utf8Length(change.draft.text) > DRAFT_MAX_TEXT_BYTES) {
        stopIdle();
        void enqueue(io, () => drafts.delete(identity));
        if (oversizeNoted) return;
        oversizeNoted = true;
        return [{ type: 'status', text: OVERSIZE_STATUS, baseVersion: version }];
      }
      if (!savable(change.draft)) {
        stopIdle();
        return;
      }
      scheduleSave(ctx);
    },
    onKey(key: string, ctx: PluginContext) {
      if (offer !== 'showing' || ctx.draft.text.length > 0 || !snapshot) return;
      if (key === 'Tab') {
        return [
          {
            type: 'edit' as const,
            edit: {
              from: 0,
              to: 0,
              insert: snapshot.text,
              baseVersion: ctx.draft.version,
              undoable: true,
              label: 'restore',
            },
          },
        ];
      }
      if (key === 'Escape') {
        offer = 'dismissed';
        snapshot = undefined;
        return clearUi(ctx.draft.version);
      }
    },
    onSubmitCommitted(event: SubmitCommitted) {
      if (event.level !== 'observed' && event.level !== 'inferred') return;
      suppressSave = true;
      stopIdle();
      stopEmpty();
      void enqueue(io, () => drafts.delete(identity));
    },
    onSubmitUnresolved(_event: SubmitUnresolved) {
      attemptedRevision = last?.version;
      const at = clock?.wallTimeMs();
      void enqueue(io, () => drafts.markAttempted(identity, at));
    },
    async deactivate() {
      stopIdle();
      stopEmpty();
      await io.current;
      await lock?.release();
      lock = undefined;
    },
  };
  return plugin;
}

/** Built-in spec the session/host registers. */
export function rescuePlugin(options: RescueOptions): {
  readonly id: string;
  readonly builtin: true;
  readonly factory: PluginFactory;
} {
  return {
    id: RESCUE_ID,
    builtin: true,
    factory: () => createRescue(options),
  };
}

/**
 * Conformance/guest factory: memory drafts, no disk. Cases that need a real
 * crash buffer pass `rescuePlugin` with the store.
 */
export const rescueFactory: PluginFactory = () =>
  createRescue({
    drafts: createMemoryDrafts(),
    identity: { project: CONFORMANCE_PROJECT, host: 'fake', session: 'conformance' },
  });
