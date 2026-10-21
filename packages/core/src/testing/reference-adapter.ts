// The reference adapter: a fully capable host in memory, ported from
// experiments/platform/shared-v2/fake-adapter/fake-adapter.ts. Phases 05–10
// test against it before any real host exists. It overpromises on purpose
// (lesson 73): host limits come from profiles (phase 11) and real hosts (20).
//
// What it models:
// - an authoritative draft with host-labeled input: every delta carries the
//   origin of the input path that produced it, and typed spans follow the
//   shared rules in @murmo/provenance;
// - ordered deltas: one change per input, `before` plus every splice;
// - `applyEditIfVersion` comparing the version at the commit and returning the
//   committed snapshot, `applyAttributedEditIfVersion` with a host-owned
//   attribution log and a 20-per-second rate guard, an exact `restoreDraft`;
// - versioned presentation calls returning typed results;
// - a fake model transport that records what was sent;
// - fault injection: a fixed result for every commit or restore, commits held
//   until released, a hook after each commit, and the `inputOriginEvidence`
//   switch for the degraded mode the real hosts were in during round 14. The
//   switch changes only what the adapter advertises: it still labels input,
//   as the legacy adapters did, so the core's own stripping is what is tested.
//
// Inline transactions (`onInlineEdit`/`onInlineCommit`, phase 07) run inside
// the same native splice as the key. Host profiles are phase 11.

import {
  type ActionId,
  type ActionResult,
  type Cancellation,
  type Change,
  type Clock,
  type Draft,
  type DraftDelta,
  type Edit,
  type EditResult,
  type Gesture,
  type HostState,
  type InputOriginEvidence,
  isCanonicalKey,
  type KeyId,
  NAMED_KEYS,
  type Origin,
  type Range,
  type ResultCode,
  type SubmitGesture,
  type SubmitTransaction,
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
import { applyChange, moveCursor, restoreDraft as restoreSaved, type TypingRules } from '@murmo/provenance';
import { codePointBefore, isGraphemeBoundary, isSingleCodePoint } from '@murmo/text';

/** Every capability the 2.0-pre API names, at its most capable, except routes the adapter does not have. */
export function referenceCaps(): HostCapabilities {
  return {
    inputOriginEvidence: 'host-labeled',
    semanticMenuSelection: true,
    actions: ['murmo.undo', 'murmo.menu'],
    inlineRewrite: 'same-transaction',
    inline: {
      attributed: true,
      middle: true,
      multiline: true,
      observedKeys: [
        'space',
        'Backspace',
        'F6',
        'Undo',
        'Enter',
        ...Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter(isCanonicalKey),
      ],
      allKeysObserved: true,
      nativeCompletion: false,
      commitReceipt: 'native-commit',
      maxBytes: 16384,
    },
    readDraft: true,
    edit: {
      atomic: true,
      end: true,
      middle: true,
      multiline: true,
      selection: true,
      exactRestore: true,
      certainties: ['authoritative', 'tracked'],
      attributed: true,
    },
    ghost: 'any',
    menu: true,
    highlight: 'any',
    status: true,
    keys: [...NAMED_KEYS, ...Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).filter(isCanonicalKey)],
    undoKeys: ['F6'],
    keyPriority: 'before-peers',
    submit: {
      transform: true,
      block: true,
      gestures: ['send', 'queue', 'steer', 'newline'],
      guardPosition: 'final-boundary',
      committed: 'accepted-text',
    },
    ui: { dialogSafe: true, anchor: 'host-owned', statusMaxLength: 512, normalization: 'preserve', opaqueParts: false },
  };
}

/** Capability overrides: nested groups merge field by field. */
export type CapsPatch = {
  [K in keyof HostCapabilities]?: HostCapabilities[K] extends readonly unknown[]
    ? HostCapabilities[K]
    : HostCapabilities[K] extends object
      ? Partial<HostCapabilities[K]>
      : HostCapabilities[K];
};

export function patchCaps(base: HostCapabilities, patch: CapsPatch): HostCapabilities {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
        ? { ...current, ...value }
        : value;
  }
  return out as unknown as HostCapabilities;
}

export interface ReferenceAdapterOptions {
  readonly clock: Clock;
  readonly caps?: CapsPatch;
  /** The draft at start; text there has no typed coverage. */
  readonly draft?: { readonly text: string; readonly cursor?: number; readonly certainty?: Draft['certainty'] };
  /** Tab is the host's queue gesture (Codex). */
  readonly tabQueues?: boolean;
  /** A native peer's transform of the sent text, before (final boundary) or after (managed) Murmo's guards. */
  readonly nativePeer?: (text: string) => string;
}

export interface AuditEntry {
  readonly expected: number;
  readonly actual: number;
  readonly status: ResultCode;
}

/** A plugin edit the host committed. */
export interface CommittedEdit {
  readonly route: 'direct' | 'attributed';
  /** Host-owned attribution, for the attributed route. */
  readonly attribution?: EditAttribution;
  readonly edit: Edit;
  readonly before: Draft;
  readonly after: Draft;
  readonly at: number;
}

/** A restore the session asked for, and what the host answered. */
export interface RestoreEntry {
  readonly target: Draft;
  readonly expectedVersion: number;
  readonly status: ResultCode;
  /** The key the host delivered last before the restore (Backspace or an undo key). */
  readonly key: KeyId | null;
}

/**
 * When the host runs a commit, relative to its version check: `hold` waits
 * until released, so the next input lands first; `compete` changes the draft
 * just before the check (a competing version); `race` types `raceText` key by
 * key right after the commit applied, before its result returns.
 */
export type CommitTiming = 'immediate' | 'hold' | 'compete' | 'race';

export interface SentRequest {
  readonly text: string;
  readonly gesture: SubmitGesture;
}

export type CommitFault = Exclude<ResultCode, 'applied'>;

/** Attributed edits per plugin per rolling second the host accepts (`LIMITS.editsPerSecond`). */
const ATTRIBUTED_EDITS_PER_SECOND = 20;

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The adapter labels its own input exactly, and reports bursts of keys as one typed delta. */
const labeled: TypingRules = { evidence: 'host-labeled', keyBursts: true };

const hostUiKeys: ReadonlySet<KeyId> = new Set(['Tab', 'Enter', 'Up', 'Down', 'Escape']);

/** The next grapheme boundary before (-1) or after (1) `at`: Backspace and the arrows move by whole characters. */
function graphemeStep(text: string, at: number, direction: -1 | 1): number {
  let to = at;
  do {
    const point = direction < 0 ? codePointBefore(text, to) : text.codePointAt(to);
    if (point === undefined) return to;
    to += direction * (point > 0xffff ? 2 : 1);
  } while (to > 0 && to < text.length && !isGraphemeBoundary(text, to));
  return to;
}

export class ReferenceAdapter implements Adapter {
  readonly host = { name: 'fake', version: '2.0.0-pre.0' } as const;
  caps: HostCapabilities;
  readonly #clock: Clock;
  readonly #tabQueues: boolean;
  readonly #nativePeer: ((text: string) => string) | undefined;
  #value: Draft;
  #state: HostState = { mode: 'prose', popup: null, dialog: false, busy: false, editorMode: 'insert', history: false };
  #probing = false;
  #submissions = 0;

  readonly #changes = new Set<(change: Change) => void>();
  readonly #keys = new Set<(key: KeyId) => 'consume' | 'pass'>();
  readonly #submits = new Set<(tx: SubmitTransaction) => Promise<SubmitOutcome>>();
  readonly #committed = new Set<(event: HostSubmitAccepted) => void>();
  readonly #actions = new Set<(action: ActionId) => void>();
  readonly #menuSelects = new Set<(selection: MenuSelection) => void>();
  readonly #inline = new Set<(snapshot: InlineSnapshot) => InlineAnswer>();
  /** Draft before a native-completion Tab, restored by the next Backspace (Claude E5). */
  #completionRevert: Draft | null = null;
  readonly #inlineCommits = new Set<(commit: InlineCommit) => void>();
  readonly #inlineRejects = new Set<(rejection: InlineRejection) => void>();
  #inlineSeq = 0;

  /** Fault injection: every commit (or restore) returns this instead of committing. */
  commitFault: CommitFault | null = null;
  /** Inline acknowledgement status for the next native transaction (E21). */
  inlineCommitStatus: InlineCommit['status'] = 'applied';
  restoreFault: CommitFault | null = null;
  /** See `CommitTiming`; `hold` is set with `holdCommits`. */
  timing: Exclude<CommitTiming, 'hold'> = 'immediate';
  /** What a `race` types; `compete` inserts it as one unknown-origin change. */
  raceText = ' ';
  #holdCommits = false;
  #held: (() => void)[] = [];
  #holdSubmit = false;
  #heldSubmit: (() => void)[] = [];
  #lastKey: KeyId | null = null;
  /** The next non-newline submit records no request and emits no committed event. */
  transportFault = false;
  /**
   * The undo oracle: for each version a committed edit produced, the draft
   * before that edit, kept by the host itself. A restore is checked against it,
   * never against what the session asked for.
   */
  readonly #undoable = new Map<number, { before: Draft; rejectSeparator: boolean; prev: number | null }>();

  // What the host shows and did, for assertions.
  ghost: string | null = null;
  ghostOwner: string | null = null;
  menu: readonly PresentedMenuItem[] | null = null;
  menuSelected = 0;
  highlight: readonly Range[] | null = null;
  status: string | null = null;
  readonly audit: AuditEntry[] = [];
  readonly edits: CommittedEdit[] = [];
  readonly restores: RestoreEntry[] = [];
  /** Restores that did not put back exactly the draft before the undone edit. */
  readonly undoViolations: string[] = [];
  readonly requests: SentRequest[] = [];
  readonly nativeKeys: KeyId[] = [];

  constructor(options: ReferenceAdapterOptions) {
    this.#clock = options.clock;
    this.caps = patchCaps(referenceCaps(), options.caps ?? {});
    this.#tabQueues = options.tabQueues ?? false;
    this.#nativePeer = options.nativePeer;
    const text = options.draft?.text ?? '';
    this.#value = {
      text,
      cursor: options.draft?.cursor ?? text.length,
      version: 0,
      certainty: options.draft?.certainty ?? 'authoritative',
      typedSpans: [],
    };
  }

  /** Advertised input-origin evidence; see the file comment. */
  setEvidence(evidence: InputOriginEvidence): void {
    this.caps = { ...this.caps, inputOriginEvidence: evidence };
  }

  // -------------------------------------------------------------------------
  // Adapter contract

  async ready(): Promise<HostCapabilities> {
    // The edit probe runs with notifications suppressed and leaves the draft as it was.
    const saved = this.#value;
    this.#probing = true;
    try {
      this.#splice([{ origin: 'unknown', from: 0, to: saved.text.length, insert: 'a\nb' }]);
      if (this.#value.text !== 'a\nb') throw new Error('reference adapter: edit probe failed');
    } finally {
      this.#value = saved;
      this.#probing = false;
    }
    return copy(this.caps);
  }

  getDraft(): Draft {
    return copy(this.#value);
  }

  getState(): HostState {
    return copy(this.#state);
  }

  async applyEditIfVersion(edit: Edit, signal?: Cancellation): Promise<EditResult> {
    return this.#commit(edit, signal, 'direct');
  }

  async applyAttributedEditIfVersion(
    edit: Edit,
    attribution: EditAttribution,
    signal?: Cancellation,
  ): Promise<EditResult> {
    const now = this.#clock.now();
    const recent = this.edits.filter(
      (e) => e.attribution?.pluginId === attribution.pluginId && now - e.at < 1000,
    ).length;
    if (recent >= ATTRIBUTED_EDITS_PER_SECOND) return { status: 'denied', reason: 'edit rate limit' };
    return this.#commit(edit, signal, 'attributed', copy(attribution));
  }

  async restoreDraft(draft: Draft, expectedVersion: number, signal?: Cancellation): Promise<EditResult> {
    const answer = (status: ResultCode, reason?: string): EditResult => {
      this.restores.push({ target: copy(draft), expectedVersion, status, key: this.#lastKey });
      if (status === 'applied') return { status, draft: this.getDraft() };
      return reason === undefined ? { status } : { status, reason };
    };
    if (this.restoreFault) return answer(this.restoreFault, 'injected fault');
    if (signal?.cancelled) return answer('cancelled');
    if (this.#value.version !== expectedVersion) return answer('stale');
    if (!this.#editableHere()) return answer('denied', 'host state changed before restore');
    const before = this.#value;
    this.#value = restoreSaved(before, copy(draft));
    this.#checkRestore(expectedVersion);
    this.#notify('undo', before, [{ origin: 'undo', from: 0, to: before.text.length, insert: draft.text }]);
    return answer('applied');
  }

  showGhost(text: string | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.ghost !== 'none', () => {
      this.ghost = text;
      this.ghostOwner = null;
    });
  }

  showAttributedGhost(text: string | null, baseVersion: number, pluginId: string): ActionResult {
    return this.#present(baseVersion, this.caps.ghost !== 'none', () => {
      this.ghost = text;
      this.ghostOwner = text === null ? null : pluginId;
    });
  }

  showMenu(items: readonly PresentedMenuItem[] | null, selected: number, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.menu, () => {
      this.menu = items === null ? null : copy(items);
      this.menuSelected = selected;
    });
  }

  showHighlight(ranges: readonly Range[] | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.highlight !== 'none', () => {
      this.highlight = ranges === null ? null : copy(ranges);
    });
  }

  showStatus(text: string | null, baseVersion: number): ActionResult {
    return this.#present(baseVersion, this.caps.status, () => {
      this.status = text;
    });
  }

  onDraftChange(callback: (change: Change) => void): Unsubscribe {
    return this.#subscribe(this.#changes, callback);
  }

  onKey(callback: (key: KeyId) => 'consume' | 'pass'): Unsubscribe {
    return this.#subscribe(this.#keys, callback);
  }

  onBeforeSubmit(callback: (tx: SubmitTransaction) => Promise<SubmitOutcome>): Unsubscribe {
    return this.#subscribe(this.#submits, callback);
  }

  onSubmitCommitted(callback: (event: HostSubmitAccepted) => void): Unsubscribe {
    return this.#subscribe(this.#committed, callback);
  }

  onAction(callback: (action: ActionId) => void): Unsubscribe {
    return this.#subscribe(this.#actions, callback);
  }

  onMenuSelect(callback: (selection: MenuSelection) => void): Unsubscribe {
    return this.#subscribe(this.#menuSelects, callback);
  }

  onInlineEdit(evaluate: (snapshot: InlineSnapshot) => InlineAnswer): Unsubscribe {
    return this.#subscribe(this.#inline, evaluate);
  }

  onInlineCommit(callback: (commit: InlineCommit) => void): Unsubscribe {
    return this.#subscribe(this.#inlineCommits, callback);
  }

  onInlineReject(callback: (rejection: InlineRejection) => void): Unsubscribe {
    return this.#subscribe(this.#inlineRejects, callback);
  }

  /** Re-emit an acceptance, for duplicate-id tests. */
  emitCommitted(event: HostSubmitAccepted): void {
    for (const callback of [...this.#committed]) callback(event);
  }

  /** Subscribers still registered, so a test can see that dispose unsubscribed everything. */
  subscribers(): number {
    return (
      this.#changes.size +
      this.#keys.size +
      this.#submits.size +
      this.#committed.size +
      this.#actions.size +
      this.#menuSelects.size +
      this.#inline.size +
      this.#inlineCommits.size +
      this.#inlineRejects.size
    );
  }

  // -------------------------------------------------------------------------
  // Input, as the host's editor would deliver it

  /** A key: Murmo's key callbacks first, then the host's own handling if they pass. */
  async key(id: KeyId): Promise<'consume' | 'pass'> {
    if (this.deliverKey(id) === 'consume') return 'consume';
    await this.#native(id);
    return 'pass';
  }

  /** Only the key callbacks, as a timing sample measures them. */
  deliverKey(id: KeyId): 'consume' | 'pass' {
    this.#lastKey = id;
    for (const callback of [...this.#keys]) {
      if (callback(id) === 'consume') return 'consume';
    }
    return 'pass';
  }

  /** Typed key by key: one change per code point; a newline is the host's newline gesture. */
  async type(text: string): Promise<void> {
    for (const point of text) {
      if (point === '\n') await this.submit('newline');
      else await this.key(point === ' ' ? 'space' : point);
    }
  }

  /** One native transaction: the deltas in order, one change. A delta without a range inserts at the cursor. */
  burst(
    deltas: readonly { origin: Origin; text: string; from?: number; to?: number }[],
    key: KeyId = 'Text',
    deferred?: InlineSnapshot['deferred'],
  ): void {
    let cursor = this.#value.cursor;
    let length = this.#value.text.length;
    const splices: DraftDelta[] = deltas.map((d) => {
      const from = d.from ?? cursor;
      const to = d.to ?? d.from ?? cursor;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > length) {
        throw new RangeError(`burst delta [${from}, ${to}) is outside the draft`);
      }
      cursor = from + d.text.length;
      length += d.text.length - (to - from);
      return { origin: d.origin, from, to, insert: d.text };
    });
    const origin = splices[0]?.origin ?? 'unknown';
    this.#inlineTransaction(key, splices, origin === 'typed' || origin === 'paste' ? origin : 'unknown', deferred);
  }

  paste(text: string): void {
    const d = this.#value;
    const [from, to] = d.selection && d.selection[0] !== d.selection[1] ? d.selection : [d.cursor, d.cursor];
    this.#inlineTransaction('Text', [{ origin: 'paste', from, to, insert: text }], 'paste');
  }

  ime(text: string): void {
    const d = this.#value;
    const [from, to] = d.selection && d.selection[0] !== d.selection[1] ? d.selection : [d.cursor, d.cursor];
    this.#inlineTransaction('Text', [{ origin: 'ime', from, to, insert: text }], 'unknown');
  }

  /** The whole draft replaced programmatically. */
  fill(text: string, origin: Origin, cursor = text.length): void {
    const before = this.#value;
    const deltas: DraftDelta[] = [{ origin, from: 0, to: before.text.length, insert: text }];
    const applied = applyChange(before, deltas, labeled);
    this.#value = { ...moveCursor(applied, cursor), version: applied.version };
    this.#notify(origin, before, deltas);
  }

  history(text: string): void {
    this.fill(text, 'history');
  }

  move(offset: number): void {
    const before = this.#value;
    this.#value = moveCursor(before, offset);
    this.#notify('unknown', before, []);
  }

  select(range: Range): void {
    const before = this.#value;
    this.#value = moveCursor(before, range[1], range);
    this.#notify('unknown', before, []);
  }

  /** Host state changes are announced as a change with the same draft. */
  setState(state: Partial<HostState>): void {
    this.#state = { ...this.#state, ...copy(state) };
    this.#notify('unknown', this.#value, []);
  }

  /** Holds every commit until `releaseCommits`, so input can land while a commit is in flight. */
  holdCommits(hold: boolean): void {
    this.#holdCommits = hold;
    if (!hold) this.releaseCommits();
  }

  releaseCommits(): void {
    const held = this.#held;
    this.#held = [];
    for (const release of held) release();
  }

  /** A logical action the host routed (never a fake raw key). */
  action(id: ActionId): void {
    for (const callback of [...this.#actions]) callback(id);
  }

  /** Native semantic menu selection, as Claude/Pi autocomplete reports it. */
  selectMenu(pluginId: string, itemId: string): void {
    const selection: MenuSelection = { pluginId, itemId, baseVersion: this.#value.version };
    for (const callback of [...this.#menuSelects]) callback(selection);
  }

  /**
   * Holds the native forward until `releaseSubmit`, so a last-moment edit
   * or host-side change can land between the pipeline's answer and the send.
   */
  holdSubmit(hold: boolean): void {
    this.#holdSubmit = hold;
    if (!hold) this.releaseSubmit();
  }

  /** Forwards waiting on `holdSubmit`; tests spin on this before racing input. */
  get submitHeld(): number {
    return this.#heldSubmit.length;
  }

  releaseSubmit(): void {
    const held = this.#heldSubmit;
    this.#heldSubmit = [];
    for (const release of held) release();
  }

  /**
   * A submit gesture. `newline` inserts a typed newline. Otherwise Murmo's
   * submit callbacks decide, the host rechecks the version, the native peer
   * runs where the guard position puts it, and the fake model records the
   * request before the host clears the draft.
   */
  async submit(gesture: Gesture): Promise<SubmitOutcome> {
    if (gesture === 'newline') {
      this.#insert('\n', 'typed');
      return { action: 'send', coverage: this.caps.submit.guardPosition };
    }
    const initial = this.#value;
    const position = this.caps.submit.guardPosition;
    let text = initial.text;
    if (position === 'final-boundary' && this.#nativePeer) text = this.#nativePeer(text);
    let outcome: SubmitOutcome = { action: 'send', coverage: position };
    for (const callback of [...this.#submits]) {
      outcome = await callback({ draft: { ...copy(initial), text }, gesture, position });
      if (outcome.action === 'block') return outcome;
      if (outcome.action === 'replace') text = outcome.text;
    }
    if (this.#holdSubmit) await new Promise<void>((resolve) => this.#heldSubmit.push(resolve));
    if (this.#value.version !== initial.version) return { action: 'block', reason: 'draft changed during submit' };
    if (this.transportFault) {
      this.transportFault = false;
      return { action: 'block', reason: 'transport failure' };
    }
    if (position === 'managed' && this.#nativePeer) text = this.#nativePeer(text);
    this.requests.push({ text, gesture });
    const typedSpans = copy(initial.typedSpans);
    this.fill('', 'unknown');
    if (this.caps.submit.committed === 'accepted-text') {
      const event: HostSubmitAccepted = {
        text,
        gesture,
        submissionId: String(++this.#submissions),
        position,
        acceptedAtMs: this.#clock.wallTimeMs(),
        typedSpans,
      };
      for (const callback of [...this.#committed]) callback(event);
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Internals

  #subscribe<T>(set: Set<T>, callback: T): Unsubscribe {
    set.add(callback);
    return () => {
      set.delete(callback);
    };
  }

  #editableHere(): boolean {
    const s = this.#state;
    return (
      s.mode === 'prose' &&
      s.editorMode === 'insert' &&
      !s.busy &&
      !s.dialog &&
      s.popup === null &&
      !s.history &&
      this.#value.certainty !== 'unknown'
    );
  }

  async #commit(
    edit: Edit,
    signal: Cancellation | undefined,
    route: CommittedEdit['route'],
    attribution?: EditAttribution,
  ): Promise<EditResult> {
    if (this.#holdCommits) await new Promise<void>((resolve) => this.#held.push(resolve));
    if (this.timing === 'compete') this.burst([{ origin: 'unknown', text: this.raceText }]);
    const before = this.#value;
    const actual = this.#value.version;
    const answer = (status: Exclude<ResultCode, 'applied'>, reason?: string): EditResult => {
      this.audit.push({ expected: edit.baseVersion, actual, status });
      return reason === undefined ? { status } : { status, reason };
    };
    if (this.commitFault) return answer(this.commitFault, 'injected fault');
    if (signal?.cancelled) return answer('cancelled');
    if (edit.baseVersion !== actual) return answer('stale');
    if (!this.#editableHere()) return answer('denied', 'host state changed before commit');
    const { from, to, insert } = edit;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > this.#value.text.length) {
      return answer('invalid-range');
    }
    this.#splice([{ origin: 'plugin', from, to, insert }]);
    const committed = this.getDraft();
    this.audit.push({ expected: edit.baseVersion, actual, status: 'applied' });
    this.edits.push({
      route,
      ...(attribution ? { attribution } : {}),
      edit: copy(edit),
      before: copy(before),
      after: committed,
      at: this.#clock.now(),
    });
    this.#undoable.set(committed.version, {
      before: copy(before),
      rejectSeparator: edit.rejectSeparator === true,
      prev: this.#undoable.has(actual) ? actual : null,
    });
    if (this.timing === 'race') for (const point of this.raceText) await this.key(point === ' ' ? 'space' : point);
    return { status: 'applied', draft: committed };
  }

  /** The undo oracle (see `#undoable`): the restored draft must be the one before the undone edit. */
  #checkRestore(expectedVersion: number): void {
    const entry = this.#undoable.get(expectedVersion);
    const restored = this.#value;
    if (!entry) {
      this.undoViolations.push(`restore of version ${expectedVersion}, which no committed edit produced`);
      return;
    }
    let want = entry.before;
    const at = want.cursor;
    if (this.#lastKey === 'Backspace' && entry.rejectSeparator && at > 0 && want.text[at - 1] === ' ') {
      const { selection: _dropped, ...rest } = want;
      want = applyChange(
        { ...rest, version: want.version },
        [{ origin: 'unknown', from: at - 1, to: at, insert: '' }],
        labeled,
      );
    }
    const shape = (d: Draft) => ({
      text: d.text,
      cursor: d.cursor,
      selection: d.selection && d.selection[0] !== d.selection[1] ? d.selection : null,
      ...(this.caps.inputOriginEvidence === 'host-labeled' ? { typedSpans: d.typedSpans } : {}),
    });
    const expected = JSON.stringify(shape(want));
    const actual = JSON.stringify(shape(restored));
    if (expected !== actual)
      this.undoViolations.push(`restore gave ${actual}, the draft before the edit was ${expected}`);
    // Undoing the newest of several edits brings back the previous edit's result, which is undoable in turn.
    const prev = entry.prev === null ? undefined : this.#undoable.get(entry.prev);
    if (prev && entry.prev !== null && want === entry.before) this.#undoable.set(restored.version, prev);
  }

  #insert(text: string, origin: Origin): void {
    const d = this.#value;
    const [from, to] = d.selection && d.selection[0] !== d.selection[1] ? d.selection : [d.cursor, d.cursor];
    this.#splice([{ origin, from, to, insert: text }]);
  }

  async #native(id: KeyId): Promise<void> {
    this.nativeKeys.push(id);
    const state = this.#state;
    if ((state.popup !== null || state.dialog) && hostUiKeys.has(id)) return;
    const d = this.#value;
    if (id === 'Tab' && this.caps.inline.nativeCompletion) {
      const row = this.menu?.[this.menuSelected];
      const edit = row?.inlineEdit;
      if (edit && edit.baseVersion === d.version) {
        this.#completionRevert = copy(d);
        this.#splice([{ origin: 'native-menu', from: edit.from, to: edit.to, insert: edit.insert }]);
        return;
      }
    }
    if (id === 'Backspace' && this.#completionRevert) {
      const saved = this.#completionRevert;
      this.#completionRevert = null;
      const before = this.#value;
      this.#value = {
        text: saved.text,
        cursor: saved.cursor,
        version: before.version + 1,
        certainty: saved.certainty,
        typedSpans: copy(saved.typedSpans),
        ...(saved.selection ? { selection: copy(saved.selection) } : {}),
      };
      this.#notify('undo', before, [{ origin: 'undo', from: 0, to: before.text.length, insert: saved.text }]);
      return;
    }
    this.#completionRevert = null;
    if (id === 'Enter') await this.submit('send');
    else if (id === 'Tab' && this.#tabQueues) await this.submit('queue');
    else if (id === 'Left' && d.cursor > 0) this.move(graphemeStep(d.text, d.cursor, -1));
    else if (id === 'Right' && d.cursor < d.text.length) this.move(graphemeStep(d.text, d.cursor, 1));
    else {
      const deltas = this.#keyDeltas(id);
      if (deltas) this.#inlineTransaction(id, deltas, 'typed');
    }
  }

  #keyDeltas(id: KeyId): DraftDelta[] | null {
    const d = this.#value;
    const [selFrom, selTo] = d.selection && d.selection[0] !== d.selection[1] ? d.selection : [d.cursor, d.cursor];
    if (id === 'Backspace') {
      if (selFrom !== selTo) return [{ origin: 'typed', from: selFrom, to: selTo, insert: '' }];
      if (d.cursor > 0)
        return [{ origin: 'typed', from: graphemeStep(d.text, d.cursor, -1), to: d.cursor, insert: '' }];
      return [{ origin: 'typed', from: d.cursor, to: d.cursor, insert: '' }];
    }
    if (id === 'F6' || id === 'Undo') return [{ origin: 'typed', from: d.cursor, to: d.cursor, insert: '' }];
    if (id === 'space') return [{ origin: 'typed', from: selFrom, to: selTo, insert: ' ' }];
    if (isSingleCodePoint(id)) return [{ origin: 'typed', from: selFrom, to: selTo, insert: id }];
    return null;
  }

  #inlineTransaction(
    key: KeyId,
    deltas: readonly DraftDelta[],
    origin: InlineSnapshot['origin'],
    deferred?: InlineSnapshot['deferred'],
  ): void {
    const before = this.#value;
    const first = deltas[0] ?? { origin: 'unknown' as const, from: before.cursor, to: before.cursor, insert: '' };
    const transactionId = String(++this.#inlineSeq);
    const snapshot: InlineSnapshot = {
      transactionId,
      version: before.version,
      text: before.text,
      cursor: before.cursor,
      typedSpans: copy(before.typedSpans),
      certainty: before.certainty,
      ...(before.selection ? { selection: copy(before.selection) } : {}),
      origin,
      deltas: copy(deltas),
      key: { id: key, inputText: first.insert, from: first.from, to: first.to },
      state: this.getState(),
      ...(deferred ? { deferred } : {}),
    };
    const answer = this.#evaluate(snapshot);
    if (this.#value.version !== before.version) {
      this.#ack(transactionId, 'stale');
      return;
    }
    if (answer.action === 'replace' && this.inlineCommitStatus === 'applied') {
      const undo = answer.replay?.corrections.length
        ? answer.replay.corrections.every((e) => e.kind === 'undo')
        : false;
      const start = answer.replay?.before ?? before;
      const replayDeltas = answer.replay?.deltas ?? copy(deltas);
      const applied = applyChange(copy(start), replayDeltas, labeled);
      this.#value = { ...applied, cursor: answer.cursor, version: before.version + 1 };
      this.#ack(transactionId, 'applied');
      this.#notify(undo ? 'undo' : 'plugin', start, replayDeltas);
      return;
    }
    const noop = deltas.length === 0 || deltas.every((d) => d.from === d.to && d.insert === '');
    if (!noop) this.#splice(deltas);
    this.#ack(transactionId, this.inlineCommitStatus);
  }

  #evaluate(snapshot: InlineSnapshot): InlineAnswer {
    let answer: InlineAnswer = { action: 'native' };
    for (const evaluate of [...this.#inline]) {
      const candidate = evaluate(snapshot);
      if (candidate.replay) answer = candidate;
      if (candidate.action === 'replace') return candidate;
    }
    return answer;
  }

  #ack(transactionId: string, status: InlineCommit['status']): void {
    const d = this.getDraft();
    const commit: InlineCommit = { transactionId, status, text: d.text, cursor: d.cursor, version: d.version };
    for (const callback of [...this.#inlineCommits]) callback(commit);
  }

  /** Applies splices as one change, with typed spans by the shared rules. */
  #splice(deltas: readonly DraftDelta[]): void {
    const before = this.#value;
    this.#value = applyChange(before, deltas, labeled);
    this.#notify(deltas[0]?.origin ?? 'unknown', before, deltas);
  }

  #notify(origin: Origin, before: Draft, deltas: readonly DraftDelta[]): void {
    if (this.#probing) return;
    const change: Change = { draft: this.getDraft(), origin, before: copy(before), deltas: copy(deltas) };
    for (const callback of [...this.#changes]) {
      try {
        callback(copy(change));
      } catch {
        // A subscriber's bug must not break the host's editor.
      }
    }
  }

  #present(baseVersion: number, supported: boolean, set: () => void): ActionResult {
    if (baseVersion !== this.#value.version) return { status: 'stale' };
    if (!supported) return { status: 'unsupported' };
    set();
    return { status: 'applied' };
  }
}
