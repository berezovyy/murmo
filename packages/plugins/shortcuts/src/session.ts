// Field-session state for a compiled template: remap ranges through ordered
// deltas, Tab / Shift+Tab / Esc, and the unfilled-field submit warning.

import type {
  Change,
  Draft,
  DraftDelta,
  Effect,
  HostName,
  KeyClaim,
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

interface LiveSession {
  fields: LiveField[];
  names: string[];
  active: number;
  warned: boolean;
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

function sessionFromDraft(compiled: CompiledShortcuts, text: string): LiveSession | null {
  const expansions = expansionsOf(compiled);
  let best: { template: CompiledTemplate; at: number; length: number } | null = null;
  for (const [name, expansion] of Object.entries(expansions)) {
    const template = compiled.templates[name];
    if (!template || !expansion) continue;
    const at = text.indexOf(expansion);
    if (at < 0) continue;
    if (!best || expansion.length > best.length) best = { template, at, length: expansion.length };
  }
  return best ? startFrom(best.template, best.at) : null;
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
  return { fields, names: [...template.names], active: 0, warned: false };
}

function cursorEdit(from: number, version: number): Effect {
  return {
    type: 'edit',
    edit: { from, to: from, insert: '', baseVersion: version, undoable: false, label: 'field' },
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

  const end = (version: number): Effect[] => {
    live = null;
    return sessionEffects(null, version);
  };

  const jump = (session: LiveSession, nameIndex: number, draft: Draft): Effect[] => {
    session.active = Math.max(0, Math.min(nameIndex, session.names.length - 1));
    const name = session.names[session.active];
    const field = session.fields.find((f) => f.name === name);
    const effects = sessionEffects(session, draft.version);
    if (field && draft.cursor !== field.from) effects.push(cursorEdit(field.from, draft.version));
    return effects;
  };

  return {
    previousFieldKey,
    onChange(change: Change) {
      const draft = change.draft;
      const deltas = change.deltas ?? [];
      if (live) {
        if (deltas.some((d) => d.origin === 'paste')) return end(draft.version);
        const mapped = remapFields(live.fields, deltas);
        if (!mapped) return end(draft.version);
        live.fields = mapped;
        for (const field of live.fields) {
          const now = draft.text.slice(field.from, field.to);
          if (field.pristine && now !== field.original) field.pristine = false;
        }
        return sessionEffects(live, draft.version);
      }
      for (const delta of deltas) {
        if (delta.origin !== 'plugin' && delta.origin !== 'native-menu') continue;
        const hit = templateForInsert(box.compiled, delta.insert);
        if (!hit) continue;
        live = startFrom(hit.template, delta.from);
        return sessionEffects(live, draft.version);
      }
      const fromDraft = sessionFromDraft(box.compiled, draft.text);
      if (fromDraft) {
        live = fromDraft;
        return sessionEffects(live, draft.version);
      }
      return [];
    },
    onKey(key: string, ctx: PluginContext) {
      if (!live) return [];
      const draft = ctx.draft;
      if (key === 'Escape') return end(draft.version);
      if (key === 'Tab') {
        const next = live.active + 1;
        if (next >= live.names.length) return sessionEffects(live, draft.version);
        return jump(live, next, draft);
      }
      if (key === previousFieldKey || key === 'Shift+Tab') {
        if (ctx.host.name === 'opencode' && previousFieldKey === 'Shift+Tab') return [];
        return jump(live, live.active - 1, draft);
      }
      return [];
    },
    onBeforeSubmit(tx: SubmitTransaction): SubmitDecision {
      const names = live?.names ?? uniqueTemplateNames(box.compiled);
      const leftover = unfilledCount(tx.draft.text, names);
      if (leftover === 0) {
        live = null;
        return { action: 'send' };
      }
      if (!live?.warned) {
        if (live) live.warned = true;
        else {
          live = { fields: [], names, active: 0, warned: true };
        }
        return { action: 'block', reason: unfilledMessage(leftover) };
      }
      live = null;
      return { action: 'send' };
    },
  };
}
