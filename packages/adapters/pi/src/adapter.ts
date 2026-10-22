// Pi Adapter: public APIs only. Inline rewrite is setText + native Left/Right
// in the same handleInput. Async edits use a stacked autocomplete provider.
// Collapsed-paste drafts abstain (setText would drop the registry; the provider
// route is async, so it is not same-transaction).

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
  SubmitGesture,
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
import { applyChange, type TypingRules } from '@murmo/provenance';
import { codePointBefore } from '@murmo/text';
import { OBSERVED_KEYS, offCaps, piCaps } from './caps.ts';
import { EditorHost, type EditorHostOptions } from './editor.ts';
import { decodeKey, isBracketedPaste, isPrintableRaw, stripPasteMarkers } from './keys.ts';
import {
  type EditorBase,
  OWNERSHIP_LOST,
  type PiEditor,
  type PiHost,
  type PiSessionContext,
  type TuiApi,
} from './types.ts';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const labeled: TypingRules = { evidence: 'host-labeled', keyBursts: true };

const INLINE_KEYS = new Set(['Backspace', 'Undo', 'F6']);

export interface PiAdapterOptions {
  readonly Base: EditorBase;
  readonly tuiApi: TuiApi;
  readonly ctx: PiSessionContext;
  readonly version?: string;
  readonly log?: (event: Record<string, unknown>) => void;
  readonly pi?: PiHost;
  readonly clock?: { now(): number; wallTimeMs(): number };
}

interface InputFrame {
  origin: Origin;
  key: KeyId;
  data: string;
  before: { text: string; cursor: number };
}

function result(status: ActionResult['status'], reason?: string): ActionResult {
  return reason === undefined ? { status } : { status, reason };
}

function denied(status: Exclude<EditResult['status'], 'applied'>, reason?: string): EditResult {
  return reason === undefined ? { status } : { status, reason };
}

function graphemeBefore(text: string, at: number): number {
  if (at <= 0) return 0;
  const point = codePointBefore(text, at);
  if (point === undefined) return 0;
  return at - (point > 0xffff ? 2 : 1);
}

export class PiAdapter implements Adapter {
  readonly host: { readonly name: 'pi'; readonly version: string };
  caps: HostCapabilities = offCaps();
  readonly backend: EditorHost;
  readonly #log: (event: Record<string, unknown>) => void;
  readonly #ctx: PiSessionContext;
  readonly #pi: PiHost | undefined;
  #draft: Draft = { text: '', cursor: 0, version: 0, certainty: 'unknown', typedSpans: [] };
  #probing = true;
  #disposed = false;
  #history = false;
  #nativeCompletion = false;
  #input: InputFrame | null = null;
  #inlineId = 0;
  #lastNativeInline: { version: number } | null = null;
  #mutation: {
    expected: number;
    origin: Origin;
    edit: { from: number; to: number; insert: string };
    signal?: Cancellation;
    restoreSpans?: readonly Range[];
    committed: Draft | null;
  } | null = null;
  #submitMutation: { expected: number; origin: Origin; edit: { from: number; to: number; insert: string } } | null =
    null;
  #forwarded: { text: string; gesture: SubmitGesture; id: string } | null = null;
  #submissions = 0;
  #ready: Promise<HostCapabilities> | undefined;
  #ownershipLost = false;

  readonly #changes = new Set<(change: Change) => void>();
  readonly #keys = new Set<(key: KeyId) => 'consume' | 'pass'>();
  readonly #submits = new Set<(tx: SubmitTransaction) => Promise<SubmitOutcome>>();
  readonly #committed = new Set<(event: HostSubmitAccepted) => void>();
  readonly #inline = new Set<(snapshot: InlineSnapshot) => InlineAnswer>();
  readonly #commits = new Set<(commit: InlineCommit) => void>();
  readonly #rejects = new Set<(rejection: InlineRejection) => void>();
  readonly #actions = new Set<(action: ActionId) => void>();
  readonly #menus = new Set<(selection: MenuSelection) => void>();
  readonly #unsub: Unsubscribe[] = [];

  nativeInlineUndos = 0;
  patchInlineUndos = 0;
  readonly notices: string[] = [];
  readonly boundaries = new BoundaryBook();

  constructor(options: PiAdapterOptions) {
    this.host = { name: 'pi', version: options.version ?? '1.3.0' };
    this.#log = options.log ?? (() => {});
    this.#ctx = options.ctx;
    this.#pi = options.pi;
    const self = this;
    const hostOptions: EditorHostOptions = {
      Base: options.Base,
      tuiApi: options.tuiApi,
      ctx: options.ctx,
      ...(options.log ? { log: options.log } : {}),
      hooks: {
        onInput(data, editor) {
          self.#onInput(data, editor);
        },
        onNativeChange() {
          if (!self.#probing) self.#afterNative();
        },
        onNativeSubmit(text) {
          self.#onEditorSubmit(text);
        },
        onNativeCompletion() {
          self.#nativeCompletion = true;
        },
        canCommit() {
          return self.#canCommit();
        },
        onCallbackWrap(result) {
          self.#onCallbackWrap(result);
        },
      },
    };
    this.backend = new EditorHost(hostOptions);
    this.#syncDraft('unknown');
    if (this.#pi) {
      this.#unsub.push(
        this.#pi.on('input', (event) => {
          self.#onPiInput(event as { source?: string; text?: string });
        }),
        this.#pi.on('ui_prompt_start', () => {
          self.backend.setOverlay(true);
        }),
        this.#pi.on('ui_prompt_end', () => {
          self.backend.setOverlay(false);
        }),
      );
    }
    this.#unsub.push(
      this.#ctx.ui.onTerminalInput(() => {
        if (self.backend.ensureEditor()) {
          self.#ownershipLost = false;
          self.#syncDraft('unknown');
          self.#emit('unknown', { before: copy(self.#draft), deltas: [] });
          if (self.#ctx.ui.getEditorComponent() !== self.backend.factory) self.#noteExclusive();
          else self.#noteChainable();
        } else if (self.#ctx.ui.getEditorComponent() !== self.backend.factory) {
          self.#noteExclusive();
        }
      }),
    );
  }

  async ready(): Promise<HostCapabilities> {
    if (!this.#ready) this.#ready = this.#probe();
    return this.#ready;
  }

  getDraft(): Draft {
    return copy(this.#draft);
  }

  getState(): HostState {
    return copy(this.#state());
  }

  async applyEditIfVersion(edit: Edit, signal?: Cancellation): Promise<EditResult> {
    return this.#edit(edit, signal);
  }

  async applyAttributedEditIfVersion(
    edit: Edit,
    _attribution: EditAttribution,
    signal?: Cancellation,
  ): Promise<EditResult> {
    if (!this.caps.edit.attributed)
      return denied('unsupported', 'Pi attributed edits need a successful provider probe');
    return this.#edit(edit, signal);
  }

  async restoreDraft(draft: Draft, expectedVersion: number, signal?: Cancellation): Promise<EditResult> {
    const editor = this.backend.getEditor();
    return this.#edit(
      { from: 0, to: editor.getText().length, insert: draft.text, baseVersion: expectedVersion },
      signal,
      draft,
    );
  }

  showGhost(text: string | null, baseVersion: number): ActionResult {
    if (text && this.#draft.cursor !== this.#draft.text.length) return result('unsupported');
    return this.#present(this.caps.ghost !== 'none', baseVersion, () => {
      this.backend.paint.ghostOwner = null;
      this.backend.showGhost(text);
    });
  }

  showAttributedGhost(text: string | null, baseVersion: number, pluginId: string): ActionResult {
    if (text && this.#draft.cursor !== this.#draft.text.length) return result('unsupported');
    return this.#present(this.caps.ghost !== 'none', baseVersion, () => {
      this.backend.paint.ghostOwner = text === null ? null : pluginId;
      this.backend.showGhost(text);
    });
  }

  showMenu(items: readonly PresentedMenuItem[] | null, selected: number, baseVersion: number): ActionResult {
    return this.#present(this.caps.menu, baseVersion, () => {
      this.backend.showMenu(
        items?.map((item) => ({
          label: item.label,
          ...(item.detail ? { detail: item.detail } : {}),
          owner: item.owner,
        })) ?? null,
        selected,
      );
    });
  }

  showHighlight(ranges: readonly Range[] | null, baseVersion: number): ActionResult {
    if (baseVersion !== this.#draft.version) return result('stale');
    if (ranges && !this.#highlightOk(ranges)) return result('unsupported');
    return this.#present(this.caps.highlight !== 'none', baseVersion, () => {
      this.backend.showHighlight(ranges, this.#draft.text);
    });
  }

  showStatus(text: string | null, baseVersion: number): ActionResult {
    return this.#present(this.caps.status, baseVersion, () => this.backend.showStatus(text));
  }

  onDraftChange(callback: (change: Change) => void): Unsubscribe {
    return this.#sub(this.#changes, callback);
  }
  onKey(callback: (key: KeyId) => 'consume' | 'pass'): Unsubscribe {
    return this.#sub(this.#keys, callback);
  }
  onBeforeSubmit(callback: (tx: SubmitTransaction) => Promise<SubmitOutcome>): Unsubscribe {
    return this.#sub(this.#submits, callback);
  }
  onSubmitCommitted(callback: (event: HostSubmitAccepted) => void): Unsubscribe {
    return this.#sub(this.#committed, callback);
  }
  onInlineEdit(evaluate: (snapshot: InlineSnapshot) => InlineAnswer): Unsubscribe {
    return this.#sub(this.#inline, evaluate);
  }
  onInlineCommit(callback: (commit: InlineCommit) => void): Unsubscribe {
    return this.#sub(this.#commits, callback);
  }
  onInlineReject(callback: (rejection: InlineRejection) => void): Unsubscribe {
    return this.#sub(this.#rejects, callback);
  }
  onAction(callback: (action: ActionId) => void): Unsubscribe {
    return this.#sub(this.#actions, callback);
  }
  onMenuSelect(callback: (selection: MenuSelection) => void): Unsubscribe {
    return this.#sub(this.#menus, callback);
  }

  ensureEditor(): boolean {
    return this.backend.ensureEditor();
  }

  snapshot(): {
    readonly draft: Draft;
    readonly state: HostState;
    readonly caps: HostCapabilities;
    readonly ownsEditor: boolean;
    readonly subscriptions: number;
    readonly notices: readonly string[];
  } {
    return {
      draft: this.getDraft(),
      state: this.getState(),
      caps: copy(this.caps),
      ownsEditor: this.backend.ownsEditor && this.#ctx.ui.getEditorComponent() === this.backend.factory,
      subscriptions:
        this.#changes.size +
        this.#keys.size +
        this.#submits.size +
        this.#committed.size +
        this.#inline.size +
        this.#commits.size,
      notices: [...this.notices],
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const off of this.#unsub) off();
    this.#unsub.length = 0;
    this.#changes.clear();
    this.#keys.clear();
    this.#submits.clear();
    this.#committed.clear();
    this.#inline.clear();
    this.#commits.clear();
    this.backend.dispose();
  }

  fill(text: string): void {
    this.backend.getEditor().setText(text);
    this.#syncDraft('unknown');
    this.#emit('unknown');
  }

  #state(): HostState {
    const editor = this.backend.editor;
    const opaque = editor ? editor.getText() !== editor.getExpandedText() : true;
    const owned =
      this.backend.ownsEditor && this.#ctx.ui.getEditorComponent() === this.backend.factory && !this.#ownershipLost;
    const certainty = owned && !opaque && editor?.focused !== false ? 'authoritative' : 'unknown';
    const prefix = this.#draft.text.trimStart();
    const dialog = this.backend.hasOverlay();
    const popup = editor?.isShowingAutocomplete() ? { owner: 'host' } : null;
    return {
      mode:
        certainty === 'unknown'
          ? 'unknown'
          : prefix.startsWith('!')
            ? 'shell'
            : prefix.startsWith('/')
              ? 'command'
              : 'prose',
      popup,
      dialog,
      busy: !this.#ctx.isIdle(),
      editorMode: editor?.focused === false ? 'unknown' : 'insert',
      history: this.#history,
    };
  }

  #syncDraft(origin: Origin, spans?: readonly Range[]): void {
    const editor = this.backend.editor;
    if (!editor) return;
    const text = editor.getText();
    const cursor = this.backend.cursor();
    const opaque = text !== editor.getExpandedText();
    const owned = this.backend.ownsEditor && !this.#ownershipLost;
    const certainty = owned && !opaque && editor.focused !== false ? 'authoritative' : 'unknown';
    const next: Draft = {
      text,
      cursor,
      version: this.#draft.version,
      certainty,
      typedSpans: certainty === 'authoritative' ? (spans ?? this.#draft.typedSpans) : [],
    };
    this.#draft =
      origin === 'history' || origin === 'unknown' || origin === 'native-menu'
        ? { ...next, typedSpans: spans ?? [] }
        : next;
  }

  #emit(origin: Origin, info: { before?: Draft; deltas?: readonly DraftDelta[]; pluginId?: string } = {}): void {
    if (this.#probing || this.#disposed) return;
    const before = info.before ?? copy(this.#draft);
    this.#syncDraft(origin, this.#draft.typedSpans);
    this.#draft = { ...this.#draft, version: this.#draft.version + 1 };
    const change: Change = {
      draft: copy(this.#draft),
      origin,
      before,
      deltas:
        info.deltas ??
        (before.text === this.#draft.text
          ? []
          : [{ origin, from: 0, to: before.text.length, insert: this.#draft.text }]),
      ...(info.pluginId ? { pluginId: info.pluginId } : {}),
    };
    if (this.#mutation) this.#mutation.committed = copy(this.#draft);
    this.backend.paint.ghost = null;
    this.backend.paint.highlight = null;
    for (const cb of [...this.#changes]) cb(copy(change));
  }

  #onInput(data: string, editor: PiEditor): void {
    if (this.backend.operation) {
      this.backend.aborted = this.backend.operation;
      this.backend.finish(false);
    }
    if (data === '\t') this.backend.aborted = null;
    const decoded = decodeKey(data, this.backend.tuiApi.parseKey, this.backend.bindings, editor);
    const beforeText = editor.getText();
    const beforeCursor = this.backend.cursor();
    let origin: Origin =
      isPrintableRaw(data) || ['Newline', 'Backspace', 'Left', 'Right', 'Up', 'Down'].includes(decoded.id)
        ? 'typed'
        : 'unknown';
    if (isBracketedPaste(data)) origin = 'paste';
    else if (
      (decoded.id === 'Up' && (beforeText === '' || editor.getCursor().col === 0 || this.#history)) ||
      (decoded.id === 'Down' && this.#history)
    ) {
      origin = 'history';
    } else if (decoded.kind === 'undo') origin = 'undo';
    else if (decoded.kind === 'submit' || decoded.kind === 'queue') origin = 'unknown';
    this.#input = { origin, key: decoded.id, data, before: { text: beforeText, cursor: beforeCursor } };
    this.#history =
      decoded.id === 'Up' && (beforeText === '' || editor.getCursor().col === 0)
        ? true
        : decoded.id === 'Up' || decoded.id === 'Down'
          ? this.#history
          : false;
    this.#submitMutation = null;

    let consume: 'consume' | 'pass' = 'pass';
    if (!this.#probing && !this.#disposed) {
      for (const cb of [...this.#keys]) {
        try {
          if (cb(decoded.id) === 'consume') consume = 'consume';
        } catch (error) {
          this.#log({ event: 'key-error', message: String(error) });
        }
      }
    }
    if (consume === 'consume') return;

    if (this.#inlineInput(data, decoded.id, origin, editor)) return;

    if (
      !this.#probing &&
      (decoded.kind === 'submit' || decoded.kind === 'queue') &&
      beforeText.trim() &&
      !editor.isShowingAutocomplete() &&
      !this.backend.hasOverlay()
    ) {
      const gesture: SubmitGesture =
        decoded.kind === 'queue' ? (this.#ctx.isIdle() ? 'send' : 'queue') : this.#ctx.isIdle() ? 'send' : 'steer';
      void this.#submit(data, gesture);
      return;
    }

    this.backend.nativeKey(data);
    if (!this.#probing) this.#afterNative();
  }

  #inlineInput(data: string, key: KeyId, origin: Origin, editor: PiEditor): boolean {
    if (this.#probing || this.#disposed || !this.#inline.size) return false;
    if ((!data || (!isPrintableRaw(data) && !INLINE_KEYS.has(key))) && !isBracketedPaste(data)) return false;
    if (this.#draft.certainty !== 'authoritative') return false;
    const d = copy(this.#draft);
    const s = this.#state();
    const action = INLINE_KEYS.has(key);
    let from = d.cursor;
    if (key === 'Backspace' && from > 0) from = graphemeBefore(d.text, from);
    const deltas: DraftDelta[] =
      key === 'Undo' || key === 'F6'
        ? []
        : [
            {
              origin: origin === 'typed' || origin === 'paste' ? origin : 'unknown',
              from,
              to: d.cursor,
              insert: key === 'Backspace' ? '' : isBracketedPaste(data) ? stripPasteMarkers(data) : data,
            },
          ];
    const snapshot: InlineSnapshot = {
      certainty: d.certainty,
      deltas,
      transactionId: `pi:${++this.#inlineId}`,
      version: d.version,
      text: d.text,
      cursor: d.cursor,
      typedSpans: d.typedSpans,
      origin: action ? 'typed' : origin === 'typed' || origin === 'paste' ? origin : 'unknown',
      key: {
        id: key,
        inputText: origin === 'typed' && data.length === 1 && isPrintableRaw(data) ? data : '',
        from: d.cursor,
        to: d.cursor,
      },
      state: s,
    };
    let answer: InlineAnswer = { action: 'native' };
    try {
      for (const evaluate of [...this.#inline]) {
        answer = evaluate(snapshot);
        if (answer.action === 'replace') break;
      }
    } catch (error) {
      this.#log({ event: 'inline-error', message: String(error) });
      answer = { action: 'native' };
    }
    if (answer.action === 'replace') {
      const isRevert = INLINE_KEYS.has(key);
      const rawText = isRevert ? d.text : d.text.slice(0, d.cursor) + data + d.text.slice(d.cursor);
      let status: InlineCommit['status'] = 'applied';
      try {
        this.backend.syncChange(() => {
          if (!isRevert) {
            this.backend.nativeKey(data);
            if (editor.getText() !== rawText) throw new Error('Native boundary changed unexpectedly');
          }
          if (key === 'Undo' && this.#lastNativeInline?.version === d.version) {
            this.backend.nativeKey(data);
            this.nativeInlineUndos++;
            if (editor.getText() !== answer.text) editor.setText(answer.text);
          } else {
            editor.setText(answer.text);
            if (key === 'Undo' || key === 'F6') this.patchInlineUndos++;
          }
          this.backend.placeCursor(answer.cursor);
        });
      } catch (error) {
        status = 'fallback';
        this.#log({ event: 'inline-error', message: String(error) });
      }
      const replay = answer.replay;
      const spans = replay?.typedSpans ?? [];
      this.#syncDraft(isRevert ? 'undo' : 'plugin', spans);
      this.#draft = { ...this.#draft, cursor: this.backend.cursor(), text: editor.getText() };
      this.#emit(isRevert ? 'undo' : 'plugin', {
        before: replay?.before ?? d,
        ...(replay?.deltas ? { deltas: replay.deltas } : {}),
        pluginId: answer.owner,
      });
      this.#lastNativeInline = isRevert ? null : { version: this.#draft.version };
      this.#ack(snapshot.transactionId, status);
      if (isRevert && key === 'Backspace') {
        const original = answer.undo?.beforeText.slice(
          answer.undo.beforeCursor - (answer.replay?.corrections[0]?.original.length ?? 0),
          answer.undo.beforeCursor,
        );
        const word = answer.replay?.corrections[0]?.original ?? original ?? '';
        if (word) {
          for (const cb of [...this.#rejects]) {
            cb({
              transactionId: snapshot.transactionId,
              original: word,
              text: this.#draft.text,
              cursor: this.#draft.cursor,
              version: this.#draft.version,
            });
          }
        }
      }
      return true;
    }
    if (answer.replay) {
      this.backend.syncChange(() => this.backend.nativeKey(data));
      const applied = applyChange(d, answer.replay.deltas, labeled);
      this.#draft = { ...applied, cursor: this.backend.cursor(), text: editor.getText() };
      this.#emit(action ? 'undo' : origin, { before: answer.replay.before, deltas: answer.replay.deltas });
      this.#ack(snapshot.transactionId, 'applied');
      return true;
    }
    this.backend.nativeKey(data);
    this.#afterNative();
    this.#ack(snapshot.transactionId, 'applied');
    return true;
  }

  #afterNative(): void {
    if (this.#probing || this.#disposed) return;
    const editor = this.backend.getEditor();
    const text = editor.getText();
    const cursor = this.backend.cursor();
    const before = copy(this.#draft);
    if (text === before.text && cursor === before.cursor) return;
    const origin: Origin = this.#nativeCompletion ? 'native-menu' : (this.#input?.origin ?? 'unknown');
    this.#nativeCompletion = false;
    let splice: DraftDelta | undefined;
    const input = this.#input;
    if ((origin === 'typed' || origin === 'paste') && input) {
      const insert =
        input.key === 'Enter' && input.data === '\n'
          ? '\n'
          : origin === 'paste'
            ? stripPasteMarkers(input.data)
            : input.data;
      if (
        input.before.text.slice(0, input.before.cursor) + insert + input.before.text.slice(input.before.cursor) ===
        text
      ) {
        splice = { origin, from: input.before.cursor, to: input.before.cursor, insert };
      } else if (
        cursor < input.before.cursor &&
        input.before.text.slice(0, cursor) + input.before.text.slice(input.before.cursor) === text
      ) {
        splice = { origin, from: cursor, to: input.before.cursor, insert: '' };
      }
    }
    const deltas = splice
      ? [splice]
      : origin === 'history'
        ? [{ origin, from: 0, to: before.text.length, insert: text }]
        : [{ origin, from: 0, to: before.text.length, insert: text }];
    const next = applyChange(before, deltas, labeled);
    this.#draft = { ...next, version: before.version, cursor, text };
    this.#emit(origin, { before, deltas });
  }

  #ack(transactionId: string, status: InlineCommit['status']): void {
    const commit: InlineCommit = {
      transactionId,
      status,
      text: this.#draft.text,
      cursor: this.#draft.cursor,
      version: this.#draft.version,
    };
    for (const cb of [...this.#commits]) cb(commit);
  }

  #canCommit(): boolean {
    if (this.#probing) return true;
    const s = this.#state();
    if (this.#disposed || s.dialog || s.popup || this.#draft.certainty === 'unknown') return false;
    if (this.#submitMutation && !this.#mutation && this.#submitMutation.expected !== this.#draft.version) return false;
    return (
      !this.#mutation ||
      (!this.#mutation.signal?.cancelled &&
        this.#mutation.expected === this.#draft.version &&
        s.mode === 'prose' &&
        !s.busy &&
        !s.history &&
        s.editorMode === 'insert')
    );
  }

  async #edit(edit: Edit, signal?: Cancellation, restore?: Draft): Promise<EditResult> {
    if (this.#disposed || signal?.cancelled) return denied('cancelled');
    if (edit.baseVersion !== this.#draft.version) return denied('stale');
    const d = this.#draft;
    const s = this.#state();
    if (d.certainty !== 'authoritative') return denied('unsupported');
    if (s.dialog || s.popup || s.busy || s.mode !== 'prose' || s.history) return denied('denied');
    if (
      !Number.isInteger(edit.from) ||
      !Number.isInteger(edit.to) ||
      edit.from < 0 ||
      edit.to < edit.from ||
      edit.to > d.text.length ||
      typeof edit.insert !== 'string'
    ) {
      return denied('invalid-range');
    }
    if (restore?.selection) return denied('unsupported');
    if (this.#mutation) return denied('cancelled');
    const op: {
      expected: number;
      origin: Origin;
      edit: { from: number; to: number; insert: string };
      committed: Draft | null;
      signal?: Cancellation;
      restoreSpans?: readonly Range[];
    } = {
      expected: this.#draft.version,
      origin: restore ? 'undo' : 'plugin',
      edit: { from: edit.from, to: edit.to, insert: edit.insert },
      committed: null,
      ...(signal ? { signal } : {}),
      ...(restore?.typedSpans ? { restoreSpans: restore.typedSpans } : {}),
    };
    this.#mutation = op;
    try {
      const before = { text: d.text, cursor: d.cursor, version: d.version };
      const text = restore ? restore.text : d.text.slice(0, edit.from) + edit.insert + d.text.slice(edit.to);
      const cursor = restore
        ? restore.cursor
        : d.cursor < edit.from
          ? d.cursor
          : d.cursor > edit.to
            ? d.cursor + edit.insert.length - (edit.to - edit.from)
            : edit.from + edit.insert.length;
      const ok = await this.backend.transaction(before, text, cursor);
      if (ok && op.committed) return { status: 'applied', draft: op.committed };
      return denied(signal?.cancelled ? 'cancelled' : op.expected !== this.#draft.version ? 'stale' : 'error');
    } finally {
      if (this.#mutation === op) this.#mutation = null;
    }
  }

  async #submit(data: string, gesture: SubmitGesture): Promise<void> {
    const before = copy(this.#draft);
    let draft = before;
    let decision: SubmitOutcome = { action: 'send', coverage: 'managed' };
    try {
      for (const cb of [...this.#submits]) {
        const tx: SubmitTransaction = { draft, gesture, position: 'managed' };
        decision = await cb(copy(tx));
        if (decision.action === 'block') break;
        if (decision.action === 'replace') draft = { ...draft, text: decision.text, cursor: decision.text.length };
      }
      if (this.#draft.version !== before.version) return;
      if (decision.action === 'block') {
        this.backend.showStatus(decision.reason);
        return;
      }
      if (decision.action === 'replace') {
        const ok = await this.backend.transaction(
          { text: before.text, cursor: before.cursor, version: before.version },
          decision.text,
          decision.text.length,
        );
        if (!ok || this.backend.getEditor().getText() !== decision.text) return;
      }
      const sent = decision.action === 'replace' ? decision.text : before.text;
      this.#forwarded = { text: sent, gesture, id: `pi-submit:${++this.#submissions}` };
      this.backend.nativeKey(data);
    } catch (error) {
      this.backend.showStatus(`Submit blocked: ${String(error)}`);
      this.#log({ event: 'submit-error', message: String(error) });
    }
  }

  #onEditorSubmit(text: string): void {
    const forwarded = this.#forwarded;
    if (forwarded && forwarded.text === text) return;
  }

  #onPiInput(event: { source?: string; text?: string }): void {
    const forwarded = this.#forwarded;
    if (!forwarded || event.source !== 'interactive' || event.text !== forwarded.text) return;
    const accepted: HostSubmitAccepted = {
      text: forwarded.text,
      gesture: forwarded.gesture,
      submissionId: forwarded.id,
      position: 'managed',
      typedSpans: this.#draft.typedSpans,
    };
    this.#forwarded = null;
    for (const cb of [...this.#committed]) cb(accepted);
  }

  #present(supported: boolean, version: number, fn: () => void): ActionResult {
    if (this.#disposed) return result('cancelled');
    if (version !== this.#draft.version) return result('stale');
    if (!supported) return result('unsupported');
    try {
      fn();
      return result('applied');
    } catch (error) {
      return result('error', String(error));
    }
  }

  #highlightOk(ranges: readonly Range[]): boolean {
    const editor = this.backend.editor;
    if (!editor) return false;
    const d = this.#draft;
    const c = editor.getCursor();
    const start = editor
      .getLines()
      .slice(0, c.line)
      .reduce((n, line) => n + line.length + 1, 0);
    const line = editor.getLines()[c.line] ?? '';
    const rows = editor.render(this.backend.lastWidth);
    const row = rows.find((r) => r.includes(this.backend.tuiApi.CURSOR_MARKER ?? '\x1b_pi:c\x07'));
    if (!row) return false;
    return ranges.every(([a, b]) => {
      const word = d.text.slice(a, b);
      return (
        a >= start &&
        b <= start + line.length &&
        /^[A-Za-z]{2,}$/.test(word) &&
        line.indexOf(word) === line.lastIndexOf(word) &&
        row.indexOf(word) >= 0 &&
        row.indexOf(word) === row.lastIndexOf(word)
      );
    });
  }

  #setStatus(text: string): void {
    this.notices.push(text);
    this.backend.showStatus(text);
  }

  #note(text: string | undefined): void {
    if (!text) return;
    this.#setStatus(text);
  }

  #onCallbackWrap(result: { key: 'onChange' | 'onSubmit'; accessor: boolean } | { key: string; refused: true }): void {
    if ('refused' in result) {
      this.#note(
        this.boundaries.record({
          boundary: 'unsafe-callback',
          evidence: { kind: 'accessor-descriptor', configurable: false, accessor: true, detail: result.key },
          action: 'refuse',
        }),
      );
      return;
    }
    if (!result.accessor) return;
    this.#note(
      this.boundaries.record({
        boundary: 'unsafe-callback',
        evidence: { kind: 'accessor-descriptor', configurable: true, accessor: true, detail: result.key },
        action: 'compose',
      }),
    );
  }

  #noteExclusive(): void {
    const first = !this.#ownershipLost;
    this.#ownershipLost = true;
    this.backend.exclusive = true;
    if (first) this.#setStatus(OWNERSHIP_LOST);
    this.#note(
      this.boundaries.record({
        boundary: 'exclusive-editor',
        evidence: { kind: 'factory-identity' },
        action: 'suppress',
      }),
    );
    const coexistence = coexistenceFor('pi', { editorComposition: 'exclusive' });
    this.caps = {
      ...this.caps,
      inlineRewrite: 'unsupported',
      inline: { ...this.caps.inline, nativeCompletion: false, commitReceipt: 'none' },
      ghost: 'none',
      highlight: 'none',
      coexistence,
    };
  }

  #noteChainable(): void {
    this.caps = {
      ...this.caps,
      coexistence: coexistenceFor('pi', { editorComposition: 'chainable' }),
    };
  }

  #sub<T>(set: Set<T>, value: T): Unsubscribe {
    set.add(value);
    return () => {
      set.delete(value);
    };
  }

  async #probe(): Promise<HostCapabilities> {
    this.#probing = true;
    const editor = this.backend.getEditor();
    const saved = { text: editor.getText(), cursor: this.backend.cursor() };
    const notices: string[] = [];
    const readDraft = typeof editor.getText === 'function';
    let inlineEnd = false;
    let inlineMiddle = false;
    let inlineMultiline = false;
    try {
      for (const [text, cursor, label] of [
        ['teh ', 4, 'end'],
        ['a teh  tail', 6, 'middle'],
        ['a\nteh  tail', 6, 'multiline'],
      ] as const) {
        const changed = text.replace('teh', 'the');
        this.backend.syncChange(() => {
          editor.setText(text);
          this.backend.placeCursor(cursor);
          editor.setText(changed);
          this.backend.placeCursor(cursor);
          this.backend.nativeKey('\x1f');
        });
        const ok = editor.getText() === text && this.backend.cursor() === cursor;
        if (label === 'end') inlineEnd = ok;
        if (label === 'middle') inlineMiddle = ok;
        if (label === 'multiline') inlineMultiline = ok;
      }
    } catch (error) {
      this.#log({ event: 'inline-probe-failed', message: String(error) });
      notices.push('inline rewrite');
    }
    const before = { text: editor.getText(), cursor: this.backend.cursor(), version: 0 };
    const probeText = 'probe 日本語 😀\nsecond';
    const atomic = await this.backend.transaction(before, probeText, probeText.length);
    const multiline = atomic && editor.getText() === probeText && editor.getCursor().line === 1;
    const restored = await this.backend.transaction(
      { text: editor.getText(), cursor: this.backend.cursor(), version: 1 },
      saved.text,
      saved.cursor,
    );
    if (!atomic || !restored) notices.push('async edits');

    const markerOk =
      typeof this.backend.tuiApi.CURSOR_MARKER === 'string' &&
      typeof this.backend.tuiApi.renderFakeCursor === 'function';
    this.backend.showGhost('ghost-probe');
    const ghostRows = editor.render(120);
    const ghostOk =
      markerOk &&
      this.backend.cursorFormatDetected(ghostRows) &&
      ghostRows.some((row) => row.includes('host-probe') || row.includes('ghost-probe'));
    this.backend.showGhost(null);
    if (!ghostOk) notices.push('ghost');

    this.backend.showMenu([{ label: 'menu-probe' }], 0);
    const menuOk =
      typeof this.backend.tuiApi.truncateToWidth === 'function' &&
      editor.render(120).some((row) => row.includes('menu-probe'));
    this.backend.showMenu(null, 0);
    if (!menuOk) notices.push('menu');

    editor.setText('highlight-probe');
    this.backend.showHighlight([[0, 9]], 'highlight-probe');
    const highlightOk = editor.render(120).some((row) => row.includes('\x1b[4m'));
    this.backend.showHighlight(null, null);
    if (!highlightOk) notices.push('highlight');

    this.backend.showStatus('status-probe');
    const statusOk = editor.render(120).some((row) => row.includes('status-probe'));
    this.backend.setOverlay(true);
    const hidden = !editor.render(120).some((row) => row.includes('status-probe'));
    this.backend.setOverlay(false);
    this.backend.showStatus(null);
    if (!statusOk) notices.push('status');
    const dialogSafe = statusOk && hidden;

    const expandedOk = typeof editor.getExpandedText === 'function';
    const popupOk = typeof editor.isShowingAutocomplete === 'function';
    const overlayOk = typeof this.backend.tui?.hasOverlay === 'function' || true;
    if (!expandedOk) notices.push('opaque drafts');
    if (!popupOk) notices.push('popup');
    if (!overlayOk) notices.push('dialog');

    const slotOk = this.#ctx.ui.getEditorComponent() === this.backend.factory;
    if (!slotOk) notices.push('editor slot');
    const coexistence = coexistenceFor('pi', { editorComposition: slotOk ? 'chainable' : 'exclusive' });

    const seen = new Set<KeyId>();
    const prev = [...this.#keys];
    this.#keys.clear();
    this.#keys.add((key) => {
      seen.add(key);
      return 'consume';
    });
    for (const raw of [
      '\t',
      '\r',
      '\x1b',
      '\x1b[A',
      '\x1b[B',
      '\x1b[D',
      '\x1b[C',
      '\x7f',
      '\x1b[17~',
      '\x1f',
      '\n',
      ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
    ]) {
      editor.handleInput(raw);
    }
    this.#keys.clear();
    for (const cb of prev) this.#keys.add(cb);

    editor.setText(saved.text);
    this.backend.placeCursor(saved.cursor);
    this.#draft = { text: saved.text, cursor: saved.cursor, version: 0, certainty: 'authoritative', typedSpans: [] };
    this.#probing = false;

    const keys = [...seen];
    this.caps = piCaps({
      inputOriginEvidence: 'host-labeled',
      semanticMenuSelection: false,
      actions: ['murmo.undo', 'murmo.menu'],
      inlineRewrite: inlineEnd ? 'same-transaction' : 'unsupported',
      inline: {
        attributed: true,
        middle: inlineMiddle,
        multiline: inlineMultiline,
        observedKeys: keys.length ? keys : [...OBSERVED_KEYS],
        allKeysObserved: true,
        nativeCompletion: false,
        commitReceipt: inlineEnd ? 'native-commit' : 'none',
        maxBytes: 16384,
      },
      readDraft,
      edit: {
        atomic: atomic && restored,
        end: atomic && restored,
        middle: atomic && restored,
        multiline,
        selection: false,
        exactRestore: restored,
        certainties: ['authoritative'],
        attributed: atomic && restored,
      },
      ghost: ghostOk ? 'end-only' : 'none',
      menu: menuOk,
      highlight: highlightOk ? 'visible-row' : 'none',
      status: statusOk,
      keys: keys.length ? keys : [...OBSERVED_KEYS],
      undoKeys: ['Undo', 'F6'],
      keyPriority: 'unknown',
      submit: {
        transform: true,
        block: true,
        gestures: ['send', 'queue', 'steer'],
        guardPosition: 'managed',
        committed: 'accepted-text',
      },
      ui: {
        dialogSafe,
        anchor: 'host-owned',
        statusMaxLength: 512,
        normalization: 'preserve',
        opaqueParts: true,
      },
      coexistence,
    });
    if (!inlineEnd) this.caps = { ...this.caps, inlineRewrite: 'unsupported' };
    if (notices.length) {
      const message = `Murmo: off: ${notices.join(', ')}`;
      this.notices.push(message);
      this.#ctx.ui.notify(message, 'warning');
    }
    this.#log({ event: 'capabilities', caps: this.caps, notices });
    return copy(this.caps);
  }
}

export function createPiAdapter(options: PiAdapterOptions): { adapter: PiAdapter; backend: EditorHost } {
  const adapter = new PiAdapter(options);
  return { adapter, backend: adapter.backend };
}
