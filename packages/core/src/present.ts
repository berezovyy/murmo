// Ghost, highlight and status: per-plugin registries, each entry bound to the
// draft version it was computed for, and a renderer that calls the adapter
// only when what is shown changes (r12 Codex: redraw only on change).
//
// - Ghost: the first eligible ghost in plugin order, at the current version,
//   with the cursor where `caps.ghost` allows it, no host popup and an
//   editable draft (knowledge § 2). Third-party ghosts go through the host's
//   attributed route.
// - Highlights: the union of every plugin's ranges at the current version;
//   clearing one plugin's keeps the others' (lesson 72, draft 1.3).
// - Status: notices and plugin rows, hidden while a host popup or dialog
//   shows, passed through `displayText` and fitted to `ui.statusMaxLength`
//   by whole rows. Notices come first, newest first, and leave the screen
//   when their lifetime ends (`NoticeLifetime`); the session log keeps every
//   one for stats. Third-party rows carry `[plugin <id>]` and show only where
//   the host says status can't sit beside an approval it can't report
//   (`ui.dialogSafe`, lesson 74): there a plugin's text could pass for the
//   host's own prompt. Murmo's notices and built-in rows are fixed copy in a
//   host-owned slot, so they show on every host with a status surface.
//
// Transient UI never enters host undo (lesson 41): all of it goes through the
// adapter's presentation calls, never through draft edits.

import type { ActionResult, Draft, HighlightMark, HostState, Range, ResultCode } from '@murmo/api';
import type { Adapter, HostCapabilities } from '@murmo/api/adapter';
import { codePointUnits, displayText, isHighSurrogate, unsafeText } from '@murmo/text';
import type { PluginEntry } from './hooks.ts';
import type { Counters, Surface } from './stats.ts';

/** The prototype's cap when the adapter advertises none. */
export const DEFAULT_STATUS_MAX_LENGTH = 512;

/** At most this many notices are kept in the session log; the oldest go first. */
const MAX_NOTICES = 32;

/** At most this many notices are on screen at once, newest first. */
export const MAX_SHOWN_NOTICES = 3;

/**
 * How long a notice stays on screen:
 * - `send`: until the next committed send (the default);
 * - `draft`: until the draft changes, for a refused send that describes this draft;
 * - `native-ui`: while the host's own menu or dialog is open. Status is hidden
 *   then, so such a notice is never left behind once the host UI closes.
 */
export type NoticeLifetime = 'send' | 'draft' | 'native-ui';

interface LiveNotice {
  readonly text: string;
  readonly lifetime: NoticeLifetime;
  readonly version: number;
}

export interface PresentationDeps {
  readonly adapter: Adapter;
  readonly caps: HostCapabilities;
  /** Enabled plugins, in plugin order. */
  readonly plugins: () => readonly PluginEntry[];
  readonly draft: () => Draft;
  readonly state: () => HostState;
  readonly editable: () => boolean;
  readonly counters: Counters;
}

interface Versioned<T> {
  readonly value: T;
  readonly version: number;
}

export interface VisibleGhost {
  readonly owner: string;
  readonly text: string;
  readonly version: number;
}

const validRanges = (ranges: readonly Range[], length: number): boolean =>
  ranges.every(
    (r) =>
      Array.isArray(r) &&
      Number.isInteger(r[0]) &&
      Number.isInteger(r[1]) &&
      r[0] >= 0 &&
      r[0] < r[1] &&
      r[1] <= length,
  );

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end =
    max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) && codePointUnits(text, max - 1) === 2 ? max - 1 : max;
  return text.slice(0, end);
}

export const STATUS_SEPARATOR = ' | ';

/**
 * Rows joined with ` | `, as many whole rows as fit in `max`: a narrow host
 * shows its most important notice in full instead of every row cut short.
 * Only a first row longer than `max` is cut.
 */
export function fitRows(rows: readonly string[], max: number): string {
  let text = '';
  for (const row of rows) {
    if (!row) continue;
    if (!text) text = cut(row, max);
    else if (text.length + STATUS_SEPARATOR.length + row.length <= max) text += STATUS_SEPARATOR + row;
    else break;
  }
  return text;
}

export class Presentation {
  readonly #deps: PresentationDeps;
  readonly #ghosts = new Map<string, Versioned<string>>();
  readonly #highlights = new Map<string, Versioned<{ ranges: readonly Range[]; marks: readonly HighlightMark[] }>>();
  readonly #statuses = new Map<string, string>();
  /** Every notice of the session, oldest first (stats, doctor). */
  #notices: string[] = [];
  /** Notices still on screen, oldest first. */
  #live: LiveNotice[] = [];
  /** What the adapter was last asked to show; the host starts with nothing of Murmo's on screen. */
  #ghostKey: string | null = null;
  #highlightKey: string | null = null;
  /** `undefined`: unknown, the next render sends the status whatever it is. */
  #statusText: string | null | undefined = null;
  #visibleGhost: VisibleGhost | null = null;

  constructor(deps: PresentationDeps) {
    this.#deps = deps;
  }

  get notices(): readonly string[] {
    return this.#notices;
  }

  /** The ghost on screen and its owner, only if the adapter applied it (key claims read this, phase 06). */
  get visibleGhost(): VisibleGhost | null {
    const ghost = this.#visibleGhost;
    return ghost && ghost.version === this.#deps.draft().version ? ghost : null;
  }

  setGhost(plugin: PluginEntry, text: string | null, version: number): ResultCode {
    const { caps } = this.#deps;
    if (caps.ghost === 'none') return 'unsupported';
    if (text === null) this.#ghosts.delete(plugin.id);
    else {
      if (typeof text !== 'string' || unsafeText(text) !== null) return 'denied';
      const draft = this.#deps.draft();
      if (caps.ghost === 'end-only' && draft.cursor !== draft.text.length) return 'unsupported';
      this.#ghosts.set(plugin.id, { value: text, version });
    }
    this.render();
    return 'applied';
  }

  setHighlight(
    plugin: PluginEntry,
    ranges: readonly Range[] | null,
    version: number,
    marks?: readonly HighlightMark[],
  ): ResultCode {
    if (this.#deps.caps.highlight === 'none') return 'unsupported';
    if (ranges === null || ranges.length === 0) this.#highlights.delete(plugin.id);
    else {
      if (!Array.isArray(ranges) || !validRanges(ranges, this.#deps.draft().text.length)) return 'invalid-range';
      const normalized = ranges.map((r) => [r[0], r[1]] as const);
      const nextMarks = marks?.length
        ? marks.map((m) => ({ range: [m.range[0], m.range[1]] as const, severity: m.severity, message: m.message }))
        : normalized.map((range) => ({ range }));
      this.#highlights.set(plugin.id, { value: { ranges: normalized, marks: nextMarks }, version });
    }
    this.render();
    return 'applied';
  }

  setStatus(plugin: PluginEntry, text: string | null): ResultCode {
    if (!this.#deps.caps.status) return 'unsupported';
    if (text === null) this.#statuses.delete(plugin.id);
    else if (typeof text !== 'string') return 'invalid-range';
    else this.#statuses.set(plugin.id, text);
    this.render();
    return 'applied';
  }

  notice(text: string, lifetime: NoticeLifetime = 'send'): void {
    this.#notices = [...this.#notices, text].slice(-MAX_NOTICES);
    const version = this.#deps.draft().version;
    this.#live = [...this.#live.filter((n) => n.text !== text), { text, lifetime, version }].slice(-MAX_NOTICES);
    this.render();
  }

  /** Notices that are no longer true leave the screen; the session log keeps them. */
  withdraw(texts: readonly string[]): void {
    const live = this.#live.filter((n) => !texts.includes(n.text));
    if (live.length === this.#live.length) return;
    this.#live = live;
    this.render();
  }

  /** A send was committed: notices about the old draft leave the screen. */
  expireOnSend(): void {
    if (!this.#live.length) return;
    this.#live = this.#live.filter((n) => n.lifetime === 'native-ui');
    this.render();
  }

  /** A plugin was disabled: its ghost, highlights and status go, everyone else's stay. */
  forget(pluginId: string): void {
    this.#ghosts.delete(pluginId);
    this.#highlights.delete(pluginId);
    this.#statuses.delete(pluginId);
  }

  /** The draft moved on: ghosts and highlights bound to older versions are gone. */
  dropStale(version: number): void {
    for (const map of [this.#ghosts, this.#highlights] as Map<string, Versioned<unknown>>[]) {
      for (const [id, entry] of map) if (entry.version !== version) map.delete(id);
    }
    this.#live = this.#live.filter((n) => n.lifetime !== 'draft' || n.version === version);
  }

  /** Session end: everything Murmo showed is hidden. */
  clearAll(): void {
    this.#ghosts.clear();
    this.#highlights.clear();
    this.#statuses.clear();
    this.#live = [];
    this.render();
  }

  render(): void {
    this.#renderGhost();
    this.#renderHighlights();
    this.#renderStatus();
  }

  #call(surface: Surface, show: () => ActionResult): ResultCode {
    let status: ResultCode;
    try {
      status = show().status;
    } catch {
      status = 'error';
    }
    // An adapter answer outside the contract counts as an error, never as applied.
    if (!(status in this.#deps.counters.ui[surface])) status = 'error';
    this.#deps.counters.ui[surface][status]++;
    return status;
  }

  #renderGhost(): void {
    const { adapter, caps } = this.#deps;
    if (caps.ghost === 'none') return;
    const draft = this.#deps.draft();
    const state = this.#deps.state();
    const placeable =
      state.popup === null && this.#deps.editable() && (caps.ghost === 'any' || draft.cursor === draft.text.length);
    let owner: PluginEntry | undefined;
    let text: string | undefined;
    if (placeable) {
      for (const plugin of this.#deps.plugins()) {
        // Phase 32: OpenCode fallback — third-party ghosts stay off when status
        // cannot cover an approval dialog (condition 5).
        if (!plugin.builtin && !caps.ui.dialogSafe) continue;
        const ghost = this.#ghosts.get(plugin.id);
        if (ghost && ghost.version === draft.version) {
          owner = plugin;
          text = ghost.value;
          break;
        }
      }
    }
    const key = owner && text !== undefined ? `${owner.id}\u0000${text}` : null;
    if (key === this.#ghostKey) return;
    this.#ghostKey = key;
    if (!owner || text === undefined) {
      this.#visibleGhost = null;
      this.#call('ghost', () => adapter.showGhost(null, draft.version));
      return;
    }
    const shown = displayText(text);
    const status = owner.builtin
      ? this.#call('ghost', () => adapter.showGhost(shown, draft.version))
      : this.#call('ghost', () => adapter.showAttributedGhost(shown, draft.version, owner.id));
    // Accept-ghost inserts the raw proposal, not the escaped display form.
    this.#visibleGhost = status === 'applied' ? { owner: owner.id, text, version: draft.version } : null;
  }

  #renderHighlights(): void {
    const { adapter, caps } = this.#deps;
    if (caps.highlight === 'none') return;
    const draft = this.#deps.draft();
    const ranges: Range[] = [];
    const marks: HighlightMark[] = [];
    for (const plugin of this.#deps.plugins()) {
      const entry = this.#highlights.get(plugin.id);
      if (entry && entry.version === draft.version) {
        ranges.push(...entry.value.ranges);
        marks.push(...entry.value.marks);
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const key = marks.length ? JSON.stringify(marks) : ranges.length ? JSON.stringify(ranges) : null;
    if (key === this.#highlightKey) return;
    this.#highlightKey = key;
    if (caps.ui.highlightDiagnostics && adapter.showHighlightMarks) {
      this.#call(
        'highlight',
        () => adapter.showHighlightMarks?.(marks.length ? marks : null, draft.version) ?? { status: 'unsupported' },
      );
    } else {
      this.#call('highlight', () => adapter.showHighlight(ranges.length ? ranges : null, draft.version));
    }
  }

  #renderStatus(): void {
    const { adapter, caps } = this.#deps;
    if (!caps.status) return;
    const state = this.#deps.state();
    let text: string | null = null;
    const nativeUi = state.dialog || state.popup !== null;
    if (!nativeUi) this.#live = this.#live.filter((n) => n.lifetime !== 'native-ui');
    if (!nativeUi) {
      const rows = this.#live
        .slice(-MAX_SHOWN_NOTICES)
        .reverse()
        .map((n) => n.text);
      for (const plugin of this.#deps.plugins()) {
        const status = this.#statuses.get(plugin.id);
        if (status === undefined) continue;
        if (plugin.builtin) rows.push(status);
        else if (caps.ui.dialogSafe) rows.push(`[plugin ${plugin.id}] ${status}`);
      }
      const max = caps.ui.statusMaxLength > 0 ? caps.ui.statusMaxLength : DEFAULT_STATUS_MAX_LENGTH;
      text = fitRows(rows.map(displayText), max) || null;
    }
    if (text === this.#statusText) return;
    this.#statusText = text;
    const shown = text;
    const status = this.#call('status', () => adapter.showStatus(shown, this.#deps.draft().version));
    // The host was a version ahead (an inline commit not yet adopted): the
    // status never reached the screen, so the next render must send it again.
    if (status === 'stale') this.#statusText = undefined;
  }
}
