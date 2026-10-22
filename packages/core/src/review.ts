// Third-party edit log and pre-send review (phase 32, E4). Submit is blocked
// while any third-party edit since the last review is unreviewed. Approval is
// bound to the draft version the panel showed; a later edit reopens it.

import type { Clock, Draft, Edit, KeyId } from '@murmo/api';
import type { ReviewEdit, ReviewFlag, ReviewPanel, SubmitOutcome } from '@murmo/api/adapter';
import type { PluginEntry } from './hooks.ts';

export const REVIEW_COOLDOWN_MS = 500;
export const REVIEW_BLOCK = 'Review plugin edits before sending';
export const REVIEW_COOLDOWN = 'edits less than 500 ms old';
export const REVIEW_STALE = 'draft changed since review; review again';

export type ReviewMode = 'always' | 'flagged';

function isFlaggedCode(code: number, kind: 'zero' | 'bidi' | 'control'): boolean {
  if (kind === 'zero' || kind === 'control') {
    if ((code >= 0x200b && code <= 0x200f) || (code >= 0x2060 && code <= 0x2069) || code === 0xfeff) return true;
  }
  if (kind === 'bidi' || kind === 'control') {
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
  }
  if (kind === 'control' && ((code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f))) return true;
  return false;
}

/** Escape control and invisible characters the way the S1 defence log did (E4). */
export function visibleText(text: string): string {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    out += isFlaggedCode(code, 'control') ? `\\u${code.toString(16).padStart(4, '0')}` : ch;
  }
  return out;
}

function scriptOf(code: number): 'latin' | 'cyrillic' | 'greek' | null {
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0xc0 && code <= 0x24f)) {
    return 'latin';
  }
  if ((code >= 0x370 && code <= 0x3ff) || (code >= 0x1f00 && code <= 0x1fff)) return 'greek';
  if ((code >= 0x400 && code <= 0x52f) || (code >= 0x2de0 && code <= 0x2dff) || (code >= 0xa640 && code <= 0xa69f)) {
    return 'cyrillic';
  }
  return null;
}

function mixedScripts(text: string): boolean {
  const seen = new Set<string>();
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    const script = scriptOf(code);
    if (script) seen.add(script);
    if (seen.size > 1) return true;
  }
  return false;
}

function flagsOf(insert: string, deleted: string, onScreen: boolean): ReviewFlag[] {
  const text = insert + deleted;
  const flags: ReviewFlag[] = [];
  let zero = false;
  let bidi = false;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (isFlaggedCode(code, 'zero')) zero = true;
    if (isFlaggedCode(code, 'bidi')) bidi = true;
  }
  if (zero) flags.push('zero-width');
  if (bidi) flags.push('bidi');
  if (mixedScripts(text)) flags.push('homoglyph');
  if (!onScreen) flags.push('off-screen');
  return flags;
}

export function onScreenRange(from: number, to: number, cursor: number, window = 500): boolean {
  const lo = Math.max(0, cursor - window);
  const hi = cursor + window;
  return to >= lo && from <= hi;
}

export interface ReviewLogEntry {
  readonly sequence: number;
  readonly pluginId: string;
  readonly at: number;
  readonly version: number;
  readonly from: number;
  readonly to: number;
  readonly before: string;
  readonly after: string;
  readonly onScreen: boolean;
  readonly flags: readonly ReviewFlag[];
}

export interface ReviewDeps {
  readonly clock: Clock;
  readonly cooldownMs?: number;
  readonly mode?: ReviewMode;
  readonly show: (panel: ReviewPanel | null, version: number) => void;
  readonly notice: (text: string) => void;
}

export class ReviewLog {
  readonly #deps: ReviewDeps;
  readonly #entries: ReviewLogEntry[] = [];
  #reviewed = 0;
  #seq = 0;
  #open: ReviewPanel | null = null;
  #approvedVersion: number | null = null;

  constructor(deps: ReviewDeps) {
    this.#deps = deps;
  }

  get pending(): boolean {
    return this.#pending().length > 0;
  }

  get open(): ReviewPanel | null {
    return this.#open;
  }

  get entries(): readonly ReviewLogEntry[] {
    return this.#entries;
  }

  /** Record an applied third-party edit. Built-ins are ignored. */
  noteApplied(plugin: PluginEntry, edit: Edit, draft: Draft, now?: number): void {
    if (plugin.builtin) return;
    const deleted = draft.text.slice(edit.from, edit.to);
    const onScreen = onScreenRange(edit.from, edit.to, draft.cursor);
    const flags = flagsOf(edit.insert, deleted, onScreen);
    this.#entries.push({
      sequence: ++this.#seq,
      pluginId: plugin.id,
      at: now ?? this.#deps.clock.now(),
      version: draft.version,
      from: edit.from,
      to: edit.to,
      before: visibleText(deleted),
      after: visibleText(edit.insert),
      onScreen,
      flags,
    });
    this.#approvedVersion = null;
    if (this.#open) this.#render(draft.version);
  }

  /** Block send while unreviewed third-party edits remain (E4). */
  intercept(version: number): SubmitOutcome | null {
    const pending = this.#pending();
    if (pending.length === 0) return null;
    this.#render(version);
    return { action: 'block', reason: REVIEW_BLOCK };
  }

  /**
   * Approve the open panel. Refuses inside the cooldown or if the draft moved.
   * Bound to the version the panel showed.
   */
  approve(version: number): { ok: true } | { ok: false; reason: string } {
    const pending = this.#pending();
    if (pending.length === 0) return { ok: true };
    if (this.#open && this.#open.version !== version) return { ok: false, reason: REVIEW_STALE };
    const cooldown = this.#deps.cooldownMs ?? REVIEW_COOLDOWN_MS;
    const now = this.#deps.clock.now();
    const youngest = pending.reduce((m, e) => Math.max(m, e.at), 0);
    if (now - youngest < cooldown) {
      this.#deps.notice(REVIEW_COOLDOWN);
      this.#render(version);
      return { ok: false, reason: REVIEW_COOLDOWN };
    }
    this.#reviewed = this.#entries.length;
    this.#approvedVersion = version;
    this.#open = null;
    this.#deps.show(null, version);
    return { ok: true };
  }

  dismiss(version: number): void {
    this.#open = null;
    this.#deps.show(null, version);
  }

  /** Enter approves and should send; Escape dismisses. */
  onKey(key: KeyId, version: number): 'consume' | 'approve' | null {
    if (!this.#open) return null;
    if (key === 'Escape') {
      this.dismiss(version);
      return 'consume';
    }
    if (key === 'Enter') {
      const result = this.approve(version);
      return result.ok ? 'approve' : 'consume';
    }
    return 'consume';
  }

  approvedFor(version: number): boolean {
    return this.#approvedVersion === version && !this.pending;
  }

  reset(): void {
    this.#entries.length = 0;
    this.#reviewed = 0;
    this.#open = null;
    this.#approvedVersion = null;
  }

  #pending(): ReviewLogEntry[] {
    const mode = this.#deps.mode ?? 'always';
    return this.#entries.slice(this.#reviewed).filter((e) => mode === 'always' || e.flags.length > 0);
  }

  #render(version: number): void {
    const cooldown = this.#deps.cooldownMs ?? REVIEW_COOLDOWN_MS;
    const now = this.#deps.clock.now();
    const pending = this.#pending();
    const youngest = pending.reduce((m, e) => Math.max(m, e.at), 0);
    const remaining = Math.max(0, cooldown - (now - youngest));
    const edits: ReviewEdit[] = pending.map((e) => ({
      pluginId: e.pluginId,
      sequence: e.sequence,
      from: e.from,
      to: e.to,
      before: e.before,
      after: e.after,
      onScreen: e.onScreen,
      flags: e.flags,
    }));
    const panel: ReviewPanel = { version, edits, cooldownMs: cooldown, remainingMs: remaining };
    this.#open = panel;
    this.#deps.show(panel, version);
  }
}
