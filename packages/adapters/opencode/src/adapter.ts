// OpenCode V2 adapter: public renderer, prepended key listener, same-callback
// inline rewrite, measured undo checkpoints, footer status (docs/plan/22).

import type {
  ActionId,
  ActionResult,
  Cancellation,
  Change,
  Draft,
  DraftDelta,
  Edit,
  EditResult,
  HostState,
  KeyId,
  Origin,
  Range,
  SubmitTransaction,
} from '@murmo/api';
import type {
  Adapter,
  EditAttribution,
  HostCapabilities,
  HostSubmitAccepted,
  InlineAnswer,
  InlineCommit,
  InlineRejection,
  InlineSnapshot,
  MenuSelection,
  PresentedMenuItem,
  SubmitOutcome,
  Unsubscribe,
} from '@murmo/api/adapter';
import { BoundaryBook, coexistenceFor } from '@murmo/core';
import { splice as spliceSpans } from '@murmo/provenance';
import { displayText } from '@murmo/text';
import { capabilitiesFromProbes, degradedNotice } from './capabilities.ts';
import { clone } from './clone.ts';
import { bindingMatches, canonicalKey, isPrintableTyped } from './keys.ts';
import { fromCells, representable, toCells, toHighlightRange } from './offsets.ts';
import { Overlay } from './overlay.ts';
import { rangeTouchesPart } from './parts.ts';
import { registerPrioritize } from './prioritize.ts';
import { runProbes } from './probes.ts';
import { createStatusSurface, type StatusSurface } from './status.ts';
import {
  FOCUSED_EDITOR,
  type InboxEnqueued,
  MURMO_HIGHLIGHT_REF,
  MURMO_INLINE_HIGHLIGHT_REF,
  type OpenCodeApi,
  type OpenTuiCore,
  type ParsedKey,
  type PasteEvent,
  type TextareaEditor,
} from './types.ts';

export interface OpenCodeAdapterOptions {
  readonly api: OpenCodeApi;
  readonly core: OpenTuiCore;
  readonly hostVersion?: string;
  readonly status?: StatusSurface;
  readonly log?: (kind: string, data?: Record<string, unknown>) => void;
}

interface NativeExpect {
  readonly kind: 'typed' | 'paste' | 'history' | 'menu';
  readonly before: string;
  readonly from?: number;
  readonly to?: number;
  readonly insert?: string;
  readonly expected?: string;
  readonly cursor?: number;
}

interface LastTransaction {
  readonly before: Draft;
  readonly afterText: string;
  readonly checkpoints: number;
}

interface InlineUndo {
  readonly afterText: string;
  readonly afterVersion: number;
  readonly checkpoints: number;
}

interface PendingInline {
  readonly id: string;
  readonly text: string;
  readonly cursor: number;
  readonly replay?: InlineAnswer['replay'];
}

const emptyDraft = (): Draft => ({ text: '', cursor: 0, version: 0, certainty: 'authoritative', typedSpans: [] });

const result = (status: Exclude<EditResult['status'], 'applied'>, reason?: string): EditResult =>
  reason === undefined ? { status } : { status, reason };

export class OpenCodeAdapter implements Adapter {
  readonly host: { readonly name: 'opencode'; readonly version: string };
  caps: HostCapabilities;
  readonly #api: OpenCodeApi;
  readonly #core: OpenTuiCore;
  readonly #log: (kind: string, data?: Record<string, unknown>) => void;
  readonly #overlay: Overlay;
  readonly #status: StatusSurface;
  readonly #unsub: Unsubscribe[] = [];
  readonly boundaries = new BoundaryBook();

  #editor: TextareaEditor | undefined;
  #draft: Draft = emptyDraft();
  #version = 0;
  #queued = false;
  #submitPending = false;
  #muting = 0;
  #history = false;
  #clearingPrefix = false;
  #pendingNative: NativeExpect | null = null;
  #lastTxn: LastTransaction | null = null;
  #lastChange: { before: Draft; deltas: DraftDelta[] } | null = null;
  #lastReplay: InlineAnswer['replay'] | undefined;
  #pendingInline: PendingInline | null = null;
  #inlineUndo: InlineUndo | null = null;
  #inlineId = 0;
  #inputEpoch = 0;
  #highlightToken = 0;
  #checkpoints = 2;
  #probe: ReturnType<typeof runProbes> = {
    readDraft: false,
    edit: false,
    measureText: false,
    multiline: false,
    selection: false,
    middle: false,
    normalization: false,
    ghost: false,
    menu: false,
    status: false,
    highlight: false,
    keys: [],
    checkpoints: 0,
    opaqueParts: false,
  };
  #degraded: string | null = null;
  #disposed = false;
  #ownsStatus: boolean;

  #onChange: (change: Change) => void = () => {};
  #onKey: (key: KeyId) => 'consume' | 'pass' = () => 'pass';
  #onSubmit: (tx: SubmitTransaction) => Promise<SubmitOutcome> = async () => ({
    action: 'block',
    reason: 'Prompt plugins are loading',
  });
  #evaluateInline: ((snapshot: InlineSnapshot) => InlineAnswer) | undefined;
  #commitInline: ((commit: InlineCommit) => void) | undefined;
  #onCommitted: ((event: HostSubmitAccepted) => void) | undefined;
  #onAction: ((action: ActionId) => void) | undefined;

  constructor(options: OpenCodeAdapterOptions) {
    this.#api = options.api;
    this.#core = options.core;
    this.#log = options.log ?? (() => {});
    this.host = { name: 'opencode', version: options.hostVersion ?? '2.1.1' };
    this.#overlay = new Overlay(options.api.renderer, options.core);
    this.#ownsStatus = !options.status;
    this.#status = options.status ?? createStatusSurface(options.api);
    this.caps = capabilitiesFromProbes(
      {
        readDraft: false,
        edit: false,
        measureText: false,
        multiline: false,
        selection: false,
        middle: false,
        normalization: false,
        ghost: false,
        menu: false,
        status: false,
        highlight: false,
        keys: [],
        checkpoints: 0,
        opaqueParts: false,
      },
      options.api,
    );
  }

  async ready(): Promise<HostCapabilities> {
    this.#probe = runProbes(this.#api, this.#core, this.#status);
    this.#checkpoints = this.#probe.checkpoints || 2;
    this.caps = capabilitiesFromProbes(this.#probe, this.#api);
    this.#degraded = degradedNotice(this.#probe);
    this.#listen();
    this.attach();
    this.#detectListeners('setup');
    if (this.#degraded) this.#status.set(this.#degraded);
    return clone(this.caps);
  }

  getDraft(): Draft {
    return clone(this.#draft);
  }

  getState(): HostState {
    this.attach();
    return this.#state();
  }

  async applyEditIfVersion(edit: Edit, signal?: Cancellation): Promise<EditResult> {
    return this.#commitEdit(edit, signal, false);
  }

  async applyAttributedEditIfVersion(
    edit: Edit,
    attribution: EditAttribution,
    signal?: Cancellation,
  ): Promise<EditResult> {
    const labeled = { ...edit, label: attribution.label };
    return this.#commitEdit(labeled, signal, true);
  }

  async restoreDraft(target: Draft, expectedVersion: number, signal?: Cancellation): Promise<EditResult> {
    this.sync(false);
    if (!this.#probe.measureText) return result('unsupported', 'measureText unavailable');
    if (signal?.cancelled) return result('cancelled');
    if (this.#draft.version !== expectedVersion) return result('stale');
    if (!this.#editable() || target.certainty !== 'authoritative')
      return result('unsupported', 'restore state changed');
    const editor = this.#editor;
    if (!editor || target.cursor < 0 || target.cursor > target.text.length) return result('invalid-range');
    this.#pendingNative = null;
    this.#muting++;
    try {
      if (this.#lastTxn && this.#draft.text === this.#lastTxn.afterText) {
        for (let i = 0; i < this.#lastTxn.checkpoints; i++) editor.undo();
        this.sync(false, 'undo');
      }
      if (this.#draft.text !== target.text) {
        const [from, to, insert] = diffEnds(this.#draft.text, target.text);
        if (!this.splice(from, to, insert, 'undo', false)) return result('unsupported', 'native virtual part');
      }
      editor.cursorOffset = toCells(editor, target.text, target.cursor);
      if (target.selection && target.selection[0] !== target.selection[1]) {
        editor.setSelection(
          toCells(editor, target.text, target.selection[0]),
          toCells(editor, target.text, target.selection[1]),
        );
      } else editor.clearSelection();
      this.sync(false, 'undo');
      this.#draft = { ...this.#draft, typedSpans: clone(target.typedSpans) };
      this.#lastTxn = null;
      this.#inlineUndo = null;
    } finally {
      this.#muting--;
    }
    this.#emit('undo');
    return { status: 'applied', draft: clone(this.#draft) };
  }

  showGhost(text: string | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.ghost !== 'none', () => {
      const editor = this.#editor;
      const measure = editor ? (s: string) => editor.editBuffer.measureText(s) : (s: string) => s.length;
      this.#overlay.showGhost(text, editor, measure);
    });
  }

  showAttributedGhost(text: string | null, baseVersion: number, pluginId: string): ActionResult {
    const labeled = text === null ? null : `[plugin ${pluginId}] ${text}`;
    return this.showGhost(labeled, baseVersion);
  }

  showMenu(items: readonly PresentedMenuItem[] | null, selected: number, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.menu, () => this.#overlay.showMenu(items, selected, this.#editor));
  }

  showHighlight(ranges: readonly Range[] | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.highlight !== 'none', () => this.#paintHighlight(ranges, baseVersion));
  }

  showStatus(text: string | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.status, () => {
      const prefix = this.#degraded ? `${this.#degraded} | ` : '';
      const body = displayText(`${prefix}${text ?? ''}`).slice(0, 512) || null;
      this.#status.set(body);
    });
  }

  onDraftChange(callback: (change: Change) => void): Unsubscribe {
    this.#onChange = callback;
    return () => {
      if (this.#onChange === callback) this.#onChange = () => {};
    };
  }

  onKey(callback: (key: KeyId) => 'consume' | 'pass'): Unsubscribe {
    this.#onKey = callback;
    return () => {
      if (this.#onKey === callback) this.#onKey = () => 'pass';
    };
  }

  onBeforeSubmit(callback: (tx: SubmitTransaction) => Promise<SubmitOutcome>): Unsubscribe {
    this.#onSubmit = callback;
    return () => {
      if (this.#onSubmit === callback) {
        this.#onSubmit = async () => ({ action: 'block', reason: 'Prompt plugins unavailable' });
      }
    };
  }

  onInlineEdit(evaluate: (snapshot: InlineSnapshot) => InlineAnswer): Unsubscribe {
    this.#evaluateInline = evaluate;
    return () => {
      if (this.#evaluateInline === evaluate) this.#evaluateInline = undefined;
    };
  }

  onInlineCommit(callback: (commit: InlineCommit) => void): Unsubscribe {
    this.#commitInline = callback;
    return () => {
      if (this.#commitInline === callback) this.#commitInline = undefined;
    };
  }

  onSubmitCommitted(callback: (event: HostSubmitAccepted) => void): Unsubscribe {
    this.#onCommitted = callback;
    return () => {
      if (this.#onCommitted === callback) this.#onCommitted = undefined;
    };
  }

  onAction(callback: (action: ActionId) => void): Unsubscribe {
    this.#onAction = callback;
    return () => {
      if (this.#onAction === callback) this.#onAction = undefined;
    };
  }

  onInlineReject(_callback: (rejection: InlineRejection) => void): Unsubscribe {
    return () => {};
  }

  onMenuSelect(_callback: (selection: MenuSelection) => void): Unsubscribe {
    return () => {};
  }

  attach(): void {
    const focused = this.#api.renderer.currentFocusedEditor;
    if (!this.#isPrompt(focused)) return;
    if (focused === this.#editor) return;
    this.#detachBuffer();
    this.#editor = focused;
    this.#draft = { ...this.#draft, typedSpans: [] };
    this.#pendingNative = null;
    focused.editBuffer.on('content-changed', this.#changed);
    focused.editBuffer.on('cursor-changed', this.#changed);
    this.sync();
  }

  sync(notify = true, forced?: Origin): Draft {
    const editor = this.#editor;
    if (!editor || editor.isDestroyed) return this.#draft;
    const previous = clone(this.#draft);
    const next = this.#read();
    if (
      next.text === this.#draft.text &&
      next.cursor === this.#draft.cursor &&
      String(next.selection) === String(this.#draft.selection) &&
      next.certainty === this.#draft.certainty
    ) {
      return this.#draft;
    }
    let origin: Origin = forced ?? 'unknown';
    let from = 0;
    while (from < this.#draft.text.length && from < next.text.length && this.#draft.text[from] === next.text[from]) {
      from++;
    }
    let tail = 0;
    while (
      tail < this.#draft.text.length - from &&
      tail < next.text.length - from &&
      this.#draft.text[this.#draft.text.length - 1 - tail] === next.text[next.text.length - 1 - tail]
    ) {
      tail++;
    }
    let to = this.#draft.text.length - tail;
    let insert = next.text.slice(from, next.text.length - tail);
    const pending = this.#pendingNative;
    if (!forced && pending) {
      if (
        pending.kind === 'typed' &&
        pending.before === this.#draft.text &&
        pending.expected === next.text &&
        next.cursor === pending.cursor
      ) {
        origin = 'typed';
      } else if (pending.kind === 'paste') origin = 'paste';
      else if (pending.kind === 'history') origin = 'history';
      else if (pending.kind === 'menu') origin = 'native-menu';
    }
    if (pending?.before === this.#draft.text && pending.expected === next.text && pending.from !== undefined) {
      from = pending.from;
      to = pending.to ?? from;
      insert = pending.insert ?? insert;
    }
    const spans =
      next.text === this.#draft.text
        ? clone(this.#draft.typedSpans)
        : spliceSpans(this.#draft.typedSpans, from, to, insert.length, origin === 'typed');
    this.#pendingNative = null;
    this.#version++;
    this.#draft = { ...next, version: this.#version, typedSpans: spans };
    this.#lastChange = { before: previous, deltas: previous.text === next.text ? [] : [{ origin, from, to, insert }] };
    const queued = this.#pendingInline;
    if (queued) {
      this.#pendingInline = null;
      const matching = this.#draft.text === queued.text && this.#draft.cursor === queued.cursor;
      if (matching && queued.replay) {
        this.#draft = { ...this.#draft, typedSpans: clone(queued.replay.typedSpans) };
        this.#lastReplay = queued.replay;
      }
      this.#commitInline?.({
        transactionId: queued.id,
        status: matching ? 'applied' : 'fallback',
        text: this.#draft.text,
        cursor: this.#draft.cursor,
        version: this.#draft.version,
      });
    }
    if (notify && !this.#muting) this.#emit(origin);
    return this.#draft;
  }

  splice(from: number, to: number, insert: string, origin: Origin = 'plugin', notify = true): boolean {
    this.sync(false);
    const editor = this.#editor;
    if (!editor) return false;
    const before = clone(this.#draft);
    const a = toCells(editor, before.text, from);
    const b = toCells(editor, before.text, to);
    if (rangeTouchesPart(editor, a, b)) return false;
    const caret =
      before.cursor < from
        ? before.cursor
        : before.cursor >= to
          ? before.cursor + insert.length - (to - from)
          : from + insert.length;
    this.#pendingNative = null;
    this.#muting++;
    try {
      if (a === b) {
        editor.clearSelection();
        editor.cursorOffset = a;
      } else editor.setSelection(a, b);
      editor.insertText(insert);
      const text = before.text.slice(0, from) + insert + before.text.slice(to);
      editor.cursorOffset = toCells(editor, text, caret);
      this.#lastTxn = { before, afterText: text, checkpoints: from === to ? 1 : insert.length ? this.#checkpoints : 1 };
      this.sync(false, origin);
    } finally {
      this.#muting--;
    }
    if (notify) this.#emit(origin);
    return true;
  }

  reprepend(): { readonly index: number; readonly count: number } {
    const input = this.#api.renderer.keyInput;
    input.removeListener('keypress', this.#onKeypress);
    input.prependListener('keypress', this.#onKeypress);
    const order = this.#detectListeners('handoff');
    return order;
  }

  #detectListeners(at: 'setup' | 'focus' | 'handoff'): { readonly index: number; readonly count: number } {
    const input = this.#api.renderer.keyInput;
    const index = input.listeners('keypress').indexOf(this.#onKeypress);
    const count = input.listenerCount('keypress');
    if (index < 0) {
      const text = this.boundaries.record({
        boundary: 'missing-hook',
        evidence: { kind: 'listener-order', index, count, at },
        action: 'suppress',
      });
      if (text) this.#status.set(text);
      return { index, count };
    }
    if (index > 0) {
      const text = this.boundaries.record({
        boundary: 'listener-precedes',
        evidence: { kind: 'listener-order', index, count, at },
        action: 'compose',
      });
      if (text) this.#status.set(text);
      this.caps = {
        ...this.caps,
        keyPriority: 'unknown',
        coexistence: coexistenceFor('opencode', { keyArbitration: 'unknown' }),
      };
    } else if (at === 'handoff') {
      this.caps = {
        ...this.caps,
        keyPriority: 'before-peers',
        coexistence: coexistenceFor('opencode', { keyArbitration: 'host-coordinated' }),
      };
    }
    return { index, count };
  }

  diagnostics(): Record<string, unknown> {
    return {
      dialogProbeCoverage: 'generic-modal',
      statusSlotMounted: this.#status.present(),
      statusSlotBounds: this.#status.bounds(),
      modal: this.#modalState(),
      probe: this.#probe,
      checkpoints: this.#checkpoints,
      caps: clone(this.caps),
      draft: clone(this.#draft),
      state: this.#state(),
      overlayNodes: this.#overlay.size,
      marks: this.#editor?.extmarks.getAll() ?? [],
      listeners: {
        key: this.#api.renderer.keyInput.listenerCount('keypress'),
        content: this.#editor?.editBuffer.listenerCount?.('content-changed') ?? 0,
      },
      inlineUndo: this.#inlineUndo,
      lastTxn: this.#lastTxn ? { afterText: this.#lastTxn.afterText, checkpoints: this.#lastTxn.checkpoints } : null,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#unsub) off();
    this.#unsub.length = 0;
    const renderer = this.#api.renderer;
    renderer.removeListener(FOCUSED_EDITOR, this.#onFocus);
    renderer.keyInput.removeListener('keypress', this.#onKeypress);
    renderer.keyInput.removeListener('paste', this.#onPaste);
    this.#detachBuffer();
    this.#overlay.dispose();
    if (this.#ownsStatus) this.#status.dispose();
    this.#onChange = () => {};
    this.#onKey = () => 'pass';
  }

  get overlaySize(): number {
    return this.#overlay.size;
  }

  get checkpoints(): number {
    return this.#checkpoints;
  }

  get probe(): ReturnType<typeof runProbes> {
    return this.#probe;
  }

  get editor(): TextareaEditor | undefined {
    return this.#editor;
  }

  #listen(): void {
    const renderer = this.#api.renderer;
    renderer.on(FOCUSED_EDITOR, this.#onFocus);
    renderer.keyInput.prependListener('keypress', this.#onKeypress);
    renderer.keyInput.prependListener('paste', this.#onPaste);
    const offPrioritize = registerPrioritize(this.#api, () => {
      this.reprepend();
    });
    this.#unsub.push(offPrioritize);
    const dataOn = this.#api.data.on;
    if (typeof dataOn === 'function') {
      this.#unsub.push(dataOn.call(this.#api.data, 'session.inbox.enqueued', this.#onEnqueued));
    }
  }

  readonly #onFocus = (): void => {
    this.attach();
    this.#detectListeners('focus');
  };

  readonly #changed = (): void => {
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      this.sync();
    });
  };

  readonly #onPaste = (event: PasteEvent): void => {
    this.sync();
    this.#inlineUndo = null;
    this.#onKey('Paste');
    this.#history = false;
    const insert = decodePaste(event.bytes);
    const before = this.#draft;
    this.#pendingNative = {
      kind: 'paste',
      before: before.text,
      from: before.cursor,
      insert,
      expected: before.text.slice(0, before.cursor) + insert + before.text.slice(before.cursor),
    };
  };

  readonly #onEnqueued = (event: InboxEnqueued): void => {
    const text = event.item?.payload?.text ?? this.#draft.text;
    this.#onCommitted?.({
      text,
      gesture: 'send',
      submissionId: event.inboxID ?? `opencode-${this.#draft.version}`,
      position: 'managed',
      typedSpans: clone(this.#draft.typedSpans),
    });
  };

  readonly #onKeypress = (parsed: ParsedKey): void => {
    if (this.#clearingPrefix || this.#disposed) return;
    this.attach();
    if (!this.#isPrompt(this.#api.renderer.currentFocusedEditor)) return;
    this.#clearInlineHighlight();
    this.#inputEpoch++;
    this.sync();
    this.#history = false;
    const key = canonicalKey(parsed, this.#api.keymap);
    const state = this.#state();
    this.#pendingNative = null;
    try {
      if (this.#onKey(key) === 'consume') {
        consume(parsed);
        return;
      }
      if (key !== 'Backspace' && key !== 'Undo') this.#inlineUndo = null;
      if (this.#tryInline(parsed, key, state)) return;
      const gesture = this.#gesture(parsed, key);
      if (
        gesture &&
        gesture !== 'newline' &&
        this.#editor &&
        this.#isPrompt(this.#api.renderer.currentFocusedEditor) &&
        !state.popup &&
        !state.dialog &&
        this.#draft.text
      ) {
        consume(parsed);
        this.#submit(gesture);
        return;
      }
      if (key === 'Up' || key === 'Down') {
        this.#history = true;
        this.#pendingNative = { kind: 'history', before: this.#draft.text };
      } else if (state.popup) {
        this.#pendingNative = { kind: 'menu', before: this.#draft.text };
      } else if (isPrintableTyped(parsed) && !this.#draft.selection && this.#editable()) {
        const insert = parsed.sequence;
        this.#pendingNative = {
          kind: 'typed',
          before: this.#draft.text,
          from: this.#draft.cursor,
          insert,
          expected: this.#draft.text.slice(0, this.#draft.cursor) + insert + this.#draft.text.slice(this.#draft.cursor),
          cursor: this.#draft.cursor + insert.length,
        };
      } else if (key === 'Newline') {
        this.#pendingNative = {
          kind: 'typed',
          before: this.#draft.text,
          from: this.#draft.cursor,
          insert: '\n',
          expected: `${this.#draft.text.slice(0, this.#draft.cursor)}\n${this.#draft.text.slice(this.#draft.cursor)}`,
          cursor: this.#draft.cursor + 1,
        };
      }
    } catch (error) {
      this.#log('adapter-key-error', { error: String(error) });
    }
  };

  #tryInline(parsed: ParsedKey, key: KeyId, state: HostState): boolean {
    const evaluate = this.#evaluateInline;
    if (!evaluate || this.caps.inlineRewrite !== 'same-transaction' || !this.#editable()) return false;
    const typed = isPrintableTyped(parsed);
    if (!(key === 'Backspace' || key === 'Undo' || typed) || this.#draft.selection) return false;
    const before = clone(this.#draft);
    const char = key === 'Backspace' || key === 'Undo' ? '' : parsed.sequence;
    const id = String(++this.#inlineId);
    const at = before.cursor;
    const from = key === 'Backspace' ? Math.max(0, at - 1) : at;
    const answer = evaluate({
      transactionId: id,
      version: before.version,
      text: before.text,
      cursor: at,
      typedSpans: before.typedSpans,
      certainty: before.certainty,
      deltas: key === 'Undo' ? [] : [{ origin: 'typed', from, to: at, insert: char }],
      origin: 'typed',
      key: { id: key, inputText: char, from, to: at },
      state,
    });
    if (answer.action === 'replace') {
      const editor = this.#editor;
      if (!editor || this.#version !== before.version || editor.plainText !== before.text) {
        this.#commitInline?.({
          transactionId: id,
          status: 'stale',
          text: this.#draft.text,
          cursor: this.#draft.cursor,
          version: this.#draft.version,
        });
        return true;
      }
      consume(parsed);
      this.#muting++;
      try {
        if (
          (key === 'Undo' || key === 'Backspace') &&
          this.#inlineUndo &&
          this.#inlineUndo.afterVersion === before.version &&
          this.#inlineUndo.afterText === before.text
        ) {
          for (let i = 0; i < this.#inlineUndo.checkpoints; i++) editor.undo();
          this.sync(false, 'undo');
        }
        const current = this.#draft.text;
        const [from2, to2, insert] = diffEnds(current, answer.text);
        if (
          !representable(editor, current, from2) ||
          !representable(editor, current, to2) ||
          rangeTouchesPart(editor, toCells(editor, current, from2), toCells(editor, current, to2))
        ) {
          throw new Error('inline range not representable');
        }
        if (from2 !== to2 || insert) this.splice(from2, to2, insert, 'plugin', false);
        editor.cursorOffset = toCells(editor, answer.text, answer.cursor);
        this.sync(false, 'plugin');
        if (answer.replay) this.#draft = { ...this.#draft, typedSpans: clone(answer.replay.typedSpans) };
        if (key !== 'Backspace' && key !== 'Undo') {
          this.#inlineUndo = {
            afterText: this.#draft.text,
            afterVersion: this.#draft.version,
            checkpoints: from2 === to2 ? 1 : insert.length ? this.#checkpoints : 1,
          };
        } else this.#inlineUndo = null;
        this.#commitInline?.({
          transactionId: id,
          status: 'applied',
          text: this.#draft.text,
          cursor: this.#draft.cursor,
          version: this.#draft.version,
        });
      } finally {
        this.#muting--;
      }
      this.#lastReplay = answer.replay;
      this.#emit(key === 'Backspace' || key === 'Undo' ? 'undo' : 'plugin');
      if (key !== 'Backspace' && key !== 'Undo') this.#inlineHighlight();
      return true;
    }
    if (char || key === 'Backspace' || key === 'Undo') {
      this.#pendingInline = {
        id,
        text:
          key === 'Backspace'
            ? before.text.slice(0, Math.max(0, at - 1)) + before.text.slice(at)
            : before.text.slice(0, at) + char + before.text.slice(at),
        cursor: key === 'Backspace' ? Math.max(0, at - 1) : at + char.length,
        ...(answer.replay ? { replay: answer.replay } : {}),
      };
    }
    return false;
  }

  #gesture(parsed: ParsedKey, key: KeyId): 'send' | 'queue' | 'newline' | null {
    if (key === 'Newline') return 'newline';
    if (bindingMatches(this.#api.keymap, 'prompt.queue', parsed)) return 'queue';
    if (key === 'Enter' || bindingMatches(this.#api.keymap, 'prompt.submit', parsed)) return 'send';
    return null;
  }

  #submit(gesture: 'send' | 'queue'): void {
    if (this.#submitPending) return;
    this.#submitPending = true;
    const original = clone(this.#draft);
    const born = this.#inputEpoch;
    void this.#onSubmit({ draft: original, gesture, position: 'managed' })
      .then((decision) => {
        this.sync();
        const now = this.#state();
        if (
          this.#inputEpoch !== born ||
          this.#draft.version !== original.version ||
          now.popup ||
          now.dialog ||
          this.#api.renderer.currentFocusedEditor !== this.#editor
        ) {
          return;
        }
        if (decision.action === 'block') {
          if (gesture === 'queue' && this.#api.keymap.pending().length) this.#cancelPrefix();
          this.#status.set(decision.reason);
          return;
        }
        if (decision.action === 'replace') {
          const [from, to, insert] = diffEnds(this.#draft.text, decision.text);
          if (!this.splice(from, to, insert)) {
            this.#status.set('Submit transform intersects attachment');
            return;
          }
        }
        this.#api.keymap.dispatch(gesture === 'queue' ? 'prompt.queue' : 'prompt.submit');
      })
      .catch((error: unknown) => this.#status.set(`Submit blocked: ${String(error)}`))
      .finally(() => {
        this.#submitPending = false;
      });
  }

  #cancelPrefix(): void {
    const n = this.#api.keymap.pending().length;
    this.#clearingPrefix = true;
    try {
      for (let i = 0; i < n; i++) {
        this.#api.renderer.keyInput.processParsedKey({
          name: 'backspace',
          sequence: '\x7f',
          raw: '\x7f',
          ctrl: false,
          meta: false,
          shift: false,
          option: false,
          super: false,
        });
      }
    } finally {
      this.#clearingPrefix = false;
    }
    this.sync();
  }

  async #commitEdit(edit: Edit, signal: Cancellation | undefined, _attributed: boolean): Promise<EditResult> {
    this.attach();
    this.sync();
    if (!this.#probe.measureText) return result('unsupported', 'measureText unavailable');
    if (signal?.cancelled) return result('cancelled');
    if (this.#draft.version !== edit.baseVersion) return result('stale');
    if (!this.#editable()) return result('unsupported', 'not an editable authoritative prose draft');
    if (
      edit.to < edit.from ||
      typeof edit.insert !== 'string' ||
      !this.#editor ||
      !representable(this.#editor, this.#draft.text, edit.from) ||
      !representable(this.#editor, this.#draft.text, edit.to)
    ) {
      return result('invalid-range');
    }
    if (!this.splice(edit.from, edit.to, edit.insert)) return result('unsupported', 'native virtual part');
    return { status: 'applied', draft: clone(this.#draft) };
  }

  #read(): Draft {
    const editor = this.#editor;
    const text = editor?.plainText ?? '';
    const cursor = editor ? fromCells(editor, editor.cursorOffset) : 0;
    const sel = editor?.getSelection();
    const selection = sel && editor ? ([fromCells(editor, sel.start), fromCells(editor, sel.end)] as Range) : undefined;
    return {
      text,
      cursor,
      version: this.#version,
      certainty: 'authoritative',
      typedSpans: clone(this.#draft.typedSpans),
      ...(selection ? { selection } : {}),
    };
  }

  #state(): HostState {
    const editor = this.#editor;
    const alive = !!editor && !editor.isDestroyed;
    let modeName = 'base';
    try {
      modeName = this.#api.keymap.mode.current();
    } catch {
      modeName = 'unknown';
    }
    const traits = alive ? editor.traits : undefined;
    let route: { readonly type: string; readonly sessionID?: string } = { type: 'session' };
    try {
      route = this.#api.ui.router.current();
    } catch {
      route = { type: 'unknown' };
    }
    let busy = false;
    try {
      busy =
        route.type === 'session' && !!route.sessionID && this.#api.data.session.status(route.sessionID) === 'running';
    } catch {
      busy = false;
    }
    const known = ['base', 'default', 'autocomplete'].includes(modeName);
    const popup =
      modeName === 'autocomplete' || (traits?.capture ?? []).includes('submit') ? { owner: 'host' as const } : null;
    return {
      mode:
        !alive || !known
          ? 'unknown'
          : traits?.status === 'SHELL'
            ? 'shell'
            : (editor?.plainText ?? '').startsWith('/')
              ? 'command'
              : 'prose',
      popup,
      dialog: !alive || !!this.#modalState(),
      busy,
      editorMode: known ? 'insert' : 'unknown',
      history: this.#history,
    };
  }

  #modalState(): 'keymap-modal' | 'focus' | null {
    let mode = '';
    try {
      mode = this.#api.keymap.mode.current();
    } catch {
      return null;
    }
    if (mode === 'modal' || mode.includes('dialog')) return 'keymap-modal';
    if (this.#editor && this.#api.renderer.currentFocusedEditor !== this.#editor) return 'focus';
    return null;
  }

  #editable(): boolean {
    const state = this.#state();
    return (
      state.mode === 'prose' &&
      !state.popup &&
      !state.dialog &&
      !state.busy &&
      !state.history &&
      state.editorMode === 'insert' &&
      this.#draft.certainty === 'authoritative'
    );
  }

  #isPrompt(editor: TextareaEditor | null | undefined): editor is TextareaEditor {
    return !!editor && editor.traits?.owner === 'opencode' && editor.traits?.role === 'prompt';
  }

  #present(base: number, supported: boolean, fn: () => void): ActionResult {
    this.sync();
    if (base !== this.#draft.version) return { status: 'stale' };
    if (!supported) return { status: 'unsupported' };
    fn();
    return { status: 'applied' };
  }

  #paintHighlight(ranges: readonly Range[] | null, base: number): void {
    const editor = this.#editor;
    if (!editor) return;
    editor.removeHighlightsByRef(MURMO_HIGHLIGHT_REF);
    if (!ranges?.length) return;
    const token = ++this.#highlightToken;
    const text = this.#draft.text;
    const style = editor.syntaxStyle;
    const id = style.resolveStyleId('murmo') ?? style.registerStyle('murmo', { underline: true });
    queueMicrotask(() => {
      if (token !== this.#highlightToken || editor.isDestroyed || this.#draft.version !== base) return;
      for (const [a, b] of ranges) {
        const start = toCells(editor, text, a);
        const end = toCells(editor, text, b);
        const chars = toHighlightRange(editor, start, end);
        editor.addHighlightByCharRange({ ...chars, styleId: id, hlRef: MURMO_HIGHLIGHT_REF });
      }
      this.#api.renderer.requestRender();
    });
  }

  #inlineHighlight(): void {
    const prefix = this.#draft.text.slice(0, this.#draft.cursor).replace(/[ .,;:!?]+$/, '');
    const word = /[A-Za-z]+$/.exec(prefix);
    const editor = this.#editor;
    if (!word || !editor) return;
    const from = prefix.length - word[0].length;
    const to = prefix.length;
    const base = this.#version;
    const id =
      editor.syntaxStyle.resolveStyleId('murmo-inline') ??
      editor.syntaxStyle.registerStyle('murmo-inline', { underline: true });
    queueMicrotask(() => {
      if (editor.isDestroyed || this.#version !== base) return;
      const a = toCells(editor, this.#draft.text, from);
      const b = toCells(editor, this.#draft.text, to);
      const chars = toHighlightRange(editor, a, b);
      editor.addHighlightByCharRange({ ...chars, styleId: id, hlRef: MURMO_INLINE_HIGHLIGHT_REF });
      this.#api.renderer.requestRender();
    });
  }

  #clearInlineHighlight(): void {
    const editor = this.#editor;
    if (editor && !editor.isDestroyed) editor.removeHighlightsByRef(MURMO_INLINE_HIGHLIGHT_REF);
  }

  #emit(origin: Origin): void {
    const replay = this.#lastReplay ?? this.#lastChange;
    this.#lastReplay = undefined;
    this.#lastChange = null;
    this.#onChange({
      draft: clone(this.#draft),
      origin,
      ...(replay ? { before: clone(replay.before), deltas: clone(replay.deltas) } : {}),
    });
  }

  #detachBuffer(): void {
    const editor = this.#editor;
    if (!editor || editor.isDestroyed) return;
    editor.editBuffer.off('content-changed', this.#changed);
    editor.editBuffer.off('cursor-changed', this.#changed);
    editor.removeHighlightsByRef(MURMO_HIGHLIGHT_REF);
    editor.removeHighlightsByRef(MURMO_INLINE_HIGHLIGHT_REF);
  }
}

function consume(key: ParsedKey): void {
  key.preventDefault();
  key.stopPropagation();
}

function diffEnds(current: string, next: string): [number, number, string] {
  let from = 0;
  while (from < current.length && from < next.length && current[from] === next[from]) from++;
  let tail = 0;
  while (
    tail < current.length - from &&
    tail < next.length - from &&
    current[current.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail++;
  }
  return [from, current.length - tail, next.slice(from, next.length - tail)];
}

function decodePaste(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
