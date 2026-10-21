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
//   shows and unless the host says Murmo status can't cover a dialog
//   (`ui.dialogSafe`, lesson 74), passed through `displayText` and cut to
//   `ui.statusMaxLength`. Third-party rows carry `[plugin <id>]`.
//
// Transient UI never enters host undo (lesson 41): all of it goes through the
// adapter's presentation calls, never through draft edits.

import type { ActionResult, Draft, HostState, Range, ResultCode } from '@murmo/api';
import type { Adapter, HostCapabilities } from '@murmo/api/adapter';
import { codePointUnits, displayText, isHighSurrogate, unsafeText } from '@murmo/text';
import type { PluginEntry } from './hooks.ts';
import type { Counters, Surface } from './stats.ts';

/** The prototype's cap when the adapter advertises none. */
export const DEFAULT_STATUS_MAX_LENGTH = 512;

/** At most this many notices are kept; the oldest go first. */
const MAX_NOTICES = 32;

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

export class Presentation {
  readonly #deps: PresentationDeps;
  readonly #ghosts = new Map<string, Versioned<string>>();
  readonly #highlights = new Map<string, Versioned<readonly Range[]>>();
  readonly #statuses = new Map<string, string>();
  #notices: string[] = [];
  /** What the adapter was last asked to show; the host starts with nothing of Murmo's on screen. */
  #ghostKey: string | null = null;
  #highlightKey: string | null = null;
  #statusText: string | null = null;
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

  setHighlight(plugin: PluginEntry, ranges: readonly Range[] | null, version: number): ResultCode {
    if (this.#deps.caps.highlight === 'none') return 'unsupported';
    if (ranges === null || ranges.length === 0) this.#highlights.delete(plugin.id);
    else {
      if (!Array.isArray(ranges) || !validRanges(ranges, this.#deps.draft().text.length)) return 'invalid-range';
      this.#highlights.set(plugin.id, { value: ranges.map((r) => [r[0], r[1]] as const), version });
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

  notice(text: string): void {
    this.#notices = [...this.#notices, text].slice(-MAX_NOTICES);
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
  }

  /** Session end: everything Murmo showed is hidden. */
  clearAll(): void {
    this.#ghosts.clear();
    this.#highlights.clear();
    this.#statuses.clear();
    this.#notices = [];
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
    for (const plugin of this.#deps.plugins()) {
      const entry = this.#highlights.get(plugin.id);
      if (entry && entry.version === draft.version) ranges.push(...entry.value);
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const key = ranges.length ? JSON.stringify(ranges) : null;
    if (key === this.#highlightKey) return;
    this.#highlightKey = key;
    this.#call('highlight', () => adapter.showHighlight(ranges.length ? ranges : null, draft.version));
  }

  #renderStatus(): void {
    const { adapter, caps } = this.#deps;
    if (!caps.status) return;
    const state = this.#deps.state();
    let text: string | null = null;
    if (caps.ui.dialogSafe && !state.dialog && state.popup === null) {
      const rows = [...this.#notices];
      for (const plugin of this.#deps.plugins()) {
        const status = this.#statuses.get(plugin.id);
        if (status !== undefined) rows.push(plugin.builtin ? status : `[plugin ${plugin.id}] ${status}`);
      }
      const max = caps.ui.statusMaxLength > 0 ? caps.ui.statusMaxLength : DEFAULT_STATUS_MAX_LENGTH;
      text = cut(displayText(rows.join(' | ')), max) || null;
    }
    if (text === this.#statusText) return;
    this.#statusText = text;
    const shown = text;
    this.#call('status', () => adapter.showStatus(shown, this.#deps.draft().version));
  }
}
