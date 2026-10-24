/** Hosts an adapter can report. `fake` is the reference adapter used in tests. */
export type HostName = 'pi' | 'opencode' | 'claude' | 'codex' | 'fake';
/** Half-open UTF-16 range `[from, to)`. */
export type Range = readonly [from: number, to: number];
/**
 * How sure the adapter is that `Draft.text` is the host's real text.
 * `unknown` never permits a mutation; `tracked` needs an explicit capability
 * (`Capabilities.edit.certainties`).
 */
export type Certainty = 'authoritative' | 'tracked' | 'unknown';
/**
 * Where a change came from, as reported by the adapter's input path, never
 * inferred from a text diff (lesson 52). Only `typed` adds typed coverage.
 */
export type Origin = 'typed' | 'paste' | 'plugin' | 'undo' | 'history' | 'native-menu' | 'ime' | 'unknown';
/**
 * The character a `draft:read` plugin sees in place of every UTF-16 unit that is
 * not inside a typed span. Length and cursor stay exact.
 */
export declare const MASKED_UNIT = "\u2588";
export interface Draft {
    readonly text: string;
    readonly cursor: number;
    /** Absent or empty (`[n, n]`) when nothing is selected. */
    readonly selection?: Range;
    /** Increases on every change; every effect is bound to one version. */
    readonly version: number;
    readonly certainty: Certainty;
    /**
     * Ranges the adapter observed being typed. Empty when the host can't label
     * input origin (`Capabilities.inputOriginEvidence` is not `host-labeled`).
     */
    readonly typedSpans: readonly Range[];
    /**
     * Ranges of `text` that stand in for host parts the draft does not carry in
     * full: a collapsed paste shown as a label (`[Pasted ~3 lines]`), a file
     * mention with its attachment. Typing the text back would not bring the parts
     * back. Absent or empty when `text` is the whole prompt. Edits never cross
     * them (`ui.opaqueParts`); the typed text around them works as usual.
     */
    readonly foldedParts?: readonly Range[];
}
/** One splice, in the order the host applied it. */
export interface DraftDelta {
    readonly origin: Origin;
    readonly from: number;
    readonly to: number;
    readonly insert: string;
    /** Set by the core for `plugin` deltas: the real plugin ID. */
    readonly pluginId?: string;
}
export interface Change {
    readonly draft: Draft;
    /** Origin of the change as a whole; `deltas` carries per-splice origins. */
    readonly origin: Origin;
    readonly pluginId?: string;
    /** The draft before the first delta. */
    readonly before?: Draft;
    /**
     * Every splice since the previous change, in order, so a coalesced event never
     * hides an intermediate word boundary. Cursor-only changes carry `[]`.
     */
    readonly deltas?: readonly DraftDelta[];
}
/**
 * Structured host state. An unobservable mode is `unknown`, never assumed to be
 * prose; unknown state skips mutations but read-only work can still run.
 */
export interface HostState {
    readonly mode: 'prose' | 'shell' | 'command' | 'unknown';
    /** A native popup and who owns it; `null` when none is open. */
    readonly popup: null | {
        readonly owner: string;
    };
    readonly dialog: boolean;
    readonly busy: boolean;
    readonly editorMode: 'insert' | 'normal' | 'visual' | 'replace' | 'unknown';
    /** The user is browsing host history. */
    readonly history: boolean;
}
/** What the user asked the host to do with the draft. `newline` is not a submit. */
export type Gesture = 'send' | 'queue' | 'steer' | 'newline';
/** The gestures that submit a prompt. */
export type SubmitGesture = Exclude<Gesture, 'newline'>;
