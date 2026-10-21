// Editor factory chaining, public-contract wrap, data-property callbacks,
// provider-transaction CAS, and the render override. No private Pi fields.

import type { Range } from '@murmo/api';
import { wrapDataProperty } from './callbacks.ts';
import { detectCursorFormat } from './cursor.ts';
import { cursorOffset, offsetToPosition } from './keys.ts';
import { decorateRows, type MenuPaint, type RenderPaint } from './render.ts';
import {
  EDIT_TIMEOUT_MS,
  type EditorBase,
  HIGHLIGHT_MS,
  hasEditorContract,
  type PiAutocompleteItem,
  type PiAutocompleteProvider,
  type PiEditor,
  type PiEditorFactory,
  type PiKeybindings,
  type PiSessionContext,
  type PiTui,
  type TuiApi,
} from './types.ts';

export interface PaintState {
  ghost: string | null;
  ghostOwner: string | null;
  menu: MenuPaint | null;
  highlight: readonly Range[] | null;
  highlightText: string | null;
  status: string | null;
  hideGhost: boolean;
}

export interface TransactionOp {
  readonly before: { text: string; cursor: number; version: number };
  readonly text: string;
  readonly cursor: number;
  readonly generation: number;
  committing: boolean;
  resolve: (ok: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface EditorHooks {
  onInput(data: string, editor: PiEditor): void;
  onNativeChange(text: string, notification: boolean): void;
  onNativeSubmit(text: string): void;
  onNativeCompletion(): void;
  canCommit(): boolean;
}

export interface EditorHostOptions {
  readonly Base: EditorBase;
  readonly tuiApi: TuiApi;
  readonly ctx: PiSessionContext;
  readonly hooks: EditorHooks;
  readonly log?: (event: Record<string, unknown>) => void;
}

const nativeOf = new WeakMap<PiEditor, { input: (data: string) => void; render: (width: number) => string[] }>();
const owned = new WeakSet<PiEditor>();

function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  const handle = timer as ReturnType<typeof setTimeout> & { unref?: () => void };
  handle.unref?.();
  return timer;
}

export class EditorHost {
  readonly tuiApi: TuiApi;
  readonly ctx: PiSessionContext;
  readonly paint: PaintState = {
    ghost: null,
    ghostOwner: null,
    menu: null,
    highlight: null,
    highlightText: null,
    status: null,
    hideGhost: false,
  };
  editor: PiEditor | undefined;
  tui: PiTui | undefined;
  bindings: PiKeybindings | undefined;
  factory: PiEditorFactory | undefined;
  ownsEditor = false;
  lastWidth = 120;
  suppress = 0;
  inputDepth = 0;
  operation: TransactionOp | null = null;
  aborted: TransactionOp | null = null;
  generation = 0;
  readonly queue: string[] = [];
  renderScheduled = false;
  highlightTimer: ReturnType<typeof setTimeout> | undefined;
  disposed = false;
  overlay = false;
  readonly #hooks: EditorHooks;
  readonly #Base: EditorBase;
  readonly #log: (event: Record<string, unknown>) => void;
  readonly #unsub: (() => void)[] = [];

  constructor(options: EditorHostOptions) {
    this.#Base = options.Base;
    this.tuiApi = options.tuiApi;
    this.ctx = options.ctx;
    this.#hooks = options.hooks;
    this.#log = options.log ?? (() => {});
    this.mount(this.ctx.ui.getEditorComponent());
    this.#stackProvider();
  }

  getEditor(): PiEditor {
    if (!this.editor) throw new Error('Pi editor is not mounted');
    return this.editor;
  }

  nativeKey(data: string): void {
    const editor = this.getEditor();
    const native = nativeOf.get(editor);
    if (native) native.input(data);
    else if (typeof editor.nativeKey === 'function') editor.nativeKey(data);
    else editor.handleInput(data);
  }

  cursor(): number {
    return cursorOffset(this.getEditor());
  }

  placeCursor(offset: number): void {
    this.getEditor();
    for (let n = 0; this.cursor() !== offset && n < 20_000; n++) {
      const before = this.cursor();
      this.nativeKey(before > offset ? '\x1b[D' : '\x1b[C');
      if (this.cursor() === before) throw new Error('Public cursor movement stalled');
    }
  }

  syncChange(fn: () => void): void {
    this.suppress++;
    try {
      fn();
    } finally {
      this.suppress--;
    }
  }

  transaction(
    before: { text: string; cursor: number; version: number },
    text: string,
    cursor: number,
  ): Promise<boolean> {
    if (this.operation || this.disposed) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.aborted = null;
      const op: TransactionOp = {
        before,
        text,
        cursor,
        generation: ++this.generation,
        committing: false,
        resolve,
        timer: unrefTimer(
          setTimeout(() => {
            this.#log({ event: 'edit-timeout' });
            this.aborted = op;
            this.finish(false);
          }, EDIT_TIMEOUT_MS),
        ),
      };
      this.operation = op;
      const editor = this.getEditor();
      if (editor.isShowingAutocomplete()) this.nativeKey('\x1b');
      this.nativeKey('\t');
    });
  }

  finish(ok: boolean): void {
    const op = this.operation;
    if (!op) return;
    this.operation = null;
    clearTimeout(op.timer);
    op.resolve(ok);
    queueMicrotask(() => {
      const keys = this.queue.splice(0);
      for (const key of keys) this.getEditor().handleInput(key);
      this.renderNow();
    });
  }

  showGhost(text: string | null): void {
    this.paint.ghost = text;
    if (text === null) this.paint.ghostOwner = null;
    this.renderNow();
  }

  showMenu(items: MenuPaint['items'] | null, selected: number): void {
    this.paint.menu = items?.length ? { items, selected } : null;
    this.renderNow();
  }

  showHighlight(ranges: readonly Range[] | null, text: string | null): void {
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.paint.highlight = ranges;
    this.paint.highlightText = text;
    this.renderNow();
    if (ranges?.length) {
      this.highlightTimer = unrefTimer(
        setTimeout(() => {
          this.paint.highlight = null;
          this.paint.highlightText = null;
          this.renderNow();
        }, HIGHLIGHT_MS),
      );
    }
  }

  showStatus(text: string | null): void {
    this.paint.status = text;
    this.renderNow();
  }

  renderNow(): void {
    if (this.disposed || this.renderScheduled) return;
    if (this.inputDepth > 0) return;
    this.renderScheduled = true;
    queueMicrotask(() => {
      this.renderScheduled = false;
      if (this.disposed) return;
      try {
        this.tui?.renderNow();
      } catch (error) {
        this.#log({ event: 'render-error', message: String(error) });
      }
    });
  }

  setOverlay(value: boolean): void {
    this.overlay = value;
  }

  hasOverlay(): boolean {
    return this.overlay || this.tui?.hasOverlay?.() === true;
  }

  ensureEditor(): boolean {
    if (this.disposed || this.hasOverlay() || this.ctx.ui.getEditorComponent() === this.factory) return false;
    if (this.operation) {
      this.aborted = this.operation;
      this.finish(false);
    }
    this.mount(this.ctx.ui.getEditorComponent());
    this.paint.ghost = null;
    this.paint.menu = null;
    this.paint.highlight = null;
    this.#log({ event: 'editor-rewrapped' });
    return true;
  }

  dispose(): void {
    this.disposed = true;
    if (this.operation) this.finish(false);
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    for (const off of this.#unsub) off();
    this.#unsub.length = 0;
    this.paint.ghost = null;
    this.paint.menu = null;
    this.paint.highlight = null;
    this.paint.status = null;
  }

  mount(previous: PiEditorFactory | undefined): void {
    const next: PiEditorFactory = (...args: unknown[]) => {
      this.tui = args[0] as PiTui;
      this.bindings = args[2] as PiKeybindings;
      const candidate = previous ? previous(...args) : new this.#Base(this.tui, args[1], this.bindings);
      if (!hasEditorContract(candidate)) throw new Error('Public peer editor contract unsupported');
      this.#wrap(candidate);
      this.editor = candidate;
      return candidate;
    };
    (next as PiEditorFactory & { murmoOwned: boolean }).murmoOwned = true;
    this.factory = next;
    this.ctx.ui.setEditorComponent(next);
    this.ownsEditor = this.ctx.ui.getEditorComponent() === next;
    if (!this.editor) {
      const tui = this.ctx.ui.tui ?? { renderNow() {} };
      this.tui = tui;
      this.bindings = { matches: () => false };
      const candidate = new this.#Base(tui, {}, this.bindings);
      this.#wrap(candidate);
      this.editor = candidate;
    }
    this.#attachCallbacks();
  }

  #wrap(editor: PiEditor): void {
    if (owned.has(editor)) return;
    const input = editor.handleInput.bind(editor);
    const render = editor.render.bind(editor);
    nativeOf.set(editor, { input, render });
    editor.handleInput = (data: string) => this.#handleInput(editor, data);
    editor.render = (width: number) => this.#render(editor, width);
    editor.nativeKey = (data: string) => input(data);
    owned.add(editor);
  }

  #handleInput(editor: PiEditor, data: string): void {
    if (this.disposed) return;
    this.inputDepth++;
    try {
      this.#hooks.onInput(data, editor);
    } catch (error) {
      this.#log({ event: 'input-error', message: String(error) });
      try {
        nativeOf.get(editor)?.input(data);
      } catch {
        // The key must land even if native handling also throws.
      }
    } finally {
      this.inputDepth--;
      this.renderNow();
    }
  }

  #render(editor: PiEditor, width: number): string[] {
    this.lastWidth = width;
    const native = nativeOf.get(editor);
    const rows = native ? native.render(width) : [];
    try {
      this.paint.hideGhost = editor.isShowingAutocomplete() || this.hasOverlay();
      const paint: RenderPaint = {
        ghost: this.paint.ghost
          ? { text: this.paint.ghost, ...(this.paint.ghostOwner ? { owner: this.paint.ghostOwner } : {}) }
          : null,
        menu: this.paint.menu,
        highlight: this.paint.highlight,
        status: this.hasOverlay() ? null : this.paint.status,
        ...(this.paint.highlightText ? { draftText: this.paint.highlightText } : {}),
        hideGhost: this.paint.hideGhost,
      };
      return decorateRows(rows, width, paint, this.tuiApi);
    } catch (error) {
      this.#log({ event: 'decorate-error', message: String(error) });
      return rows;
    }
  }

  #attachCallbacks(): void {
    const editor = this.editor;
    if (!editor) return;
    this.#unsub.push(
      wrapDataProperty(editor, 'onChange', (original) => (text: string) => {
        if (editor !== this.editor) {
          (original as ((t: string) => void) | undefined)?.(text);
          return;
        }
        if (!this.suppress) this.#hooks.onNativeChange(text, true);
        (original as ((t: string) => void) | undefined)?.(text);
        const op = this.operation;
        if (op?.committing && text === op.text) this.finish(true);
      }),
      wrapDataProperty(editor, 'onSubmit', (original) => (text: string) => {
        if (editor !== this.editor) {
          (original as ((t: string) => void) | undefined)?.(text);
          return;
        }
        this.#hooks.onNativeSubmit(text);
        (original as ((t: string) => void) | undefined)?.(text);
      }),
    );
  }

  #stackProvider(): void {
    const self = this;
    this.ctx.ui.addAutocompleteProvider((current) => ({
      ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
      shouldTriggerFileCompletion: (...args) =>
        !!self.operation || current.shouldTriggerFileCompletion?.(...args) !== false,
      async getSuggestions(lines, line, col, opts) {
        if (self.aborted && opts.force) {
          self.aborted = null;
          return null;
        }
        const op = self.operation;
        if (op && lines.join('\n') === op.before.text) {
          return { prefix: 'murmo-atomic', items: [{ value: `murmo:${op.generation}`, label: 'Murmo edit' }] };
        }
        return current.getSuggestions(lines, line, col, opts);
      },
      applyCompletion(lines, line, col, item: PiAutocompleteItem, prefix) {
        if (!item.value.startsWith('murmo:')) {
          self.#hooks.onNativeCompletion();
          return current.applyCompletion(lines, line, col, item, prefix);
        }
        const op = self.operation;
        if (!op || item.value !== `murmo:${op.generation}` || !self.#hooks.canCommit()) {
          if (op) queueMicrotask(() => self.finish(false));
          return { lines: [...lines], cursorLine: line, cursorCol: col };
        }
        const cursor = offsetToPosition(op.text, op.cursor);
        op.committing = true;
        return { lines: op.text.split('\n'), cursorLine: cursor.line, cursorCol: cursor.col };
      },
    }));
  }

  cursorFormatDetected(rows: readonly string[]): boolean {
    return detectCursorFormat(rows, this.tuiApi) !== undefined;
  }
}

export type { PiAutocompleteProvider };
