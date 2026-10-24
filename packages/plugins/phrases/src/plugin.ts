// Built-in `phrases` plugin: learn from onSubmitCommitted typed spans, ghost
// after the core's typing pause (`onPause`), Tab accepts, Esc hides, Enter
// never accepts. Lookup is the
// only work that may run on a key (E2); learning and rebuilds are idle.

import type {
  Change,
  Draft,
  Effect,
  HostName,
  MenuItem,
  Plugin,
  PluginContext,
  PluginFactory,
  PluginManifest,
  SubmitCommitted,
} from '@murmo/api';
import { learnFromCommitted } from './extract.ts';
import { type GhostRoute, ghostGates, ghostRoute, prefixCandidates } from './gates.ts';
import { firstGrapheme, makeVisible, sliceMatching, type VisibleGhost } from './ghost.ts';
import { createMemoryStore, type PhraseStore } from './memory.ts';
import { emptyMetrics, formatDoctorStats, type PhraseMetrics } from './metrics.ts';
import type { RankedPhrase } from './rank.ts';
import { resolvePhrasesSettings } from './settings.ts';

export const PHRASES_ID = 'phrases';
export const PHRASES_VERSION = '1.0.0';
export const DEFAULT_ROW_CELLS = 80;
export const PRIVATE_STATUS = 'Phrase learning is off (private mode).';

export const PHRASES_MANIFEST = {
  name: PHRASES_ID,
  version: PHRASES_VERSION,
  api: '^2.0.0',
  entry: 'plugin.mjs',
  permissions: [
    { name: 'draft:read', reason: 'See the words you type so a learned phrase can be offered as ghost text.' },
    { name: 'draft:read:full', reason: 'See an accepted ghost in the draft so it is not offered again.' },
    { name: 'draft:write', reason: 'Insert the visible ghost, or a menu-row fallback, as one undoable edit.' },
    { name: 'submit:observe', reason: 'Learn clauses only from a confirmed send, never from an unsent draft.' },
  ],
  capabilities: {
    required: {},
    optional: {
      ghost: 'end-only',
      menu: true,
      status: true,
      'edit.atomic': true,
      'edit.exactRestore': true,
    },
  },
  settingsSchema: {
    type: 'object',
    properties: {
      learn: { type: 'boolean', default: false, description: 'Opt-in. Off until [phrases] learn = true.' },
      ghost: {
        type: 'boolean',
        default: true,
        description: 'Show ghost text. Codex stays off unless the route is on.',
      },
      skipWhenBusy: { type: 'boolean', default: true, description: 'Do not show a ghost while the agent is busy.' },
    },
    additionalProperties: false,
  },
} as const satisfies PluginManifest;

export interface PhrasesOptions {
  readonly memory?: PhraseStore;
  readonly identity?: { readonly project: string; readonly host?: HostName; readonly session?: string };
  readonly isPrivate?: () => boolean | Promise<boolean>;
  readonly rowCells?: number;
  /** Persist learn events (Node log). Called off the key path. */
  readonly persist?: (events: readonly { phrase: string; host: string; project: string; at: number }[]) => void;
}

function clearEffects(version: number, route: GhostRoute): Effect[] {
  if (route === 'menu') return [{ type: 'menu', items: null, baseVersion: version }];
  return [{ type: 'ghost', text: null, baseVersion: version }];
}

function enqueue(chain: { current: Promise<void> }, work: () => Promise<void>): void {
  const run = chain.current.then(work, work);
  chain.current = run.then(
    () => undefined,
    () => undefined,
  );
}

function showEffects(route: GhostRoute, visible: VisibleGhost, ranked: RankedPhrase, draft: Draft): Effect[] {
  if (route === 'menu') {
    const item: MenuItem = {
      id: ranked.record.id,
      label: visible.visible,
      detail: ranked.record.phrase,
      inlineEdit: {
        baseVersion: draft.version,
        from: draft.cursor,
        to: draft.cursor,
        insert: visible.visible,
        undoable: true,
      },
    };
    return [{ type: 'menu', items: [item], baseVersion: draft.version }];
  }
  return [{ type: 'ghost', text: visible.visible, baseVersion: draft.version }];
}

export function createPhrasesPlugin(
  settingsInput: Readonly<Record<string, unknown>> = {},
  options: PhrasesOptions = {},
): Plugin {
  const settings = resolvePhrasesSettings(settingsInput);
  const memory = options.memory ?? createMemoryStore();
  const privateOf = options.isPrivate ?? (() => false);
  const rowCells = options.rowCells ?? DEFAULT_ROW_CELLS;
  const project = options.identity?.project ?? '0'.repeat(64);
  const persist = options.persist;
  const io = { current: Promise.resolve() };

  let shown: VisibleGhost | null = null;
  let shownRanked: RankedPhrase | null = null;
  /** Draft version the visible ghost was computed or sliced for. */
  let shownVersion = -1;
  let escHideText: string | null = null;
  let lastAccepted: string | null = null;

  const hide = (): void => {
    shown = null;
    shownRanked = null;
    shownVersion = -1;
  };

  const pick = (draft: Draft, host: HostName, now: number): { hit: RankedPhrase; prefix: string } | null => {
    for (const prefix of prefixCandidates(draft.text)) {
      const ranked = memory.lookup({ prefix, host, project, now });
      const hit = ranked[0];
      if (hit && hit.suffix.length > 0 && hit.record.phrase.startsWith(prefix)) return { hit, prefix };
    }
    return null;
  };

  const plugin: Plugin = {
    name: PHRASES_ID,
    version: PHRASES_VERSION,
    permissions: ['draft:read', 'draft:read:full', 'draft:write', 'submit:observe'],
    keys: [
      { key: 'Tab', when: ['ghost-visible-by-me', 'editable'], action: 'accept-ghost' },
      { key: 'Escape', when: ['ghost-visible-by-me', 'editable'], action: 'dispatch', consume: true },
    ],
    async activate(ctx: PluginContext) {
      if (!ctx.host.caps.status) return undefined;
      if (await privateOf()) return [{ type: 'status', text: PRIVATE_STATUS, baseVersion: ctx.draft.version }];
      return undefined;
    },
    onChange(change: Change, ctx: PluginContext) {
      const version = change.draft.version;
      const route = ghostRoute(ctx.host.name, settings, ctx.host.caps.ghost);
      const now = ctx.clock.wallTimeMs();

      const current = shown;
      const insertedGhost =
        current !== null &&
        (change.deltas?.some((d) => d.pluginId === PHRASES_ID && d.insert === current.visible) === true ||
          (change.origin === 'plugin' && change.pluginId === PHRASES_ID));
      const accepted = insertedGhost;
      if (accepted) {
        if (shown) {
          memory.recordAccept(shown.phrase, ctx.host.name, project, now);
          memory.metrics.charactersSaved += shown.visible.length;
          lastAccepted = shown.phrase;
        }
        hide();
        return clearEffects(version, route);
      }
      if (change.origin === 'undo') lastAccepted = null;

      const beforeText = change.before?.text ?? change.draft.text;
      const cursorOnly = (change.deltas?.length ?? 0) === 0 && change.draft.text === beforeText;
      if (!cursorOnly) escHideText = null;

      if (shown && !cursorOnly) {
        const delta = change.deltas?.[0];
        const typed = delta?.origin === 'typed' && delta.insert.length > 0 ? firstGrapheme(delta.insert) : null;
        const sliced = typed && delta && delta.insert === typed ? sliceMatching(shown.visible, typed) : null;
        if (sliced !== null && sliced.length > 0 && route === 'ghost') {
          shown = { ...shown, visible: sliced, suffix: sliced };
          shownVersion = version;
          return [{ type: 'ghost', text: sliced, baseVersion: version }];
        }
        memory.recordDismiss(shown.phrase, ctx.host.name, project, now);
        hide();
      }

      if (route === 'off') return undefined;
      if (shown && ghostGates({ draft: change.draft, state: ctx.state, settings, route }) !== 'ok') {
        hide();
        return clearEffects(version, route);
      }
      // A new ghost waits for the typing pause (`onPause`), never inside this hook.
      return undefined;
    },
    onPause(change: Change, ctx: PluginContext) {
      const route = ghostRoute(ctx.host.name, settings, ctx.host.caps.ghost);
      if (route === 'off') return undefined;
      const draft = ctx.draft;
      // `onChange` already slices a visible ghost as the user types into it.
      if (shown && shownVersion === change.draft.version) return undefined;
      if (escHideText !== null && draft.text === escHideText) return undefined;
      if (ghostGates({ draft, state: ctx.state, settings, route }) !== 'ok') {
        hide();
        return clearEffects(draft.version, route);
      }
      const picked = pick(draft, ctx.host.name, ctx.clock.wallTimeMs());
      const already =
        picked &&
        (picked.hit.record.phrase === lastAccepted ||
          draft.text === picked.hit.record.phrase ||
          draft.text.startsWith(`${picked.hit.record.phrase} `));
      const visible =
        picked && !already ? makeVisible(picked.hit.record.phrase, picked.prefix, draft.text, rowCells) : null;
      if (!picked || !visible) {
        hide();
        return clearEffects(draft.version, route);
      }
      if (ctx.signal.cancelled) {
        memory.metrics.staleDrops++;
        return undefined;
      }
      shown = visible;
      shownRanked = picked.hit;
      shownVersion = draft.version;
      memory.metrics.shown++;
      return showEffects(route, visible, picked.hit, draft);
    },
    onKey(key, ctx) {
      if (key !== 'Escape' || !shown) return;
      escHideText = ctx.draft.text;
      memory.recordDismiss(shown.phrase, ctx.host.name, project, ctx.clock.wallTimeMs());
      const route = ghostRoute(ctx.host.name, settings, ctx.host.caps.ghost);
      hide();
      return clearEffects(ctx.draft.version, route);
    },
    onMenuSelect(item: MenuItem, ctx: PluginContext) {
      const insert = item.inlineEdit?.insert ?? item.label;
      if (!insert) return;
      if (shownRanked) {
        memory.recordAccept(shownRanked.record.phrase, ctx.host.name, project, ctx.clock.wallTimeMs());
        memory.metrics.charactersSaved += insert.length;
      }
      hide();
      return [
        {
          type: 'edit',
          edit: {
            from: ctx.draft.cursor,
            to: ctx.draft.cursor,
            insert,
            baseVersion: ctx.draft.version,
            undoable: true,
            label: 'ghost',
          },
        },
      ];
    },
    async onSubmitCommitted(event: SubmitCommitted, ctx: PluginContext) {
      if (!settings.learn) return;
      if (await privateOf()) return;
      const result = learnFromCommitted(event, {
        certainty: ctx.draft.certainty,
        mode: ctx.state.mode,
      });
      if (result.skip || result.clauses.length === 0) return;
      const host = ctx.host.name;
      const at = event.acceptedAtMs ?? ctx.clock.wallTimeMs();
      const learned = result.clauses.map((phrase) => ({ phrase, host, project, at }));
      memory.learn(learned);
      if (persist) enqueue(io, async () => persist(learned));
    },
    async deactivate() {
      await io.current;
    },
  };
  return plugin;
}

export function doctorLine(metrics: PhraseMetrics = emptyMetrics(), extra?: string): string {
  return formatDoctorStats(metrics, extra);
}

export const phrasesFactory: PluginFactory = (settings) => createPhrasesPlugin(settings);

export default createPhrasesPlugin;

export function phrasesPlugin(
  options: PhrasesOptions = {},
  settings: Readonly<Record<string, unknown>> = {},
): {
  readonly id: string;
  readonly builtin: true;
  readonly factory: PluginFactory;
  readonly settings: Readonly<Record<string, unknown>>;
} {
  return {
    id: PHRASES_ID,
    builtin: true,
    factory: (resolved) => createPhrasesPlugin({ ...settings, ...resolved }, options),
    settings,
  };
}
