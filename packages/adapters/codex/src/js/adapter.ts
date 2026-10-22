// Adapter the core session talks to. Transport is the Rust wrapper.

import type { ActionResult, Change, Draft, Edit, HostState, KeyId, Range } from '@murmo/api';
import type {
  Adapter,
  EditResult,
  HostCapabilities,
  InlineAnswer,
  InlineCommit,
  InlineSnapshot,
  ReviewPanel,
  SubmitOutcome,
  Unsubscribe,
} from '@murmo/api/adapter';
import { BoundaryBook } from '@murmo/core';
import { codexCaps } from './caps.ts';
import type { HostBridge } from './host.ts';

export interface Snap {
  draft: { text: string; cursor: number; version: number };
  state: string;
  known: boolean;
  title: string;
  probed: boolean;
  multiplexer: 'tmux' | 'zellij' | 'screen' | null;
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if ((s.charCodeAt(i) ?? 0) > 127) return false;
  }
  return true;
}

export function asSnap(value: unknown): Snap {
  const v = (value ?? {}) as Record<string, unknown>;
  const d = (v.draft ?? {}) as Record<string, unknown>;
  return {
    draft: {
      text: String(d.text ?? ''),
      cursor: Number(d.cursor ?? 0),
      version: Number(d.version ?? 0),
    },
    state: String(v.state ?? 'unknown'),
    known: v.known === true,
    title: String(v.title ?? ''),
    probed: v.probed === true,
    multiplexer:
      v.multiplexer === 'tmux' || v.multiplexer === 'zellij' || v.multiplexer === 'screen' ? v.multiplexer : null,
  };
}

export function hostState(snap: Snap): HostState {
  const s = snap.state;
  const text = snap.draft.text;
  return {
    mode: s === 'idle' ? 'prose' : text.startsWith('!') ? 'shell' : text.startsWith('/') ? 'command' : 'unknown',
    popup: s === 'popup' ? { owner: 'host' } : null,
    dialog: s === 'dialog',
    busy: s === 'busy' || /^(Working|Thinking|Waiting|Starting)$/.test(snap.title),
    editorMode: s === 'vim-replace' ? 'replace' : s === 'vim-normal' ? 'normal' : s === 'idle' ? 'insert' : 'unknown',
    history: s === 'history',
  };
}

export interface PendingEdit {
  resolve: (r: EditResult) => void;
  edit: Edit;
}

export interface CodexAdapter extends Adapter {
  snap: Snap;
  spans: Range[];
  notices: string[];
  boundaries: BoundaryBook;
  pendingEdits: Map<number, PendingEdit>;
  lastPlan: InlineAnswer | null;
  applyNative(next: Snap): void;
  draft(): Draft;
  render(kind: 'ghost' | 'menu' | 'status', value: unknown, version: number): ActionResult;
  key(id: KeyId): 'consume' | 'pass';
  evaluateInline(snapshot: InlineSnapshot): InlineAnswer;
  ackInline(commit: InlineCommit): void;
  startSubmit(gesture: 'send' | 'queue'): void;
  publish(change: Change): void;
  noteWitnessMiss(key: KeyId): void;
}

export function createAdapter(
  host: HostBridge,
  options: { readonly menu?: boolean; readonly ghost?: boolean; readonly version?: string } = {},
): CodexAdapter {
  const caps: HostCapabilities = codexCaps({
    ...(options.menu === true ? { menu: true } : {}),
    ...(options.ghost === true ? { ghost: true } : {}),
  });
  let change: (c: Change) => void = () => {};
  let onKey: (id: KeyId) => 'consume' | 'pass' = () => 'pass';
  let submit: (tx: { draft: Draft; gesture: 'send' | 'queue'; position: 'managed' }) => Promise<SubmitOutcome> =
    async () => ({ action: 'send', coverage: 'managed' });
  let inlineEval: (s: InlineSnapshot) => InlineAnswer = () => ({ action: 'native' });
  let inlineReceipt: (c: InlineCommit) => void = () => {};
  const ui: Record<string, unknown> = {};

  const self: CodexAdapter = {
    host: { name: 'codex', version: options.version ?? 'unknown' },
    caps,
    snap: asSnap(host('snapshot').snapshot),
    spans: [],
    notices: [],
    boundaries: new BoundaryBook(),
    pendingEdits: new Map(),
    lastPlan: null,
    draft() {
      return {
        text: self.snap.draft.text,
        cursor: self.snap.draft.cursor,
        version: self.snap.draft.version,
        certainty: self.snap.known ? 'tracked' : 'unknown',
        typedSpans: self.spans.map((r) => [r[0], r[1]] as Range),
      };
    },
    applyNative(next) {
      self.snap = next;
      if (!self.snap.known) self.spans = [];
    },
    render(kind, value, version) {
      if (version !== self.snap.draft.version) return { status: 'stale' };
      if (kind === 'ghost' && !options.ghost) return { status: 'unsupported' };
      if (kind === 'menu' && !options.menu) return { status: 'unsupported' };
      if (
        kind === 'ghost' &&
        value &&
        (self.snap.draft.cursor !== self.snap.draft.text.length || !isAscii(self.snap.draft.text))
      ) {
        return { status: 'unsupported' };
      }
      ui[kind] = kind === 'status' ? [...self.notices, value].filter(Boolean).join(' | ') : value;
      host('ui', { ui });
      return { status: 'applied' };
    },
    key(id) {
      return onKey(id === ' ' ? 'space' : id);
    },
    evaluateInline(snapshot) {
      self.lastPlan = inlineEval(snapshot);
      return self.lastPlan;
    },
    ackInline(commit) {
      inlineReceipt(commit);
    },
    startSubmit(gesture) {
      (globalThis as { __decision?: string | null }).__decision = null;
      void submit({ draft: self.draft(), gesture, position: 'managed' }).then(
        (d) => {
          (globalThis as { __decision?: string | null }).__decision = JSON.stringify(d);
        },
        (err) => {
          (globalThis as { __decision?: string | null }).__decision = JSON.stringify({
            action: 'block',
            reason: String(err),
          });
        },
      );
    },
    publish(c) {
      change(c);
    },
    noteWitnessMiss(key) {
      const mux = self.snap.multiplexer;
      if (!mux) return;
      const text = self.boundaries.record({
        boundary: 'outer-binding',
        evidence: { kind: 'witness-key', multiplexer: mux, key },
        action: 'compose',
      });
      if (text) self.notices.push(text);
    },
    async ready() {
      self.snap = asSnap(host('snapshot').snapshot);
      if (!self.snap.probed) {
        self.notices.push('Murmo: native edit probe failed; edits/undo disabled');
        host('trace', { data: { event: 'capability-notice', text: self.notices.at(-1) } });
      }
      const mux = self.snap.multiplexer;
      if (mux) {
        const text = self.boundaries.record({
          boundary: 'outer-binding',
          evidence: { kind: 'environment', multiplexer: mux },
          action: 'compose',
        });
        if (text) self.notices.push(text);
      }
      const raw = self.boundaries.record({
        boundary: 'raw-injection',
        evidence: { kind: 'undetectable', detail: 'raw send-keys looks typed' },
        action: 'compose',
      });
      if (raw) self.notices.push(raw);
      return caps;
    },
    getDraft: () => self.draft(),
    getState: () => hostState(self.snap),
    async applyEditIfVersion(edit, signal) {
      if (signal?.cancelled) return { status: 'cancelled' };
      if (edit.baseVersion !== self.snap.draft.version) return { status: 'stale' };
      const r = host('edit', { from: edit.from, to: edit.to, insert: edit.insert, version: edit.baseVersion });
      const id = Number(r.pending);
      return await new Promise((resolve) => {
        self.pendingEdits.set(id, { resolve, edit });
      });
    },
    async applyAttributedEditIfVersion() {
      return { status: 'unsupported' };
    },
    async restoreDraft(d, version, signal) {
      const r = await self.applyEditIfVersion(
        { from: 0, to: self.snap.draft.text.length, insert: d.text, baseVersion: version },
        signal,
      );
      if (r.status === 'applied') {
        self.spans = d.typedSpans.map((row) => [row[0], row[1]] as Range);
        if (self.snap.draft.cursor !== d.cursor) {
          self.snap = asSnap(host('cursor', { cursor: d.cursor }).snapshot);
        }
        return { status: 'applied', draft: self.draft() };
      }
      return r;
    },
    showGhost: (text, version) => self.render('ghost', text, version),
    showAttributedGhost: () => ({ status: 'unsupported' }),
    showMenu: (items, selected, version) => {
      if (!options.menu) return { status: 'unsupported' };
      ui.selected = selected;
      return self.render('menu', items, version);
    },
    showHighlight: () => ({ status: 'unsupported' }),
    showStatus: (text, version) => self.render('status', text, version),
    showReview: (panel: ReviewPanel | null, version) => {
      if (!panel) return self.render('status', null, version);
      const body = panel.edits.map((e) => `[plugin ${e.pluginId}] ${e.after}`).join(' | ');
      return self.render('status', `Review: ${body}`, version);
    },
    onDraftChange: (cb) => {
      change = cb;
      return () => {
        change = () => {};
      };
    },
    onKey: (cb) => {
      onKey = cb;
      return () => {
        onKey = () => 'pass';
      };
    },
    onBeforeSubmit: (cb) => {
      submit = cb as typeof submit;
      return () => {
        submit = async () => ({ action: 'send', coverage: 'managed' });
      };
    },
    onInlineEdit: (evaluate) => {
      inlineEval = evaluate;
      return () => {
        inlineEval = () => ({ action: 'native' });
      };
    },
    onInlineCommit: (cb) => {
      inlineReceipt = cb;
      return () => {
        inlineReceipt = () => {};
      };
    },
    onSubmitCommitted: (): Unsubscribe => () => {},
  };
  return self;
}

export function completeEdit(adapter: CodexAdapter, line: string): string {
  const e = JSON.parse(line) as { id: number; result: Record<string, unknown> };
  const p = adapter.pendingEdits.get(e.id);
  if (e.result.snapshot) adapter.applyNative(asSnap(e.result.snapshot));
  const r: EditResult =
    e.result.ok === true
      ? { status: 'applied', draft: adapter.draft() }
      : { status: e.result.why === 'stale' ? 'stale' : e.result.why === 'offset' ? 'invalid-range' : 'denied' };
  if (e.result.ok === true) adapter.publish({ draft: adapter.draft(), origin: 'plugin' });
  p?.resolve(r);
  adapter.pendingEdits.delete(e.id);
  return 'ok';
}
