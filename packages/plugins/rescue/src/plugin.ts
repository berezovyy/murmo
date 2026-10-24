// Built-in draft rescue: idle save of the unsent draft as typed, never in
// private mode, delete on submit, Tab to restore. IO is injected (the
// store's drafts kind); nothing runs in the key handler beyond marking dirty.
//
// The offer is looked up before the session starts (`findOffer`, by the
// adapter wiring) because a hook can't wait on IO. It is shown whenever the
// prompt is empty, hidden while there is text, and ends only on Tab (restore)
// or Escape (dismiss).

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
  draftIsOfferable,
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
/**
 * A draft with fewer visible characters than this is not worth rescuing: a
 * stray key typed and deleted must not replace an older crash draft (the
 * save sweeps older snapshots of the project).
 */
export const MIN_SAVE_CHARS = 3;
/** Code points of the draft's first line shown in the offer. */
export const PREVIEW_CHARS = 40;

const CONFORMANCE_PROJECT = '0'.repeat(64);

export interface RescueOptions {
  readonly drafts: Drafts;
  readonly identity: DraftIdentity;
  readonly isPrivate?: () => boolean | Promise<boolean>;
  /**
   * The snapshot to offer, looked up with `findOffer` before the session
   * started: `activate` can't wait on IO. The plugin still takes the
   * liveness lock and cleans up in the background.
   */
  readonly offer?: DraftDocument;
}

function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function offerLine(capturedAt: number): string {
  return `Restore your last draft from ${clockTime(capturedAt)}? (Tab)`;
}

/**
 * The ghost line of the offer: says what Tab does and previews the first
 * line, so the prompt never looks as if the draft were already back.
 */
export function offerGhost(text: string): string {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
  const first = Array.from((lines[0] ?? '').trim().replace(/\s+/g, ' '));
  const cut = first.length > PREVIEW_CHARS;
  const preview = `${first.slice(0, PREVIEW_CHARS).join('')}${cut || lines.length > 1 ? '…' : ''}`;
  const more = lines.length > 1 ? ` (+${lines.length - 1} ${lines.length === 2 ? 'line' : 'lines'})` : '';
  return `Tab restores: ${preview}${more}`;
}

/**
 * The newest snapshot this session may offer, or undefined. Adapters call it
 * before the session starts; any store failure means no offer.
 */
export async function findOffer(
  drafts: Drafts,
  identity: DraftIdentity,
  now: number = Date.now(),
): Promise<DraftDocument | undefined> {
  try {
    const id = checkDraftIdentity(identity);
    const found = await drafts.findOfferable({ project: id.project, host: id.host, session: id.session, now });
    return found && draftIsOfferable(found, now) ? found : undefined;
  } catch {
    return undefined;
  }
}

const OVERSIZE_STATUS = 'Draft is over 64 KiB; not saved.';

/** Queues IO in order. Never rejects: a failed save or lookup must not become an unhandled rejection in the host. */
function enqueue(chain: { current: Promise<void> }, work: () => Promise<void>): Promise<void> {
  const run = chain.current.then(work, work).then(
    () => undefined,
    () => undefined,
  );
  chain.current = run;
  return run;
}

function offerEffects(version: number, snapshot: DraftDocument): Effect[] {
  return [
    { type: 'status', text: offerLine(snapshot.header.capturedAt), baseVersion: version },
    { type: 'ghost', text: offerGhost(snapshot.text), baseVersion: version },
  ];
}

function clearUi(version: number): Effect[] {
  return [
    { type: 'status', text: null, baseVersion: version },
    { type: 'ghost', text: null, baseVersion: version },
  ];
}

/**
 * Tab can restore only where the host routes Tab to plugins and draws the
 * offer's ghost (the claim needs it on screen). Elsewhere the draft is still
 * saved, but an offer that names Tab would be a lie.
 */
function canOffer(ctx: PluginContext): boolean {
  const caps = ctx.host.caps;
  return caps.ghost !== 'none' && caps.keys.includes('Tab');
}

/**
 * A draft rescue can put back exactly. Not one whose text folds host parts
 * (a collapsed paste's label): restoring would type the label, not the paste.
 * Such a draft keeps the last whole save rather than replacing or deleting it.
 */
function savable(draft: Draft): boolean {
  if ((draft.foldedParts?.length ?? 0) > 0) return false;
  return draft.certainty === 'authoritative' || draft.certainty === 'tracked';
}

/** Enough visible text to be worth rescuing. */
function worthKeeping(text: string): boolean {
  let visible = 0;
  for (const ch of text) {
    if (ch.trim().length === 0) continue;
    if (++visible >= MIN_SAVE_CHARS) return true;
  }
  return false;
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
  /** The pending offer: kept until Tab restores it or Escape dismisses it. */
  let snapshot: DraftDocument | undefined = options.offer;
  /** Whether the offer's status and ghost are on screen. */
  let painted = false;
  let started = false;

  const stopIdle = () => {
    cancelIdle?.();
    cancelIdle = undefined;
  };
  const stopEmpty = () => {
    cancelEmpty?.();
    cancelEmpty = undefined;
  };

  const paint = (ctx: PluginContext, version: number): Effect[] | undefined => {
    if (!snapshot || !canOffer(ctx)) return undefined;
    painted = true;
    return offerEffects(version, snapshot);
  };
  const unpaint = (version: number): Effect[] | undefined => {
    if (!painted) return undefined;
    painted = false;
    return clearUi(version);
  };

  const keepable = (draft: Draft | undefined): draft is Draft =>
    draft !== undefined && savable(draft) && worthKeeping(draft.text);

  const flush = (): void => {
    const time = clock;
    if (!time || suppressSave || !keepable(last)) return;
    if (attemptedRevision !== undefined && last.version === attemptedRevision) return;
    void enqueue(io, async () => {
      const current = last;
      if (suppressSave || !keepable(current)) return;
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

  /** Nothing worth keeping in the composer for 10 s while alive: a deliberate clear. */
  const scheduleEmpty = (ctx: PluginContext) => {
    if (cancelEmpty) return;
    cancelEmpty = ctx.clock.setTimer(() => {
      cancelEmpty = undefined;
      if (last && worthKeeping(last.text)) return;
      void enqueue(io, async () => {
        if (last && worthKeeping(last.text)) return;
        await drafts.delete(identity);
      });
    }, EMPTY_DELETE_MS);
  };

  /**
   * Lock and cleanup, once, off the hook: any `await` in a hook is cancelled
   * (the session ticket goes stale while fs runs). From the first change too,
   * so a host that cancels `activate` at startup still gets the lock.
   */
  const start = (ctx: PluginContext): void => {
    clock = ctx.clock;
    if (started) return;
    started = true;
    void enqueue(io, async () => {
      lock = await drafts.holdLock(identity);
      await drafts.cleanup(ctx.clock.wallTimeMs());
    });
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
      start(ctx);
      last = ctx.draft;
      if (ctx.draft.text.length === 0) return paint(ctx, ctx.draft.version);
      if (keepable(ctx.draft)) scheduleSave(ctx);
      else scheduleEmpty(ctx);
    },
    async onChange(change: Change, ctx: PluginContext) {
      start(ctx);
      last = change.draft;
      const version = change.draft.version;
      if (change.origin === 'plugin' && change.pluginId === RESCUE_ID) snapshot = undefined;
      if (change.draft.text.length === 0) {
        stopIdle();
        scheduleEmpty(ctx);
        return paint(ctx, version);
      }
      const effects: Effect[] = [...(unpaint(version) ?? [])];
      suppressSave = false;
      if (utf8Length(change.draft.text) > DRAFT_MAX_TEXT_BYTES) {
        stopIdle();
        stopEmpty();
        void enqueue(io, () => drafts.delete(identity));
        if (!oversizeNoted) {
          oversizeNoted = true;
          effects.push({ type: 'status', text: OVERSIZE_STATUS, baseVersion: version });
        }
        return effects;
      }
      if (!savable(change.draft)) {
        stopIdle();
        return effects;
      }
      if (worthKeeping(change.draft.text)) {
        stopEmpty();
        scheduleSave(ctx);
      } else {
        stopIdle();
        scheduleEmpty(ctx);
      }
      return effects;
    },
    onKey(key: string, ctx: PluginContext) {
      if (!snapshot || !painted || ctx.draft.text.length > 0) return;
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
        snapshot = undefined;
        return unpaint(ctx.draft.version);
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
      await lock?.release().catch(() => undefined);
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
