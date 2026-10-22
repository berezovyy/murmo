// One merged menu for every plugin's rows. Routing uses owner + opaque id +
// version, never labels or positions (author clarification 9). Enter in it
// never sends (r14: Claude submitted in 2/2 orders until this rule).

import { type Draft, type InlineMenuEdit, LIMITS, type MenuItem, type ResultCode } from '@murmo/api';
import type { Adapter, HostCapabilities, MenuSelection, PresentedMenuItem } from '@murmo/api/adapter';
import { displayText, unsafeText } from '@murmo/text';
import type { PluginEntry } from './hooks.ts';
import type { Counters } from './stats.ts';

/** Visible rows on screen (opencode-snippets; feel test may change this). */
export const MENU_WINDOW = 10;

/** Stored rows per plugin: the per-call effect cap, so a 1,000-row flood is clipped. */
export const MENU_MAX_PER_PLUGIN = LIMITS.effectsPerCall;

export interface MenuDeps {
  readonly adapter: Adapter;
  readonly caps: HostCapabilities;
  readonly plugins: () => readonly PluginEntry[];
  readonly draft: () => Draft;
  readonly popup: () => boolean;
  readonly editable: () => boolean;
  readonly counters: Counters;
}

export interface MenuChoice {
  readonly plugin: PluginEntry;
  readonly item: MenuItem;
}

interface Stored {
  readonly items: readonly MenuItem[];
  readonly version: number;
}

function validInline(edit: InlineMenuEdit, draft: Draft): boolean {
  return (
    edit.baseVersion === draft.version &&
    Number.isInteger(edit.from) &&
    Number.isInteger(edit.to) &&
    edit.from >= 0 &&
    edit.to >= edit.from &&
    edit.to <= draft.text.length &&
    typeof edit.insert === 'string' &&
    unsafeText(edit.insert) === null
  );
}

function labelOf(plugin: PluginEntry, label: string): string {
  const shown = displayText(label);
  return plugin.builtin ? shown : `[plugin ${plugin.id}] ${shown}`;
}

/** Window of at most `MENU_WINDOW` rows that contains `selected`. */
export function visibleWindow<T>(
  rows: readonly T[],
  selected: number,
  size = MENU_WINDOW,
): { rows: T[]; selected: number } {
  if (rows.length <= size) return { rows: [...rows], selected };
  const start = Math.min(Math.max(0, selected - Math.floor((size - 1) / 2)), rows.length - size);
  return { rows: rows.slice(start, start + size), selected: selected - start };
}

export class Menu {
  readonly #deps: MenuDeps;
  readonly #stored = new Map<string, Stored>();
  #selected = 0;
  /** Draft version the adapter last applied a non-empty menu for; -1 when closed. */
  #visibleVersion = -1;
  #shown: string | null = null;

  constructor(deps: MenuDeps) {
    this.#deps = deps;
  }

  /** True when the adapter is showing rows bound to the current draft version. */
  get open(): boolean {
    return this.#visibleVersion === this.#deps.draft().version && this.choices().length > 0;
  }

  /** Merged rows at the current version, grouped by plugin order. */
  choices(): readonly MenuChoice[] {
    const version = this.#deps.draft().version;
    const out: MenuChoice[] = [];
    for (const plugin of this.#deps.plugins()) {
      if (plugin.disabled) continue;
      // Phase 32: OpenCode fallback — third-party menu stays off when status
      // cannot cover an approval dialog (condition 5).
      if (!plugin.builtin && !this.#deps.caps.ui.dialogSafe) continue;
      const stored = this.#stored.get(plugin.id);
      if (stored && stored.version === version) {
        for (const item of stored.items) out.push({ plugin, item });
      }
    }
    return out;
  }

  setItems(plugin: PluginEntry, items: readonly MenuItem[] | null, version: number): ResultCode {
    const { caps } = this.#deps;
    if (!caps.menu) return 'unsupported';
    if (items === null || items.length === 0) this.#stored.delete(plugin.id);
    else {
      if (this.#deps.popup()) return 'denied';
      const draft = this.#deps.draft();
      const cleaned: MenuItem[] = [];
      for (const raw of items.slice(0, MENU_MAX_PER_PLUGIN)) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
        const item: MenuItem = {
          id: raw.id,
          label: raw.label,
          ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
        };
        if (raw.inlineEdit) {
          const allowed =
            caps.inline.nativeCompletion &&
            (plugin.builtin || caps.inline.attributed) &&
            plugin.effects.has('edit') &&
            validInline(raw.inlineEdit, draft);
          if (allowed) (item as { inlineEdit?: InlineMenuEdit }).inlineEdit = raw.inlineEdit;
          else this.#deps.counters.deniedEffects++;
        }
        cleaned.push(item);
      }
      this.#stored.set(plugin.id, { items: cleaned, version });
    }
    this.render();
    return 'applied';
  }

  forget(pluginId: string): void {
    this.#stored.delete(pluginId);
  }

  dropStale(version: number): void {
    for (const [id, stored] of this.#stored) if (stored.version !== version) this.#stored.delete(id);
  }

  close(): void {
    this.#stored.clear();
    this.#selected = 0;
    this.#visibleVersion = -1;
    this.render();
  }

  /** Submit pipeline: a plugin menu is showing for this draft version. */
  visibleAt(version: number): boolean {
    return this.#visibleVersion === version && this.choices().length > 0;
  }

  /** Submit pipeline: close the menu without sending. */
  dismiss(): void {
    this.close();
  }

  /** Up/Down wrap; Tab selects (or passes for native completion); Enter/Escape close. */
  handleKey(key: string): 'navigate' | 'select' | 'native-completion' | 'close' | 'none' {
    if (!this.open) return 'none';
    const rows = this.choices();
    if (key === 'Up' || key === 'Down') {
      this.#selected = (this.#selected + (key === 'Up' ? rows.length - 1 : 1)) % rows.length;
      this.render();
      return 'navigate';
    }
    if (key === 'Enter' || key === 'Escape') {
      this.close();
      return 'close';
    }
    if (key === 'Tab') {
      const chosen = rows[this.#selected];
      if (!chosen) {
        this.close();
        return 'close';
      }
      if (chosen.item.inlineEdit && this.#deps.caps.inline.nativeCompletion) return 'native-completion';
      return 'select';
    }
    return 'none';
  }

  /** The row `handleKey` would select; call after `'select'` and before `close` has dropped it. */
  selectedChoice(): MenuChoice | undefined {
    const rows = this.choices();
    if (!rows.length) return undefined;
    return rows[Math.min(this.#selected, rows.length - 1)];
  }

  takeSelection(): MenuChoice | undefined {
    const chosen = this.selectedChoice();
    this.close();
    return chosen;
  }

  /** Native semantic selection: version and editable state must still match. */
  find(selection: MenuSelection): MenuChoice | undefined {
    if (selection.baseVersion !== this.#deps.draft().version) return undefined;
    if (!this.#deps.editable()) return undefined;
    return this.choices().find((row) => row.plugin.id === selection.pluginId && row.item.id === selection.itemId);
  }

  render(): void {
    const { adapter, caps } = this.#deps;
    if (!caps.menu) return;
    const version = this.#deps.draft().version;
    const all = this.choices();
    this.#selected = all.length ? Math.min(this.#selected, all.length - 1) : 0;
    const window = visibleWindow(all, this.#selected);
    const presented: PresentedMenuItem[] = window.rows.map(({ plugin, item }) => ({
      id: item.id,
      label: labelOf(plugin, item.label),
      ...(item.detail !== undefined ? { detail: displayText(item.detail) } : {}),
      ...(item.inlineEdit ? { inlineEdit: item.inlineEdit } : {}),
      owner: plugin.id,
    }));
    const key = presented.length ? `${version}:${window.selected}:${JSON.stringify(presented)}` : null;
    if (key === this.#shown) return;
    this.#shown = key;
    let status: ResultCode;
    try {
      status = adapter.showMenu(presented.length ? presented : null, window.selected, version).status;
    } catch {
      status = 'error';
    }
    if (!(status in this.#deps.counters.ui.menu)) status = 'error';
    this.#deps.counters.ui.menu[status]++;
    this.#visibleVersion = status === 'applied' && presented.length ? version : -1;
  }
}
