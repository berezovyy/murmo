import type { PluginService } from './brokers.ts';
import type { Certainty, Gesture } from './draft.ts';
import type { ActionId, KeyId } from './keys.ts';
import type { PluginHook } from './plugin.ts';
/**
 * How the host's inline correction lands relative to the boundary key
 * (phase 07 owns the semantics):
 *
 * - `same-transaction`: inside the host's native edit transaction for that key.
 * - `immediate-managed-transport`: before the host sees the boundary key, as one
 *   managed write (the Codex PTY wrapper); immediate, but not a host transaction.
 * - `next-key`: repaired in a later safe transaction from a deferred ledger.
 * - `unsupported`: native pass.
 */
export type InlineRewrite = 'same-transaction' | 'immediate-managed-transport' | 'next-key' | 'unsupported';
/**
 * What an inline commit acknowledgement proves:
 *
 * - `native-commit`: the host's editor committed this text (Pi, OpenCode).
 * - `transport-write`: the adapter's serialized ledger accepted the write; the
 *   screen is checked afterwards (Codex wrapper).
 * - `read-back`: a later read of the host matched (Claude's `prompt.read` or the
 *   next input's before-box).
 * - `none`: no acknowledgement; the shared inline stage stays off.
 */
export type InlineCommitReceipt = 'native-commit' | 'transport-write' | 'read-back' | 'none';
/**
 * Evidence behind `typed` origins. `host-labeled`: every delta the adapter labels
 * `typed` came from the host's (or the Codex wrapper's) key-input path, kept
 * apart from paste; deltas it can't label are `unknown`. Only `host-labeled`
 * input can drive automatic correction or typed-only reads; with anything else
 * the core clears typed spans. Not proof that a person pressed the key: a tool
 * that injects raw keys looks typed (lesson 78).
 */
export type InputOriginEvidence = 'host-labeled' | 'observed-unmarked' | 'unknown';
export interface EditCapabilities {
    /** The adapter compares the version at the native commit (`applyEditIfVersion`). */
    readonly atomic: boolean;
    /** Edits ending at the end of the draft. */
    readonly end: boolean;
    /** Edits anywhere else. */
    readonly middle: boolean;
    readonly multiline: boolean;
    readonly selection: boolean;
    /** `restoreDraft` restores text, cursor, selection and typed spans exactly. */
    readonly exactRestore: boolean;
    /** Draft certainties under which an edit may commit. */
    readonly certainties: readonly Certainty[];
    /** Third-party edits get a host-owned attribution receipt. Without it they are denied. */
    readonly attributed: boolean;
}
/** The inline transaction route, independent of async `edit` (phase 07). */
export interface InlineCapabilities {
    /** Native completions from third-party menus carry host-owned attribution. */
    readonly attributed: boolean;
    readonly middle: boolean;
    readonly multiline: boolean;
    /** Keys that pass through the inline evaluator. */
    readonly observedKeys: readonly KeyId[];
    /** Every key reaches the evaluator, so "the next key" is knowable. */
    readonly allKeysObserved: boolean;
    /** Menu rows with `inlineEdit` commit in the host's completion transaction. */
    readonly nativeCompletion: boolean;
    readonly commitReceipt: InlineCommitReceipt;
    /**
     * The largest inline insertion, in UTF-8 bytes, the transport accepts. The core
     * registers `min(InlineRules.inlineMaxInsertBytes, maxBytes)`; larger literals
     * take the deferred path. An adapter with a scalar cap too reports the smaller
     * of the two (every scalar is at least one byte).
     */
    readonly maxBytes: number;
}
export interface SubmitCapabilities {
    /** Built-in plugins can rewrite the prompt before it is sent. */
    readonly transform: boolean;
    readonly block: boolean;
    /** Gestures that reach `onBeforeSubmit`. */
    readonly gestures: readonly Gesture[];
    /**
     * `managed`: guards cover Murmo's own chain only; a native peer that runs later
     * can still change the text. `final-boundary`: after every native peer, right
     * before transport. Managed is never final protection.
     */
    readonly guardPosition: 'managed' | 'final-boundary';
    /**
     * `accepted-text`: the adapter observes the host accepting a submission.
     * `none`: no such signal; the core may still infer a commit (`level: 'inferred'`).
     */
    readonly committed: 'none' | 'accepted-text';
}
export interface UiCapabilities {
    /** Murmo status cannot cover a host approval dialog; false hides all Murmo status. */
    readonly dialogSafe: boolean;
    readonly anchor: 'host-owned' | 'overlay';
    /** Status text is cut to this many UTF-16 units. */
    readonly statusMaxLength: number;
    readonly normalization: 'preserve' | 'NFC' | 'unknown';
    /** The draft can contain host parts (attachments, collapsed pastes) that edits must not cross. */
    readonly opaqueParts: boolean;
    /** Host-side namespace of Murmo's UI slots, when the host has one. */
    readonly namespace?: string;
}
/**
 * Coexistence with other plugins of the same host (phase 25 measures it per
 * session). Absent means unknown, and unknown is never treated as safe (r14
 * platform-core K7/E5).
 */
export interface CoexistenceCapabilities {
    readonly editorComposition: 'chainable' | 'exclusive' | 'unknown';
    readonly keyArbitration: 'murmo-only' | 'host-coordinated' | 'unknown';
    readonly peerUiObservable: boolean;
}
/** Hooks and services the executor actually routes; set by the core, not the adapter. */
export interface RuntimeCapabilities {
    readonly executor: 'in-process' | 'isolated';
    /** Hooks the executor delivers. */
    readonly hooks: readonly PluginHook[];
    /** Context services the executor routes. */
    readonly services: readonly PluginService[];
}
export interface Capabilities {
    readonly inputOriginEvidence: InputOriginEvidence;
    /** The host reports native menu selections as `{pluginId, itemId, baseVersion}`. */
    readonly semanticMenuSelection: boolean;
    /** Logical actions the adapter routes. */
    readonly actions: readonly ActionId[];
    readonly inlineRewrite: InlineRewrite;
    readonly inline: InlineCapabilities;
    /** The adapter can read the draft text at all. */
    readonly readDraft: boolean;
    readonly edit: EditCapabilities;
    readonly ghost: 'none' | 'end-only' | 'any';
    readonly menu: boolean;
    readonly highlight: 'none' | 'visible-row' | 'any';
    readonly status: boolean;
    /** Keys the adapter can intercept; any other key always passes. */
    readonly keys: readonly KeyId[];
    /** Keys that undo Murmo's last edit, besides an immediate Backspace. */
    readonly undoKeys: readonly KeyId[];
    /** Whether native peers can see a key before Murmo. Not an ownership guarantee. */
    readonly keyPriority: 'before-peers' | 'after-peers' | 'unknown';
    readonly submit: SubmitCapabilities;
    readonly ui: UiCapabilities;
    readonly coexistence?: CoexistenceCapabilities;
    readonly runtime: RuntimeCapabilities;
}
/** What an adapter reports; the core adds `runtime` from the executor. */
export type HostCapabilities = Omit<Capabilities, 'runtime'>;
/** Dotted path of every leaf of `T` (arrays, strings, numbers and booleans are leaves). */
export type LeafPath<T, Prefix extends string = ''> = {
    [K in keyof T & string]-?: NonNullable<T[K]> extends readonly unknown[] | string | number | boolean ? `${Prefix}${K}` : LeafPath<NonNullable<T[K]>, `${Prefix}${K}.`>;
}[keyof T & string];
/** A capability a manifest can require or ask for, e.g. `edit.atomic`. */
export type CapabilityPath = LeafPath<Capabilities>;
/**
 * Every capability path of this API version, so negotiation can tell a typo or a
 * newer API's path ("unknown") from a capability this host lacks ("unavailable").
 * A type test keeps it equal to `CapabilityPath`.
 */
export declare const CAPABILITY_PATHS: readonly ["inputOriginEvidence", "semanticMenuSelection", "actions", "inlineRewrite", "inline.attributed", "inline.middle", "inline.multiline", "inline.observedKeys", "inline.allKeysObserved", "inline.nativeCompletion", "inline.commitReceipt", "inline.maxBytes", "readDraft", "edit.atomic", "edit.end", "edit.middle", "edit.multiline", "edit.selection", "edit.exactRestore", "edit.certainties", "edit.attributed", "ghost", "menu", "highlight", "status", "keys", "undoKeys", "keyPriority", "submit.transform", "submit.block", "submit.gestures", "submit.guardPosition", "submit.committed", "ui.dialogSafe", "ui.anchor", "ui.statusMaxLength", "ui.normalization", "ui.opaqueParts", "ui.namespace", "coexistence.editorComposition", "coexistence.keyArbitration", "coexistence.peerUiObservable", "runtime.executor", "runtime.hooks", "runtime.services"];
