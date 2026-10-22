// Applying what a hook returned. Every effect is bound to its own
// `baseVersion` and is checked against the live session just before it
// applies; an edit that commits makes the rest of the same array stale, and
// the plugin recomputes from the next `onChange` (shared-v2 api.md, author
// clarification 10). Stale effects are dropped and counted, never queued
// (lesson 17). Menu effects go to the merged menu (phase 06).

import { type Effect, type EffectType, LIMITS, type Range, type ResultCode } from '@murmo/api';
import { EFFECT_ROUTES } from '@murmo/api/adapter';
import type { Edits } from './edits.ts';
import type { FieldSessions } from './fields.ts';
import type { PluginEntry } from './hooks.ts';
import type { Menu } from './menu.ts';
import type { Presentation } from './present.ts';
import { isCurrent, type SessionView, type Ticket } from './stale.ts';
import type { Counters } from './stats.ts';

export interface EffectDeps {
  readonly view: SessionView;
  readonly edits: Edits;
  readonly presentation: Presentation;
  readonly menu: Menu;
  readonly counters: Counters;
  readonly editable: () => boolean;
  readonly notice: (text: string) => void;
  readonly fields?: FieldSessions;
}

const effectTypes: ReadonlySet<string> = new Set(Object.keys(EFFECT_ROUTES));

/** The effect's type and version if it has the shape every effect shares, else null. */
function shapeOf(value: unknown): { type: EffectType; version: number } | null {
  const e = value as { type?: unknown; baseVersion?: unknown; edit?: { baseVersion?: unknown } } | null;
  if (!e || typeof e !== 'object' || typeof e.type !== 'string' || !effectTypes.has(e.type)) return null;
  const version = e.type === 'edit' ? e.edit?.baseVersion : e.baseVersion;
  if (!Number.isInteger(version)) return null;
  return { type: e.type as EffectType, version: version as number };
}

function count(counters: Counters, status: ResultCode): void {
  if (status === 'stale' || status === 'cancelled') counters.staleEffects++;
  else if (status === 'denied') counters.deniedEffects++;
  else if (status === 'unsupported') counters.unsupportedEffects++;
  else if (status === 'invalid-range' || status === 'error') counters.invalidEffects++;
}

/** Applies one hook result for a plugin, in order. Edit results are counted by the commit path. */
export async function applyEffects(
  plugin: PluginEntry,
  value: unknown,
  ticket: Ticket,
  deps: EffectDeps,
): Promise<void> {
  const { counters, view } = deps;
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    counters.invalidEffects++;
    return;
  }
  if (value.length > LIMITS.effectsPerCall) {
    throw Object.assign(new Error(`effect output limit: ${LIMITS.effectsPerCall}`), { code: 'output-limit' as const });
  }
  for (const item of value as unknown[]) {
    const shape = shapeOf(item);
    if (!shape) {
      counters.invalidEffects++;
      continue;
    }
    if (!plugin.effects.has(shape.type)) {
      counters.deniedEffects++;
      continue;
    }
    if (!isCurrent(ticket, view) || shape.version !== view.draft.version) {
      counters.staleEffects++;
      continue;
    }
    const effect = item as Effect;
    if (effect.type === 'edit') {
      await deps.edits.commit(plugin, effect.edit, ticket);
      continue;
    }
    count(counters, present(plugin, effect, deps));
  }
}

function present(plugin: PluginEntry, effect: Exclude<Effect, { type: 'edit' }>, deps: EffectDeps): ResultCode {
  const { presentation } = deps;
  switch (effect.type) {
    case 'status':
      return presentation.setStatus(plugin, effect.text);
    // Showing needs an editable draft; clearing is always allowed.
    case 'ghost':
      if (effect.text !== null && !deps.editable()) return 'denied';
      return presentation.setGhost(plugin, effect.text, effect.baseVersion);
    case 'highlight':
      if (effect.ranges?.length && !deps.editable()) return 'denied';
      return presentation.setHighlight(
        plugin,
        effect.ranges as readonly Range[] | null,
        effect.baseVersion,
        effect.marks,
      );
    case 'menu':
      if (effect.items !== null && effect.items.length > 0 && !deps.editable()) return 'denied';
      return deps.menu.setItems(plugin, effect.items, effect.baseVersion);
    case 'field-session': {
      deps.fields?.set(plugin.id, effect.ranges, effect.baseVersion, effect.active ?? 0);
      const picked = effect.ranges?.[effect.active ?? 0] ?? effect.ranges?.[0];
      const active = picked ? [picked] : null;
      if (active?.length && !deps.editable()) return 'denied';
      return presentation.setHighlight(plugin, active, effect.baseVersion);
    }
  }
}
