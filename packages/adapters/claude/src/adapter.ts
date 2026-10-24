// Claude adapter: keyed `prompt.edit` as same-transaction rewrite, keyless
// input as `unknown`, Backspace rejection receipts, no async CAS (docs/plan/24).

import type {
  ActionId,
  ActionResult,
  Cancellation,
  Change,
  Draft,
  DraftDelta,
  Edit,
  EditResult,
  HighlightMark,
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
  InlineReplay,
  InlineSnapshot,
  MenuSelection,
  PresentedMenuItem,
  ReviewPanel,
  SubmitOutcome,
  Unsubscribe,
} from '@murmo/api/adapter';
import { BoundaryBook } from '@murmo/core';
import { applyChange, type TypingRules } from '@murmo/provenance';
import { displayText, isSingleCodePoint } from '@murmo/text';
import { claudeCaps, disableInline } from './caps.ts';
import { canonicalKey, isKeyedSingle } from './keys.ts';
import type {
  AutocompleteInput,
  AutocompleteResult,
  AutocompleteSuggestion,
  ClassicSubmitInput,
  ClassicSubmitResult,
  ClaudeRuntime,
  ProbeFlags,
  PromptChangeInput,
  PromptDecoration,
  PromptEditInput,
  PromptEditResult,
  PromptHintProps,
  PromptSubmitInput,
  PromptSubmitResult,
} from './types.ts';
import { defaultProbes, HINT_SEPARATOR, INLINE_DISABLED_NOTICE, TESTED_HOST } from './types.ts';

const typing: TypingRules = { evidence: 'host-labeled', keyBursts: false };

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const emptyDraft = (): Draft => ({
  text: '',
  cursor: 0,
  version: 0,
  certainty: 'authoritative',
  typedSpans: [],
});

const emptyState = (): HostState => ({
  mode: 'prose',
  popup: null,
  dialog: false,
  busy: false,
  editorMode: 'insert',
  history: false,
});

function originOfChange(kind: string): Origin {
  if (kind === 'history') return 'history';
  if (kind === 'undo') return 'undo';
  if (kind === 'plugin') return 'plugin';
  if (kind === 'engine') return 'native-menu';
  return 'unknown';
}

function smallestSplice(event: PromptEditInput, target: string): PromptEditInput {
  if (typeof target !== 'string') return event;
  let start = 0;
  let end = event.text.length;
  let to = target.length;
  while (start < end && start < to && event.text[start] === target[start]) start++;
  while (end > start && to > start && event.text[end - 1] === target[to - 1]) {
    end--;
    to--;
  }
  return { ...event, start, end, inputText: target.slice(start, to) };
}

function subscribe<T>(set: Set<T>, callback: T): Unsubscribe {
  set.add(callback);
  return () => {
    set.delete(callback);
  };
}

export interface ClaudeAdapterOptions {
  readonly version?: string;
  readonly hidePromptEdit?: boolean;
  readonly hideClassic?: boolean;
  readonly hideAutocomplete?: boolean;
  readonly hideVirtualText?: boolean;
  readonly skipProbes?: boolean;
}

interface OwnedEdit {
  readonly transactionId: string;
  readonly original: string;
  readonly before: { readonly text: string; readonly cursor: number; readonly rejectSeparator: boolean };
  readonly after: { readonly text: string; readonly cursor: number };
  readonly version: number;
}

interface PendingCommit {
  readonly id: string;
  readonly expected: { readonly text: string; readonly cursor: number };
  readonly version: number;
}

export class ClaudeAdapter implements Adapter {
  readonly host: { readonly name: 'claude'; readonly version: string };
  caps: HostCapabilities;
  readonly probes: ProbeFlags;
  readonly notices: string[] = [];
  readonly boundaries = new BoundaryBook();

  #draft: Draft = emptyDraft();
  #state: HostState = emptyState();
  #ghost: string | null = null;
  #menu: readonly PresentedMenuItem[] | null = null;
  #highlight: readonly Range[] | null = null;
  #status: string | null = null;
  #probe = false;
  #ready = false;
  #baselineHint: string | null = null;
  #opaque = false;
  #owned: OwnedEdit | null = null;
  #pending: PendingCommit | null = null;
  #pendingClear: PromptChangeInput | null = null;
  #offered = new Map<string, { readonly before: PromptBoxLike; readonly original: string }>();
  #inlineSeq = 0;
  #inputEpoch = 0;
  readonly #changes = new Set<(change: Change) => void>();
  readonly #keys = new Set<(key: KeyId) => 'consume' | 'pass'>();
  readonly #submits = new Set<(tx: SubmitTransaction) => Promise<SubmitOutcome>>();
  readonly #inline = new Set<(snapshot: InlineSnapshot) => InlineAnswer>();
  readonly #inlineCommits = new Set<(commit: InlineCommit) => void>();
  readonly #inlineRejects = new Set<(rejection: InlineRejection) => void>();
  readonly #menuSelects = new Set<(selection: MenuSelection) => void>();
  readonly #actions = new Set<(action: ActionId) => void>();
  readonly #committed = new Set<(event: HostSubmitAccepted) => void>();
  readonly #options: ClaudeAdapterOptions;
  readonly rt: ClaudeRuntime | undefined;

  constructor(options: ClaudeAdapterOptions = {}, runtime?: ClaudeRuntime) {
    this.#options = options;
    this.rt = runtime;
    this.host = { name: 'claude', version: options.version ?? TESTED_HOST };
    this.caps = claudeCaps();
    this.probes = defaultProbes();
    if (options.hidePromptEdit) {
      this.probes.promptEdit = false;
      this.caps = disableInline(this.caps);
    }
    if (options.hideClassic) this.probes.classicGuard = false;
    if (options.hideAutocomplete) {
      this.probes.autocomplete = false;
      this.caps = { ...this.caps, menu: false, inline: { ...this.caps.inline, nativeCompletion: false } };
    }
    if (options.hideVirtualText) {
      this.probes.virtualText = false;
      this.caps = { ...this.caps, ghost: 'none' };
    }
  }

  async ready(): Promise<HostCapabilities> {
    if (this.#ready) return this.caps;
    this.#probe = true;
    try {
      if (!this.#options.skipProbes && this.rt && this.probes.promptEdit) await this.#probeHost(this.rt);
    } finally {
      this.#probe = false;
      this.#ready = true;
    }
    if (!this.probes.promptEdit && !this.notices.includes(INLINE_DISABLED_NOTICE)) {
      this.notices.push(INLINE_DISABLED_NOTICE);
      this.caps = disableInline(this.caps);
    }
    if (!this.probes.classicGuard) {
      this.caps = {
        ...this.caps,
        submit: { ...this.caps.submit, transform: false, guardPosition: 'final-boundary' },
      };
    }
    return this.caps;
  }

  getDraft(): Draft {
    return copy(this.#draft);
  }

  getState(): HostState {
    return copy(this.#state);
  }

  async applyEditIfVersion(_edit: Edit, signal?: Cancellation): Promise<EditResult> {
    if (signal?.cancelled) return { status: 'cancelled' };
    return { status: 'unsupported', reason: 'public prompt.fill has no atomic expected-version commit' };
  }

  async applyAttributedEditIfVersion(
    edit: Edit,
    _attribution: EditAttribution,
    signal?: Cancellation,
  ): Promise<EditResult> {
    return this.applyEditIfVersion(edit, signal);
  }

  async restoreDraft(_draft: Draft, expectedVersion: number, signal?: Cancellation): Promise<EditResult> {
    if (signal?.cancelled) return { status: 'cancelled' };
    if (expectedVersion !== this.#draft.version) return { status: 'stale' };
    return { status: 'unsupported', reason: 'public fill cannot restore an arbitrary cursor or provide atomic commit' };
  }

  showGhost(text: string | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.ghost !== 'none', () => {
      this.#ghost = text;
    });
  }

  showAttributedGhost(text: string | null, baseVersion: number, _pluginId: string): ActionResult {
    if (!this.caps.inline.attributed && !this.caps.edit.attributed) {
      return { status: 'unsupported', reason: 'Claude does not attribute third-party ghosts' };
    }
    return this.showGhost(text, baseVersion);
  }

  showMenu(items: readonly PresentedMenuItem[] | null, _selected: number, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.menu, () => {
      this.#menu = items;
    });
  }

  showHighlight(ranges: readonly Range[] | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.highlight !== 'none', () => {
      this.#highlight = ranges;
    });
  }

  showStatus(text: string | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.status, () => {
      this.#status = text;
    });
  }

  showHighlightMarks(marks: readonly HighlightMark[] | null, baseVersion: number): ActionResult {
    return this.showHighlight(marks?.map((m) => m.range) ?? null, baseVersion);
  }

  showReview(panel: ReviewPanel | null, baseVersion: number): ActionResult {
    if (!panel) return this.showStatus(null, baseVersion);
    const body = panel.edits.map((e) => `[plugin ${e.pluginId}] ${e.after}`).join(' | ');
    return this.showStatus(`Review: ${body}`, baseVersion);
  }

  onDraftChange(callback: (change: Change) => void): Unsubscribe {
    return subscribe(this.#changes, callback);
  }

  onKey(callback: (key: KeyId) => 'consume' | 'pass'): Unsubscribe {
    return subscribe(this.#keys, callback);
  }

  onBeforeSubmit(callback: (tx: SubmitTransaction) => Promise<SubmitOutcome>): Unsubscribe {
    return subscribe(this.#submits, callback);
  }

  onInlineEdit(evaluate: (snapshot: InlineSnapshot) => InlineAnswer): Unsubscribe {
    return subscribe(this.#inline, evaluate);
  }

  onInlineCommit(callback: (commit: InlineCommit) => void): Unsubscribe {
    return subscribe(this.#inlineCommits, callback);
  }

  onInlineReject(callback: (rejection: InlineRejection) => void): Unsubscribe {
    return subscribe(this.#inlineRejects, callback);
  }

  onMenuSelect(callback: (selection: MenuSelection) => void): Unsubscribe {
    return subscribe(this.#menuSelects, callback);
  }

  onAction(callback: (action: ActionId) => void): Unsubscribe {
    return subscribe(this.#actions, callback);
  }

  onSubmitCommitted(callback: (event: HostSubmitAccepted) => void): Unsubscribe {
    return subscribe(this.#committed, callback);
  }

  /** Imperative plugin rows (no `inlineEdit`) currently shown. Enter must not send. */
  pluginMenuOpen(): boolean {
    return (this.#menu ?? []).some((item) => !item.inlineEdit);
  }

  nativeRows(): readonly PresentedMenuItem[] {
    return (this.#menu ?? []).filter((item) => item.inlineEdit);
  }

  statusLine(): string {
    const parts = [...this.notices];
    if (this.#status) parts.push(displayText(this.#status));
    return parts.join(HINT_SEPARATOR);
  }

  decorations(): PromptDecoration[] {
    const out: PromptDecoration[] = [];
    if (this.#ghost && this.caps.ghost !== 'none' && this.#draft.cursor === this.#draft.text.length) {
      out.push({
        start: this.#draft.cursor,
        end: this.#draft.cursor,
        virtualText: displayText(this.#ghost),
        dimColor: true,
      });
    }
    for (const [start, end] of this.#highlight ?? []) {
      out.push({ start, end, underline: true, color: 'warning' });
    }
    return out;
  }

  hint(props: PromptHintProps): void {
    this.#state = { ...this.#state, busy: props.isWorking === true };
    if (props.isWorking || props.isDraft || this.#draft.text) return;
    const prefix = props.hint.split(HINT_SEPARATOR)[0] ?? '';
    if (this.#baselineHint === null) {
      this.#baselineHint = prefix;
      this.#opaque = false;
    } else {
      this.#opaque = !props.hint.startsWith(this.#baselineHint);
    }
    this.#state = { ...this.#state, mode: this.#opaque ? 'unknown' : 'prose' };
  }

  measureHint(hint: string): void {
    const width = hint.length + (this.statusLine() ? this.statusLine().length + HINT_SEPARATOR.length : 0);
    if (width > 0) {
      this.caps = { ...this.caps, ui: { ...this.caps.ui, statusMaxLength: Math.max(24, 120 - hint.length) } };
    }
  }

  confirmIncoming(box: { readonly text: string; readonly cursor: number }, definitive = true): void {
    const pending = this.#pending;
    if (!pending) return;
    const match = box.text === pending.expected.text && box.cursor === pending.expected.cursor;
    if (!match && !definitive) return;
    this.#pending = null;
    this.#ack(pending.id, match ? 'applied' : 'fallback', box, pending.version);
    if (!match) this.#owned = null;
  }

  /** `prompt.edit`: evaluate before the first await (50 ms budget). */
  async handleEdit(
    event: PromptEditInput,
    next: (event: PromptEditInput) => PromptEditResult | Promise<PromptEditResult>,
  ): Promise<PromptEditResult> {
    this.#inputEpoch++;
    this.confirmIncoming(event);
    if (this.#pendingClear) {
      this.handleChange(this.#pendingClear);
      this.#pendingClear = null;
    }
    this.#observedBefore(event);
    const key = canonicalKey(event.key);
    const consumed = key ? this.#deliverKey(key) : 'pass';
    const plan = this.probes.promptEdit ? this.#plan(event, key) : null;
    let result: PromptEditResult;
    if (plan?.result) {
      const splice = smallestSplice(event, plan.result.text);
      const forwarded = await next(splice);
      result = { ...forwarded, cursor: plan.result.cursor };
      this.#commitReplace(plan, result);
    } else if (consumed === 'consume') {
      result = { text: event.text, cursor: event.cursor };
    } else {
      result = await next(event);
      this.#observedEdit(event, result, key);
      // A native key still ends a transaction: the receipt carries what the
      // rules planned across it (a fix pending on `.` waits for the next key).
      if (plan) this.#ack(plan.id, 'applied', result, this.#draft.version);
    }
    return { ...result, decorations: this.decorations() };
  }

  handleChange(event: PromptChangeInput): void {
    this.confirmIncoming(event);
    const kind = event.origin.kind;
    if (kind === 'clear') {
      this.#pendingClear = event;
      return;
    }
    this.#inputEpoch++;
    this.#pendingClear = null;
    const completion = kind === 'engine' ? this.#offered.get(event.text) : undefined;
    if (!completion) this.#owned = null;
    const origin = originOfChange(kind);
    this.#state = { ...this.#state, history: origin === 'history' };
    this.#adopt(event, origin, []);
    if (completion) {
      this.#owned = {
        transactionId: `completion-${this.#inlineSeq}`,
        original: completion.original,
        before: { text: completion.before.text, cursor: completion.before.cursor, rejectSeparator: false },
        after: { text: event.text, cursor: event.cursor },
        version: this.#draft.version,
      };
    }
  }

  async handleSubmit(
    event: PromptSubmitInput,
    next: (event: PromptSubmitInput) => PromptSubmitResult | Promise<PromptSubmitResult>,
  ): Promise<PromptSubmitResult> {
    this.#pendingClear = null;
    if (this.pluginMenuOpen()) {
      this.#deliverKey('Enter');
      this.#menu = null;
      return { drop: 'Plugin menu closed; send again to submit' };
    }
    const gesture: SubmitGesture = this.#state.busy ? 'queue' : 'send';
    const decision = await this.#runSubmit(event.text, 'managed', gesture);
    if (decision.action === 'block') return { drop: decision.reason };
    const epoch = this.#inputEpoch;
    const forwarded = decision.action === 'replace' ? { ...event, text: decision.text } : event;
    const result = await next(forwarded);
    if (result.drop === undefined && this.#inputEpoch === epoch) this.#noteClear();
    return result;
  }

  async handleClassic(
    event: ClassicSubmitInput,
    next: (event: ClassicSubmitInput) => ClassicSubmitResult | Promise<ClassicSubmitResult>,
  ): Promise<ClassicSubmitResult> {
    if (!this.probes.classicGuard)
      return { block: 'final-boundary guard required but classic.UserPromptSubmit is missing' };
    const decision = await this.#runSubmit(event.prompt, 'final-boundary', 'send');
    if (decision.action === 'block') return { block: decision.reason };
    if (decision.action === 'replace') return { block: 'final classic boundary cannot transform; blocked' };
    return next(event);
  }

  handleAutocomplete(event: AutocompleteInput, host: AutocompleteResult): AutocompleteResult {
    if (!this.probes.autocomplete || this.#state.mode !== 'prose') return host;
    const extra: AutocompleteSuggestion[] = [];
    this.#offered.clear();
    for (const item of this.nativeRows()) {
      const edit = item.inlineEdit;
      // Taking a row replaces Claude's token, so only a row validated for exactly that span may go in.
      if (!edit || edit.from !== event.start || edit.to !== event.start + event.token.length) continue;
      extra.push({
        text: edit.insert,
        label: displayText(item.label),
        ...(item.detail ? { description: displayText(item.detail).split('\n')[0] } : {}),
      });
      const text = event.text.slice(0, edit.from) + edit.insert + event.text.slice(edit.to);
      this.#offered.set(text, { before: { text: event.text, cursor: event.cursor }, original: event.token });
    }
    return { suggestions: [...host.suggestions, ...extra.slice(0, 8)] };
  }

  handleAbove(previous: unknown, box: { Box: unknown; Text: unknown }): unknown {
    const rows = (this.#menu ?? []).filter((item) => !item.inlineEdit).slice(0, 6);
    if (!rows.length) return previous;
    const { Box, Text } = box;
    const children: unknown[] = [previous];
    for (const item of rows) {
      children.push(callUi(Text, { key: item.id, dimColor: true, children: displayText(item.label) }));
    }
    return callUi(Box, { flexDirection: 'column', children });
  }

  noteHelper(ok: boolean): void {
    this.probes.helper = ok;
  }

  noteClassic(ok: boolean): void {
    this.probes.classicGuard = ok;
  }

  noteEdit(ok: boolean): void {
    this.probes.promptEdit = ok;
    if (!ok) {
      this.caps = disableInline(this.caps);
      if (!this.notices.includes(INLINE_DISABLED_NOTICE)) this.notices.push(INLINE_DISABLED_NOTICE);
    }
  }

  inputEpoch(): number {
    return this.#inputEpoch;
  }

  #present(version: number, supported: boolean, apply: () => void): ActionResult {
    if (version !== this.#draft.version) return { status: 'stale' };
    if (!supported) return { status: 'unsupported' };
    apply();
    return { status: 'applied' };
  }

  #deliverKey(key: KeyId): 'consume' | 'pass' {
    for (const callback of [...this.#keys]) {
      if (callback(key) === 'consume') return 'consume';
    }
    return 'pass';
  }

  #plan(event: PromptEditInput, key: KeyId | null): Plan | null {
    const owned = this.#owned;
    this.#owned = null;
    const snapshot = this.#snapshot(event, key);
    const answer = this.#evaluate(snapshot);
    if (answer.action === 'replace') {
      return {
        id: snapshot.transactionId,
        answer,
        result: { text: answer.text, cursor: answer.cursor },
        kind: 'inline',
      };
    }
    if (
      key === 'Backspace' &&
      owned &&
      owned.version === this.#draft.version &&
      owned.after.text === event.text &&
      owned.after.cursor === event.cursor
    ) {
      let text = owned.before.text;
      let cursor = owned.before.cursor;
      if (owned.before.rejectSeparator && cursor > 0 && ' \r\n'.includes(text[cursor - 1] as string)) {
        text = text.slice(0, cursor - 1) + text.slice(cursor);
        cursor--;
      }
      return {
        id: snapshot.transactionId,
        answer: {
          action: 'replace',
          text,
          cursor,
          owner: 'claude',
          ruleId: 'reject',
          undo: {
            beforeText: owned.before.text,
            beforeCursor: owned.before.cursor,
            rejectSeparator: owned.before.rejectSeparator,
          },
        },
        result: { text, cursor },
        kind: 'reject',
        original: owned.original,
        rejectId: owned.transactionId,
      };
    }
    return { id: snapshot.transactionId, answer, kind: 'native' };
  }

  #snapshot(event: PromptEditInput, key: KeyId | null): InlineSnapshot {
    const keyed = isKeyedSingle(event, key) && isSingleCodePoint(event.inputText);
    const origin = keyed ? 'typed' : 'unknown';
    const id = String(++this.#inlineSeq);
    return {
      transactionId: id,
      version: this.#draft.version,
      text: event.text,
      cursor: event.cursor,
      typedSpans: copy(this.#draft.typedSpans),
      certainty: this.#draft.certainty,
      origin,
      deltas: [{ origin, from: event.start, to: event.end, insert: event.inputText }],
      key: { id: key ?? 'unknown', inputText: event.inputText, from: event.start, to: event.end },
      state: this.getState(),
    };
  }

  #evaluate(snapshot: InlineSnapshot): InlineAnswer {
    for (const evaluate of [...this.#inline]) {
      const answer = evaluate(snapshot);
      if (answer.action === 'replace') return answer;
    }
    return { action: 'native' };
  }

  #commitReplace(plan: Plan, result: PromptEditResult): void {
    const expected = plan.result;
    if (!expected) return;
    const origin: Origin = plan.kind === 'reject' ? 'undo' : 'plugin';
    const replay = plan.answer.action === 'replace' ? plan.answer.replay : undefined;
    this.#adopt(result, origin, replay?.typedSpans ?? this.#draft.typedSpans, replay);
    const match = result.text === expected.text && result.cursor === expected.cursor;
    this.#ack(plan.id, match ? 'applied' : 'fallback', result, this.#draft.version);
    if (plan.kind === 'reject') {
      const original = plan.original || /\S+$/.exec(result.text)?.[0] || '';
      if (original) {
        const rejection: InlineRejection = {
          transactionId: plan.rejectId ?? plan.id,
          original,
          text: result.text,
          cursor: result.cursor,
          version: this.#draft.version,
        };
        for (const callback of [...this.#inlineRejects]) callback(rejection);
      }
      this.#owned = null;
      return;
    }
    if (match && plan.answer.action === 'replace') {
      this.#owned = {
        transactionId: plan.id,
        original: originalOf(plan.answer),
        before: {
          text: plan.answer.undo.beforeText,
          cursor: plan.answer.undo.beforeCursor,
          rejectSeparator: plan.answer.undo.rejectSeparator,
        },
        after: { text: result.text, cursor: result.cursor },
        version: this.#draft.version,
      };
      this.#pending = { id: plan.id, expected, version: this.#draft.version };
    } else this.#owned = null;
  }

  #observedBefore(event: PromptEditInput): void {
    if (this.#draft.text !== event.text || this.#draft.cursor !== event.cursor) {
      this.#adopt(event, 'unknown', []);
    }
    this.#state = { ...this.#state, history: false };
    if (this.#opaque) this.#state = { ...this.#state, mode: 'unknown' };
    else {
      const command = event.text.trimStart().startsWith('/') || event.inputText === '/';
      this.#state = { ...this.#state, mode: command ? 'command' : 'prose' };
    }
    const prefix = event.text.slice(0, event.cursor).match(/\S*$/)?.[0] ?? '';
    const popup = /^[/@]/.test(prefix) || event.inputText === '/' || event.inputText === '@';
    this.#state = { ...this.#state, popup: popup ? { owner: 'host' } : null };
  }

  #observedEdit(event: PromptEditInput, result: PromptEditResult, key: KeyId | null): void {
    const expected = event.text.slice(0, event.start) + event.inputText + event.text.slice(event.end);
    const keyed = isKeyedSingle(event, key) && isSingleCodePoint(event.inputText);
    const origin: Origin = result.text !== expected ? 'unknown' : keyed ? 'typed' : 'unknown';
    const deltas: DraftDelta[] = [{ origin, from: event.start, to: event.end, insert: event.inputText }];
    const before = this.#draft;
    const next = applyChange(before, deltas, typing);
    this.#draft = { ...next, text: result.text, cursor: result.cursor, version: before.version + 1 };
    this.#emit(origin, before, deltas);
  }

  #adopt(
    box: { readonly text: string; readonly cursor: number },
    origin: Origin,
    typedSpans: readonly Range[],
    replay?: InlineReplay,
  ): void {
    const before = copy(this.#draft);
    if (before.text === box.text && before.cursor === box.cursor) {
      if (origin === 'history') {
        this.#draft = { ...this.#draft, version: this.#draft.version + 1, typedSpans: [] };
        this.#emit(origin, this.#draft, [{ origin, from: 0, to: before.text.length, insert: box.text }]);
      }
      return;
    }
    const deltas = replay?.deltas ?? [{ origin, from: 0, to: before.text.length, insert: box.text }];
    this.#draft = {
      text: box.text,
      cursor: box.cursor,
      version: this.#draft.version + 1,
      certainty: 'authoritative',
      typedSpans: typedSpans.length ? copy(typedSpans) : applyChange(before, deltas, typing).typedSpans,
    };
    this.#emit(origin, before, deltas);
  }

  #emit(origin: Origin, before: Draft, deltas: readonly DraftDelta[]): void {
    if (this.#probe) return;
    const change: Change = { draft: copy(this.#draft), origin, before: copy(before), deltas: copy(deltas) };
    for (const callback of [...this.#changes]) callback(change);
  }

  #ack(
    transactionId: string,
    status: InlineCommit['status'],
    box: { text: string; cursor: number },
    version: number,
  ): void {
    const commit: InlineCommit = { transactionId, status, text: box.text, cursor: box.cursor, version };
    for (const callback of [...this.#inlineCommits]) callback(commit);
  }

  async #runSubmit(
    text: string,
    position: 'managed' | 'final-boundary',
    gesture: SubmitGesture,
  ): Promise<SubmitOutcome> {
    if (this.#draft.text !== text)
      this.#adopt({ text, cursor: Math.min(this.#draft.cursor, text.length) }, 'unknown', []);
    const tx: SubmitTransaction = { draft: copy(this.#draft), gesture, position };
    let outcome: SubmitOutcome = { action: 'send', coverage: position };
    for (const callback of [...this.#submits]) {
      outcome = await callback(tx);
      if (outcome.action !== 'send') return outcome;
    }
    return outcome;
  }

  #noteClear(): void {
    this.#owned = null;
    this.#pending = null;
    this.#adopt({ text: '', cursor: 0 }, 'unknown', []);
    this.#state = { ...this.#state, history: false, mode: this.#opaque ? 'unknown' : 'prose', popup: null };
  }

  async #probeHost(rt: ClaudeRuntime): Promise<void> {
    const before = await rt.prompt.read();
    this.probes.base64Fs = typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 === 'function';
    if (before.text) {
      this.#draft = { ...emptyDraft(), text: before.text, cursor: before.cursor };
      return;
    }
    try {
      const filled = await rt.prompt.fill({ text: 'A🙂\nB' });
      const read = await rt.prompt.read();
      await rt.prompt.fill({ text: before.text });
      this.caps = {
        ...this.caps,
        readDraft: typeof read.text === 'string',
        edit: {
          ...this.caps.edit,
          end: filled.isFilled === true && read.text === 'A🙂\nB',
          multiline: read.text === 'A🙂\nB',
        },
      };
    } catch {
      this.probes.promptEdit = false;
    }
  }
}

interface PromptBoxLike {
  readonly text: string;
  readonly cursor: number;
}

interface Plan {
  readonly id: string;
  readonly answer: InlineAnswer;
  readonly result?: { readonly text: string; readonly cursor: number };
  readonly kind: 'inline' | 'reject' | 'native';
  readonly original?: string;
  readonly rejectId?: string;
}

function callUi(type: unknown, props: Record<string, unknown>): unknown {
  if (typeof type === 'function') return (type as (p: Record<string, unknown>) => unknown)(props);
  return { type, props };
}

function originalOf(answer: InlineAnswer): string {
  if (answer.action !== 'replace') return '';
  const fromReplay = answer.replay?.corrections.find((item) => item.kind !== 'undo')?.original;
  if (fromReplay) return fromReplay;
  const prefix = answer.undo.beforeText.slice(0, answer.undo.beforeCursor);
  return /\S+$/.exec(prefix)?.[0] ?? '';
}
