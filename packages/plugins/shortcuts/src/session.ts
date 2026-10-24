// Field-session state for a compiled template: remap ranges through ordered
// deltas, Tab / Shift+Tab / Esc, and the unfilled-field submit warning.

import type {
  Change,
  Draft,
  DraftDelta,
  Effect,
  HostName,
  KeyClaim,
  Origin,
  Plugin,
  PluginContext,
  Range,
  SubmitDecision,
  SubmitTransaction,
} from '@murmo/api';
import type { CompiledShortcuts, CompiledTemplate } from './compile.ts';
import { unfilledCount, unfilledMessage } from './fields.ts';

function uniqueTemplateNames(compiled: CompiledShortcuts): string[] {
  const names: string[] = [];
  for (const t of Object.values(compiled.templates)) {
    for (const n of t.names) if (!names.includes(n)) names.push(n);
  }
  return names;
}

export interface TemplateBox {
  compiled: CompiledShortcuts;
}

interface LiveField {
  name: string;
  from: number;
  to: number;
  original: string;
  pristine: boolean;
}

/**
 * The field the session put the cursor on. Its value is the first `lead` units;
 * typing at their end grows it. A field that still held its placeholder or
 * default starts with `lead` 0 and the old text after it, which is deleted on
 * the first typed key (hosts have no selection to type over); `done` once no
 * old text is left.
 */
interface Armed {
  readonly field: number;
  lead: number;
  done: boolean;
}

interface LiveSession {
  fields: LiveField[];
  names: string[];
  active: number;
  warned: boolean;
  armed: Armed | null;
}

export const DEFAULT_PREVIOUS_FIELD = 'Shift+Tab';

export function fieldClaims(previousKey: string, host: HostName): readonly KeyClaim[] {
  const claims: KeyClaim[] = [
    { key: 'Tab', when: ['editable', 'in-my-field-session'], action: 'dispatch', consume: true },
    { key: 'Escape', when: ['editable', 'in-my-field-session'], action: 'dispatch', consume: true },
  ];
  // OpenCode owns Shift+Tab as the agent switch (r11 O4).
  if (!(host === 'opencode' && previousKey === 'Shift+Tab')) {
    claims.splice(1, 0, {
      key: previousKey,
      when: ['editable', 'in-my-field-session'],
      action: 'dispatch',
      consume: true,
    });
  }
  return claims;
}

function expansionsOf(compiled: CompiledShortcuts): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [name, text] of Object.entries(compiled.inline.entries)) out[name] = text;
  for (const [name, text] of Object.entries(compiled.long)) out[name] = text;
  return out;
}

function templateForInsert(
  compiled: CompiledShortcuts,
  insert: string,
): { template: CompiledTemplate; expansion: string } | null {
  const expansions = expansionsOf(compiled);
  for (const [name, expansion] of Object.entries(expansions)) {
    if (expansion === insert && compiled.templates[name]) {
      return { template: compiled.templates[name] as CompiledTemplate, expansion };
    }
  }
  return null;
}

/**
 * A template's text found in the draft, for a session whose start was never
 * seen: a key typed right after the expansion cancels the call that would
 * have seen it, and history or a host menu can bring a template back. The text
 * around the fields must be there in order; what lies between is each field's
 * text now. Fields next to each other, or a template that starts with one,
 * leave nothing to find them by, so those must be there unchanged.
 */
function locate(text: string, expansion: string, template: CompiledTemplate): LiveSession | null {
  const fields = template.fields;
  if (!fields.length) return null;
  const literals: string[] = [];
  let end = 0;
  for (const f of fields) {
    literals.push(expansion.slice(end, f.from));
    end = f.to;
  }
  const tail = expansion.slice(end);
  const lead = literals[0] ?? '';
  if (!lead || literals.slice(1).some((l) => !l)) {
    const at = text.indexOf(expansion);
    return at < 0 ? null : startFrom(template, at);
  }
  for (let at = text.lastIndexOf(lead); at >= 0; at = at > 0 ? text.lastIndexOf(lead, at - 1) : -1) {
    const slots: Range[] = [];
    let pos = at + lead.length;
    for (let i = 0; i < fields.length; i++) {
      const next = i + 1 < fields.length ? (literals[i + 1] as string) : tail;
      const original = (fields[i] as (typeof fields)[number]).text;
      let stop: number;
      if (next) stop = text.indexOf(next, pos);
      else {
        // A template that ends in a field: up to its old text, else to the end of the line.
        const old = text.indexOf(original, pos);
        const line = text.indexOf('\n', pos);
        stop = old >= 0 && (line < 0 || old < line) ? old + original.length : line < 0 ? text.length : line;
      }
      if (stop < 0) break;
      slots.push([pos, stop]);
      pos = stop + next.length;
    }
    if (slots.length !== fields.length) continue;
    const live: LiveField[] = fields.map((f, i) => {
      const [from, to] = slots[i] as Range;
      return { name: f.name, from, to, original: f.text, pristine: text.slice(from, to) === f.text };
    });
    return { fields: live, names: [...template.names], active: 0, warned: false, armed: null };
  }
  return null;
}

function sessionFromDraft(compiled: CompiledShortcuts, text: string): LiveSession | null {
  const expansions = expansionsOf(compiled);
  let best: { session: LiveSession; length: number } | null = null;
  for (const [name, expansion] of Object.entries(expansions)) {
    const template = compiled.templates[name];
    if (!template || !expansion) continue;
    const session = locate(text, expansion, template);
    if (session && (!best || expansion.length > best.length)) best = { session, length: expansion.length };
  }
  return best?.session ?? null;
}

/**
 * One splice that turns `before` into `after`. Typing in a run of equal
 * characters is ambiguous, so an insertion or deletion is placed at `cursor`
 * when that explains the change; otherwise the common prefix and suffix decide.
 */
export function spliceBetween(before: string, after: string, cursor: number, origin: Origin): DraftDelta | null {
  if (before === after) return null;
  const grow = after.length - before.length;
  if (grow > 0 && cursor >= grow && cursor <= after.length) {
    const from = cursor - grow;
    if (after.slice(0, from) + after.slice(cursor) === before)
      return { origin, from, to: from, insert: after.slice(from, cursor) };
  }
  if (grow < 0 && cursor <= after.length) {
    const to = cursor - grow;
    if (before.slice(0, cursor) === after.slice(0, cursor) && before.slice(to) === after.slice(cursor)) {
      return { origin, from: cursor, to, insert: '' };
    }
  }
  const max = Math.min(before.length, after.length);
  let head = 0;
  while (head < max && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < max - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { origin, from: head, to: before.length - tail, insert: after.slice(head, after.length - tail) };
}

/**
 * The splices from the draft this plugin last saw to `change.draft`. A change
 * can arrive without the ones before it (a newer key cancels a call that has
 * not started), and some hosts report a cursor move or an edit's echo as one
 * splice over the whole text; both would lose the field ranges, so those are
 * replaced by the one splice the text itself shows.
 */
export function deltasSince(
  seen: { readonly version: number; readonly text: string } | null,
  change: Change,
): DraftDelta[] {
  const before = change.before?.text ?? '';
  const deltas = change.deltas ?? [];
  const contiguous =
    seen !== null && change.before !== undefined && change.before.version === seen.version && before === seen.text;
  const coarse = deltas.some(
    (d) => d.from === 0 && d.to === before.length && d.insert === change.draft.text && before.length > 0,
  );
  if (contiguous && !coarse) return [...deltas];
  const origin = deltas.length === 1 ? (deltas[0] as DraftDelta).origin : change.origin;
  const splice = spliceBetween(seen?.text ?? before, change.draft.text, change.draft.cursor, origin);
  return splice ? [splice] : [];
}

export function remapRange(range: Range, deltas: readonly DraftDelta[]): Range | null {
  let from = range[0];
  let to = range[1];
  for (const d of deltas) {
    const shift = d.insert.length - (d.to - d.from);
    if (d.to <= from) {
      from += shift;
      to += shift;
      continue;
    }
    if (d.from >= to) continue;
    if (d.origin === 'paste') return null;
    if (d.insert.length === 0 && d.from <= from && d.to >= to) return null;
    if (d.from >= from && d.to <= to) {
      to += shift;
      if (to <= from) return null;
      continue;
    }
    return null;
  }
  return from < to ? [from, to] : null;
}

export function remapFields(fields: readonly LiveField[], deltas: readonly DraftDelta[]): LiveField[] | null {
  const next: LiveField[] = [];
  for (const field of fields) {
    const mapped = remapRange([field.from, field.to], deltas);
    if (!mapped) return null;
    next.push({ ...field, from: mapped[0], to: mapped[1] });
  }
  return next;
}

function sessionEffects(session: LiveSession | null, version: number): Effect[] {
  if (!session) return [{ type: 'field-session', ranges: null, baseVersion: version }];
  return [
    {
      type: 'field-session',
      ranges: session.fields.map((f) => [f.from, f.to] as Range),
      active: indexOfName(session, session.names[session.active] ?? session.names[0] ?? ''),
      baseVersion: version,
    },
  ];
}

function indexOfName(session: LiveSession, name: string): number {
  const i = session.fields.findIndex((f) => f.name === name);
  return i < 0 ? 0 : i;
}

function startFrom(template: CompiledTemplate, at: number): LiveSession {
  const fields: LiveField[] = template.fields.map((f) => ({
    name: f.name,
    from: at + f.from,
    to: at + f.to,
    original: f.text,
    pristine: true,
  }));
  return { fields, names: [...template.names], active: 0, warned: false, armed: null };
}

/** The first field of each name, in name order: where Tab and Shift+Tab go. */
function stops(session: LiveSession): LiveField[] {
  const out: LiveField[] = [];
  for (const name of session.names) {
    const field = session.fields.find((f) => f.name === name);
    if (field) out.push(field);
  }
  return out;
}

/** The stop the cursor is in, else the last one before it (-1 when it is before every field). */
function stopAt(session: LiveSession, cursor: number): { index: number; inside: boolean } {
  const list = stops(session);
  let before = -1;
  for (let i = 0; i < list.length; i++) {
    const f = list[i] as LiveField;
    if (cursor >= f.from && cursor <= f.to) return { index: i, inside: true };
    if (f.to <= cursor) before = i;
  }
  return { index: before, inside: false };
}

/**
 * Maps one delta through the armed field (see `Armed`). Returns false when the
 * delta changes the old text some other way, so the caller remaps the field as
 * any other and drops the armed state.
 */
function throughArmed(field: LiveField, armed: Armed, d: DraftDelta): boolean {
  const boundary = field.from + armed.lead;
  const shift = d.insert.length - (d.to - d.from);
  // The old text went away: the field is what was typed.
  if (!armed.done && !d.insert && d.from === boundary && d.to === field.to && armed.lead > 0) {
    field.to = boundary;
    armed.done = true;
    return true;
  }
  // Typing, Backspace or a fix inside what was typed so far, or at its end.
  if (d.from >= field.from && d.to <= boundary) {
    armed.lead += shift;
    field.to += shift;
    return true;
  }
  if (d.to <= field.from) {
    field.from += shift;
    field.to += shift;
    return true;
  }
  return d.from >= field.to;
}

function emptyEdit(at: number, version: number, cursor: number): Effect {
  return {
    type: 'edit',
    edit: { from: at, to: at, insert: '', baseVersion: version, undoable: false, label: 'field', cursor },
  };
}

/**
 * Phase 34 seam: status copy for a repeated phrase. Writes nothing.
 */
export function offerShortcut(phrase: string, count: number): { readonly status: string } {
  const shown = phrase.length > 40 ? `${phrase.slice(0, 37)}…` : phrase;
  return { status: `Used ${count}× — save as shortcut? (murmo shortcuts save)${shown ? `  ${shown}` : ''}` };
}

export function createShortcutsHooks(
  box: TemplateBox,
  options: { readonly previousFieldKey?: string } = {},
): {
  readonly previousFieldKey: string;
  readonly onChange: NonNullable<Plugin['onChange']>;
  readonly onKey: NonNullable<Plugin['onKey']>;
  readonly onBeforeSubmit: NonNullable<Plugin['onBeforeSubmit']>;
} {
  const previousFieldKey = options.previousFieldKey ?? DEFAULT_PREVIOUS_FIELD;
  let live: LiveSession | null = null;
  /** A field session and hint are on screen; cleared with the session. */
  let shown = false;
  /** The draft the last `onChange` saw, to rebuild the splices of changes that never reached it. */
  let seen: { version: number; text: string } | null = null;
  /**
   * A session ended (Esc, a paste, a deleted field) and its text is the user's
   * now: it is not found in the draft again until the draft was emptied or a
   * template is inserted anew.
   */
  let quiet = false;

  // Tab can only move between fields where the host places the cursor; elsewhere
  // the session still tracks fields for the submit warning but claims no key.
  const navigable = (ctx: PluginContext): boolean => ctx.host.caps.edit.cursor === true;
  const backKey = (ctx: PluginContext): string | null =>
    ctx.host.name === 'opencode' && previousFieldKey === 'Shift+Tab' ? null : previousFieldKey;

  const hint = (session: LiveSession, ctx: PluginContext, cursor: number): string => {
    const list = stops(session);
    const n = Math.max(0, stopAt(session, cursor).index) + 1;
    const back = backKey(ctx);
    return `Template field ${n} of ${list.length}: Tab next${back ? `, ${back} back` : ''}, Esc done`;
  };

  const present = (session: LiveSession, ctx: PluginContext, version: number, cursor = ctx.draft.cursor): Effect[] => {
    if (!navigable(ctx)) return [];
    shown = true;
    const status: Effect = { type: 'status', text: hint(session, ctx, cursor), baseVersion: version };
    return [...sessionEffects(session, version), status];
  };

  const end = (version: number): Effect[] => {
    live = null;
    quiet = true;
    if (!shown) return [];
    shown = false;
    return [...sessionEffects(null, version), { type: 'status', text: null, baseVersion: version }];
  };

  /** The first typed key on a field the cursor was put on replaces its old text: delete what is left of it. */
  const replaceLeftover = (session: LiveSession, version: number): Effect[] => {
    const armed = session.armed;
    const field = armed ? session.fields[armed.field] : undefined;
    if (!armed || !field || armed.lead === 0 || armed.done) return [];
    const boundary = field.from + armed.lead;
    return [
      {
        type: 'edit',
        edit: { from: boundary, to: field.to, insert: '', baseVersion: version, undoable: false, label: 'field' },
      },
    ];
  };

  /** Same-name fields are filled together: copy the value being typed into the next copy that differs. */
  const syncCopies = (session: LiveSession, draft: Draft): Effect[] => {
    const armed = session.armed;
    const field = armed?.done ? session.fields[armed.field] : undefined;
    if (!armed || !field) return [];
    const value = draft.text.slice(field.from, field.to);
    if (!value) return [];
    const copy = session.fields.find(
      (f, i) => i !== armed.field && f.name === field.name && draft.text.slice(f.from, f.to) !== value,
    );
    if (!copy) return [];
    return [
      {
        type: 'edit',
        edit: {
          from: copy.from,
          to: copy.to,
          insert: value,
          baseVersion: draft.version,
          undoable: false,
          label: 'field',
        },
      },
    ];
  };

  const jump = (session: LiveSession, target: number, ctx: PluginContext): Effect[] => {
    const draft = ctx.draft;
    const list = stops(session);
    const index = Math.max(0, Math.min(target, list.length - 1));
    const field = list[index];
    if (!field) return [];
    session.active = session.names.indexOf(field.name);
    // A field still holding its placeholder or default is armed: the first typed
    // key replaces it. One that holds the user's text puts the cursor after it.
    const cursorAt = field.pristine ? field.from : field.to;
    const armed = session.armed;
    const old = armed ? session.fields[armed.field] : undefined;
    const slot = session.fields.indexOf(field);
    session.armed = field.pristine
      ? { field: slot, lead: 0, done: false }
      : { field: slot, lead: field.to - field.from, done: true };
    const effects = present(session, ctx, draft.version, field.from);
    if (armed && old && old !== field && armed.lead > 0 && !armed.done) {
      // The old text of the field being left goes in the same edit as the move.
      const boundary = old.from + armed.lead;
      const removed = old.to - boundary;
      const cursor = cursorAt >= old.to ? cursorAt - removed : cursorAt;
      effects.push({
        type: 'edit',
        edit: {
          from: boundary,
          to: old.to,
          insert: '',
          baseVersion: draft.version,
          undoable: false,
          label: 'field',
          cursor,
        },
      });
      return effects;
    }
    if (draft.cursor !== cursorAt) effects.push(emptyEdit(cursorAt, draft.version, cursorAt));
    return effects;
  };

  const remap = (session: LiveSession, deltas: readonly DraftDelta[]): boolean => {
    for (const d of deltas) {
      const armed = session.armed;
      for (let i = 0; i < session.fields.length; i++) {
        const field = session.fields[i] as LiveField;
        if (armed && i === armed.field && throughArmed(field, armed, d)) continue;
        if (armed && i === armed.field) session.armed = null;
        const mapped = remapRange([field.from, field.to], [d]);
        if (!mapped) return false;
        field.from = mapped[0];
        field.to = mapped[1];
      }
      // Typing anywhere else leaves the field, unless its old text is still waiting to go.
      const still = session.armed;
      const field = still ? session.fields[still.field] : undefined;
      if (still && field && d.origin === 'typed' && d.insert && (still.done || still.lead === 0)) {
        const end = d.from + d.insert.length;
        if (d.from < field.from || end > field.from + still.lead) session.armed = null;
      }
    }
    return true;
  };

  return {
    previousFieldKey,
    onChange(change: Change, ctx: PluginContext) {
      const draft = change.draft;
      const deltas = deltasSince(seen, change);
      seen = { version: draft.version, text: draft.text };
      if (live) {
        // An emptied draft (a send, a clear) leaves nothing to keep quiet about.
        const stop = (): Effect[] => {
          const effects = end(draft.version);
          if (!draft.text) quiet = false;
          return effects;
        };
        // An emptied box (a send, a clear) holds no template any more.
        if (!draft.text) return stop();
        if ((change.deltas ?? []).some((d) => d.origin === 'paste')) return stop();
        if (!remap(live, deltas)) return stop();
        for (const field of live.fields) {
          const now = draft.text.slice(field.from, field.to);
          if (field.pristine && now !== field.original) field.pristine = false;
        }
        const armed = live.armed;
        if (armed && armed.lead === 0 && !armed.done) {
          // The cursor left the armed field before anything was typed there.
          const field = live.fields[armed.field];
          if (field && draft.cursor !== field.from) live.armed = null;
        }
        const fix = replaceLeftover(live, draft.version);
        return [...present(live, { ...ctx, draft }, draft.version), ...(fix.length ? fix : syncCopies(live, draft))];
      }
      if (!draft.text) quiet = false;
      for (const delta of change.deltas ?? []) {
        if (delta.origin !== 'plugin' && delta.origin !== 'native-menu') continue;
        const hit = templateForInsert(box.compiled, delta.insert);
        if (!hit) continue;
        // Later splices of the same change (text typed after it) move it on.
        const session = startFrom(hit.template, delta.from);
        const later = (change.deltas ?? []).slice((change.deltas ?? []).indexOf(delta) + 1);
        if (!remap(session, later)) break;
        live = session;
        return begin(live, draft, ctx);
      }
      const fromDraft = quiet ? null : sessionFromDraft(box.compiled, draft.text);
      if (fromDraft) {
        live = fromDraft;
        return begin(live, draft, ctx);
      }
      return [];
    },
    onKey(key: string, ctx: PluginContext) {
      if (!live) return [];
      const draft = ctx.draft;
      if (key === 'Escape') return end(draft.version);
      const at = stopAt(live, draft.cursor);
      if (key === 'Tab') {
        // After the last field Tab stays in the session, so it never falls through to a send.
        const next = at.index + 1;
        if (next >= stops(live).length) return present(live, ctx, draft.version);
        return jump(live, next, ctx);
      }
      if (key === backKey(ctx)) {
        const previous = at.inside ? at.index - 1 : at.index;
        if (previous < 0) return present(live, ctx, draft.version);
        return jump(live, previous, ctx);
      }
      return [];
    },
    // A send lets the session be: the box the host empties after it ends the
    // session in onChange, with its hint, and a send refused later keeps it.
    // Only the bare record of a warning (no fields) goes.
    onBeforeSubmit(tx: SubmitTransaction): SubmitDecision {
      const names = live?.names ?? uniqueTemplateNames(box.compiled);
      const leftover = unfilledCount(tx.draft.text, names);
      if (leftover === 0) {
        if (live && !live.fields.length) live = null;
        return { action: 'send' };
      }
      if (!live?.warned) {
        if (live) live.warned = true;
        else {
          live = { fields: [], names, active: 0, warned: true, armed: null };
        }
        return { action: 'block', reason: unfilledMessage(leftover) };
      }
      if (!live.fields.length) live = null;
      return { action: 'send' };
    },
  };

  /**
   * A new session. The field the cursor is on is armed: at the start of an
   * untouched one (after an inline expansion), or right after text typed in
   * front of its old text when the start was missed.
   */
  function begin(session: LiveSession, draft: Draft, ctx: PluginContext): Effect[] {
    quiet = false;
    for (let i = 0; i < session.fields.length; i++) {
      const f = session.fields[i] as LiveField;
      const now = draft.text.slice(f.from, f.to);
      const typed = now.length - f.original.length;
      if (f.pristine && f.from === draft.cursor) session.armed = { field: i, lead: 0, done: false };
      else if (typed > 0 && now.endsWith(f.original) && draft.cursor === f.from + typed) {
        session.armed = { field: i, lead: typed, done: false };
      } else continue;
      break;
    }
    return [...present(session, { ...ctx, draft }, draft.version), ...replaceLeftover(session, draft.version)];
  }
}
