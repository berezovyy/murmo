// Built-in `history` plugin: record fully typed confirmed sends, search from
// `;?`, insert as one edit that never submits. No lookup while the menu is
// closed (E9). Search is debounced off the key handler (E9, lesson 32).

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
import { defaultCellMeasure } from '@murmo/plugin-shortcuts';
import { clipToCells, displayText } from '@murmo/text';
import { createMemoryStore, type HistoryStore, promptId } from './memory.ts';
import { emptyMetrics, formatDoctorStats, type HistoryMetrics } from './metrics.ts';
import type { RankedHit } from './rank.ts';
import { decideFromCommitted } from './record.ts';
import { searchIfOpen } from './search.ts';
import { resolveHistorySettings } from './settings.ts';
import { findHistoryTrigger, hostBlocksMenu } from './trigger.ts';

export const HISTORY_ID_PLUGIN = 'history';
export const HISTORY_VERSION = '1.0.0';
export const DEFAULT_ROW_CELLS = 80;
export const DEBOUNCE_MS = 16;
export const HISTORY_ROWS = 8;

export const HISTORY_MANIFEST = {
  name: HISTORY_ID_PLUGIN,
  version: HISTORY_VERSION,
  api: '^2.0.0',
  entry: 'plugin.mjs',
  permissions: [
    { name: 'draft:read', reason: 'See the ;? query you type so history can be filtered.' },
    { name: 'draft:write', reason: 'Insert a chosen prompt as one undoable edit that never submits.' },
    { name: 'submit:observe', reason: 'Record only a confirmed send of fully typed text.' },
  ],
  capabilities: {
    required: {},
    optional: { menu: true, status: true, 'edit.atomic': true, 'edit.exactRestore': true },
  },
  settingsSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: false,
        description: 'Opt-in. Off until [history] enabled = true.',
      },
    },
    additionalProperties: false,
  },
} as const satisfies PluginManifest;

export interface HistoryOptions {
  readonly memory?: HistoryStore;
  readonly identity?: { readonly project: string; readonly host?: HostName; readonly session?: string };
  readonly isPrivate?: () => boolean | Promise<boolean>;
  readonly persist?: (events: readonly { text: string; host: string; project: string; at: number }[]) => void;
  readonly debounceMs?: number;
  readonly rowCells?: number;
}

function enqueue(chain: { current: Promise<void> }, work: () => Promise<void>): void {
  const run = chain.current.then(work, work);
  chain.current = run.then(
    () => undefined,
    () => undefined,
  );
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return nl < 0 ? text : text.slice(0, nl);
}

function ageLabel(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatHit(
  hit: RankedHit,
  width: number,
  now: number,
  recordAt: number,
  host: string,
): { label: string; detail: string } {
  const line = displayText(firstLine(hit.text));
  const label = clipToCells(line, width, defaultCellMeasure);
  return { label, detail: `${host} · ${ageLabel(recordAt, now)}` };
}

export function createHistoryPlugin(
  settingsInput: Readonly<Record<string, unknown>> = {},
  options: HistoryOptions = {},
): Plugin {
  const settings = resolveHistorySettings(settingsInput);
  const memory = options.memory ?? createMemoryStore();
  const privateOf = options.isPrivate ?? (() => false);
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const rowCells = options.rowCells ?? DEFAULT_ROW_CELLS;
  const project = options.identity?.project ?? '0'.repeat(64);
  const persist = options.persist;
  const io = { current: Promise.resolve() };
  const live = settings.enabled === true;
  let revision = 0;
  const metrics = emptyMetrics();

  const close = (version: number): Effect[] => [{ type: 'menu', items: null, baseVersion: version }];

  const rowsOf = (
    hits: readonly RankedHit[],
    draft: Draft,
    start: number,
    now: number,
    native: boolean,
  ): MenuItem[] => {
    const items: MenuItem[] = [];
    for (const hit of hits.slice(0, HISTORY_ROWS)) {
      const rec = memory.records().find((r) => r.id === hit.id || r.text === hit.text);
      const host = rec?.events[rec.events.length - 1]?.host ?? '';
      const at = rec?.lastAt ?? now;
      const { label, detail } = formatHit(hit, rowCells, now, at, host);
      const id = `h:${promptId(hit.text)}`;
      const item: MenuItem = { id, label, detail };
      if (native) {
        items.push({
          ...item,
          inlineEdit: {
            baseVersion: draft.version,
            from: start,
            to: draft.cursor,
            insert: hit.text,
            undoable: true,
          },
        });
      } else items.push(item);
    }
    return items;
  };

  const plugin: Plugin = {
    name: HISTORY_ID_PLUGIN,
    version: HISTORY_VERSION,
    permissions: ['draft:read', 'draft:write', 'submit:observe'],
    async onChange(change: Change, ctx: PluginContext) {
      if (!live) return undefined;
      if (!ctx.host.caps.menu) return undefined;
      if (hostBlocksMenu(ctx.state)) return close(change.draft.version);
      const trigger = findHistoryTrigger(change.draft);
      if (!trigger) return close(change.draft.version);
      const token = ++revision;
      const q = trigger.query;
      if (debounceMs > 0) {
        await ctx.clock.sleep(debounceMs, ctx.signal);
        if (ctx.signal.cancelled || token !== revision) {
          metrics.staleDrops++;
          return undefined;
        }
      }
      const now = ctx.clock.wallTimeMs();
      metrics.searches++;
      const hits = searchIfOpen(true, memory, { query: q, project, host: ctx.host.name, now });
      const native = ctx.host.caps.inline.nativeCompletion;
      const items = rowsOf(hits, ctx.draft, trigger.start, now, native);
      return [{ type: 'menu', items, baseVersion: ctx.draft.version }];
    },
    onMenuSelect(item: MenuItem, ctx: PluginContext) {
      if (!live) return undefined;
      if (ctx.host.caps.inline.nativeCompletion) {
        if (item.inlineEdit?.insert) metrics.inserts++;
        return [];
      }
      if (!item.id.startsWith('h:')) return undefined;
      const trigger = findHistoryTrigger(ctx.draft);
      if (!trigger) return undefined;
      const hit = memory.records().find((r) => `h:${promptId(r.text)}` === item.id);
      const insert = hit?.text ?? item.inlineEdit?.insert;
      if (!insert) return undefined;
      metrics.inserts++;
      return [
        {
          type: 'edit',
          edit: {
            from: trigger.start,
            to: ctx.draft.cursor,
            insert,
            baseVersion: ctx.draft.version,
            undoable: true,
            label: 'history',
          },
        },
      ];
    },
    async onSubmitCommitted(event: SubmitCommitted, ctx: PluginContext) {
      if (!live) return;
      if (await privateOf()) return;
      const result = decideFromCommitted(event, {
        certainty: ctx.draft.certainty,
        mode: ctx.state.mode,
      });
      if (!result.store) return;
      const host = ctx.host.name;
      const at = event.acceptedAtMs ?? ctx.clock.wallTimeMs();
      const learned = [{ text: event.text, host, project, at }];
      memory.record(learned);
      metrics.recorded++;
      if (persist) enqueue(io, async () => persist(learned));
    },
    async deactivate() {
      await io.current;
    },
  };
  return plugin;
}

export function doctorLine(
  metrics: HistoryMetrics = emptyMetrics(),
  extra?: { readonly enabled?: boolean; readonly prompts?: number; readonly merged?: string },
): string {
  return formatDoctorStats(metrics, extra);
}

export const historyFactory: PluginFactory = (settings) => createHistoryPlugin(settings);

export default createHistoryPlugin;

export function historyPlugin(
  options: HistoryOptions = {},
  settings: Readonly<Record<string, unknown>> = {},
): {
  readonly id: string;
  readonly builtin: true;
  readonly factory: PluginFactory;
  readonly settings: Readonly<Record<string, unknown>>;
} {
  return {
    id: HISTORY_ID_PLUGIN,
    builtin: true,
    factory: (resolved) => createHistoryPlugin({ ...settings, ...resolved }, options),
    settings,
  };
}
