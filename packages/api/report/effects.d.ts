import type { Draft, Range } from './draft.ts';
/** Typed outcome of every adapter action. Unsupported calls return a code, never throw. */
export type ResultCode = 'applied' | 'stale' | 'denied' | 'unsupported' | 'invalid-range' | 'cancelled' | 'error';
export interface ActionResult {
    readonly status: ResultCode;
    readonly reason?: string;
}
/** An applied edit carries the snapshot committed by the host, not a later read. */
export type EditResult = {
    readonly status: 'applied';
    readonly draft: Draft;
} | {
    readonly status: Exclude<ResultCode, 'applied'>;
    readonly reason?: string;
};
export interface Edit {
    readonly from: number;
    readonly to: number;
    readonly insert: string;
    /** The version the edit was computed from; the host compares it at commit. */
    readonly baseVersion: number;
    /** Record one undo step for the immediate Backspace or undo key. */
    readonly undoable?: boolean;
    /** Shown in the host-owned attribution of a third-party edit. */
    readonly label?: string;
    /**
     * An immediate Backspace restores the text before the edit and also removes
     * the typed separator after it (autocorrect); the undo key keeps the separator.
     */
    readonly rejectSeparator?: boolean;
    /**
     * Where the cursor goes, as an offset in the text after the edit. Absent:
     * where the host puts it (after the insert when it was inside the range).
     * An empty edit with a cursor only moves the cursor. Needs `edit.cursor`;
     * elsewhere the edit is `unsupported`.
     */
    readonly cursor?: number;
}
/**
 * A literal proposal the host may commit in its own completion transaction when
 * `Capabilities.inline.nativeCompletion` is true, without calling `onMenuSelect`.
 */
export interface InlineMenuEdit {
    readonly baseVersion: number;
    readonly from: number;
    readonly to: number;
    readonly insert: string;
    readonly undoable: boolean;
}
/**
 * A menu row. `id` is opaque: the core routes it back to its owner unchanged,
 * never by position or label. The owner is set by the core from the real plugin
 * ID; a plugin cannot name one.
 */
export interface MenuItem {
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
    readonly inlineEdit?: InlineMenuEdit;
}
export type HighlightSeverity = 'info' | 'warning' | 'error';
/** One highlight with optional severity and message. Adapters that cannot show both advertise `ui.highlightDiagnostics: false`. */
export interface HighlightMark {
    readonly range: Range;
    readonly severity?: HighlightSeverity;
    readonly message?: string;
}
export type Effect = {
    readonly type: 'edit';
    readonly edit: Edit;
}
/** Suggested text after the cursor; `null` clears this plugin's ghost. */
 | {
    readonly type: 'ghost';
    readonly text: string | null;
    readonly baseVersion: number;
}
/** `null` or `[]` closes this plugin's rows of the merged menu. */
 | {
    readonly type: 'menu';
    readonly items: readonly MenuItem[] | null;
    readonly baseVersion: number;
}
/** Ranges compose per plugin: clearing yours keeps every other plugin's. */
 | {
    readonly type: 'highlight';
    readonly ranges: readonly Range[] | null;
    readonly baseVersion: number;
    readonly marks?: readonly HighlightMark[];
} | {
    readonly type: 'status';
    readonly text: string | null;
    readonly baseVersion: number;
}
/**
 * Cached field ranges for `in-my-field-session`. `null` ends the session.
 * The core evaluates the claim from this cache; plugin code does not run on
 * the key path. `active` is the selected field index.
 */
 | {
    readonly type: 'field-session';
    readonly ranges: readonly Range[] | null;
    readonly active?: number;
    readonly baseVersion: number;
};
export type EffectType = Effect['type'];
