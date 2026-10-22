// In-memory OpenCode / OpenTUI: enough of the public renderer, keymap and
// textarea to run adapter probes and key-path tests offline (phase 20 harness
// still owns real-host bursts).

import type {
  EditBuffer,
  Extmark,
  Highlight,
  KeypressHandler,
  OpenCodeApi,
  OpenTuiCore,
  OverlayOptions,
  ParsedKey,
  PasteEvent,
  PasteHandler,
  Selection,
  SyntaxStyle,
  TextareaEditor,
  TextareaOptions,
  TextOverlay,
} from '../src/types.ts';
import { FOCUSED_EDITOR } from '../src/types.ts';

const wide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd);

const zero = (ch: string): boolean => /^(?:\p{M}|\u200d|\ufe0e|\ufe0f)$/u.test(ch);

/** Stock OpenCode wcwidth: family emoji is 8 cells (r10 O3). */
export function wcwidth(text: string): number {
  return Array.from(text).reduce(
    (n, ch) => n + (ch === '\n' ? 1 : zero(ch) ? 0 : wide(ch.codePointAt(0) as number) ? 2 : 1),
    0,
  );
}

interface Snapshot {
  text: string;
  cursor: number;
  selection: Selection | null;
}

class FakeStyle implements SyntaxStyle {
  readonly #ids = new Map<string, number>();
  #next = 1;
  resolveStyleId(name: string): number | undefined {
    return this.#ids.get(name);
  }
  registerStyle(name: string, _attrs: { readonly underline?: boolean }): number {
    const existing = this.#ids.get(name);
    if (existing !== undefined) return existing;
    const id = this.#next++;
    this.#ids.set(name, id);
    return id;
  }
  getStyleCount(): number {
    return this.#ids.size;
  }
}

/** When true, new textareas hide `measureText` (r12 H3 degraded mode). */
export let hideMeasureText = false;

export function setHideMeasureText(value: boolean): void {
  hideMeasureText = value;
}

export class FakeTextarea implements TextareaEditor {
  plainText: string;
  cursorOffset: number;
  traits: { owner: string; role: string } = { owner: 'opencode', role: 'prompt' };
  isDestroyed = false;
  syntaxStyle: SyntaxStyle = new FakeStyle();
  x = 0;
  y = 20;
  width = 80;
  height = 3;
  visible = true;
  parent = { id: 'prompt' };
  measureHidden = hideMeasureText;
  readonly marks: Extmark[] = [];
  readonly highlights: Highlight[] = [];
  readonly #history: Snapshot[] = [];
  readonly #redo: Snapshot[] = [];
  #selection: Selection | null = null;
  readonly #content = new Set<() => void>();
  readonly #cursor = new Set<() => void>();
  readonly editBuffer: EditBuffer;

  constructor(rendererOrOptions: unknown, maybeOptions?: TextareaOptions) {
    const options =
      maybeOptions ??
      (rendererOrOptions && typeof rendererOrOptions === 'object' && 'initialValue' in (rendererOrOptions as object)
        ? (rendererOrOptions as TextareaOptions)
        : {});
    this.plainText = options.initialValue ?? '';
    this.cursorOffset = this.#cells(this.plainText);
    const self = this;
    this.editBuffer = {
      measureText: (text) => self.#cells(text),
      getTextRange: (start, end) => self.#range(start, end),
      offsetToPosition: (offset) => self.#position(offset),
      on(event, fn) {
        (event === 'content-changed' ? self.#content : self.#cursor).add(fn);
      },
      off(event, fn) {
        (event === 'content-changed' ? self.#content : self.#cursor).delete(fn);
      },
      listenerCount(event) {
        return (event === 'content-changed' ? self.#content : self.#cursor).size;
      },
    };
    if (this.measureHidden) {
      (this.editBuffer as { measureText?: unknown }).measureText = undefined;
    }
  }

  get visualCursor() {
    const pos = this.#position(this.cursorOffset);
    return { visualCol: pos.col, visualRow: pos.row };
  }

  get extmarks() {
    return { getAll: () => [...this.marks] };
  }

  setSelection(start: number, end: number): void {
    this.#push();
    this.#selection = { start, end };
    this.cursorOffset = end;
    this.#emitCursor();
  }

  clearSelection(): void {
    this.#selection = null;
  }

  getSelection(): Selection | null {
    return this.#selection;
  }

  insertText(text: string): void {
    const [from, to] = this.#selection
      ? [this.#selection.start, this.#selection.end]
      : [this.cursorOffset, this.cursorOffset];
    const prefix = this.#range(0, from);
    const suffix = this.#range(to, this.#cells(this.plainText));
    // Selection + insert is two native checkpoints on OpenTUI (r10 O1).
    if (this.#selection && from !== to) {
      this.#push();
      this.plainText = prefix + suffix;
      this.#selection = null;
    }
    this.#push();
    this.plainText = prefix + text + suffix;
    this.#selection = null;
    this.cursorOffset = this.#cells(prefix + text);
    this.#emitContent();
    this.#emitCursor();
  }

  replaceText(text: string): void {
    this.#push();
    this.plainText = text;
    this.#selection = null;
    this.cursorOffset = this.#cells(text);
    this.#emitContent();
    this.#emitCursor();
  }

  undo(): void {
    const prev = this.#history.pop();
    if (!prev) return;
    this.#redo.push({ text: this.plainText, cursor: this.cursorOffset, selection: this.#selection });
    this.plainText = prev.text;
    this.cursorOffset = prev.cursor;
    this.#selection = prev.selection;
    this.#emitContent();
    this.#emitCursor();
  }

  redo(): void {
    const next = this.#redo.pop();
    if (!next) return;
    this.#history.push({ text: this.plainText, cursor: this.cursorOffset, selection: this.#selection });
    this.plainText = next.text;
    this.cursorOffset = next.cursor;
    this.#selection = next.selection;
    this.#emitContent();
    this.#emitCursor();
  }

  addHighlightByCharRange(highlight: Highlight): void {
    this.highlights.push(highlight);
  }

  removeHighlightsByRef(ref: number): void {
    for (let i = this.highlights.length - 1; i >= 0; i--) {
      if (this.highlights[i]?.hlRef === ref) this.highlights.splice(i, 1);
    }
  }

  getLineHighlights(_line: number): Highlight[] {
    return [...this.highlights];
  }

  destroy(): void {
    this.isDestroyed = true;
    this.#content.clear();
    this.#cursor.clear();
  }

  addVirtual(start: number, end: number): void {
    this.marks.push({ start, end, virtual: true });
  }

  hideMeasure(): void {
    this.measureHidden = true;
  }

  #cells(text: string): number {
    return wcwidth(text);
  }

  #range(start: number, end: number): string {
    if (end <= start) return '';
    let cells = 0;
    let from = 0;
    let to = this.plainText.length;
    let foundFrom = start <= 0;
    for (let i = 0; i < this.plainText.length; ) {
      if (!foundFrom && cells === start) {
        from = i;
        foundFrom = true;
      }
      const cp = this.plainText.codePointAt(i) as number;
      const ch = String.fromCodePoint(cp);
      cells += this.#cells(ch);
      i += ch.length;
      if (foundFrom && cells === end) {
        to = i;
        break;
      }
    }
    if (!foundFrom) from = this.plainText.length;
    if (start <= 0) from = 0;
    if (end >= this.#cells(this.plainText)) to = this.plainText.length;
    return this.plainText.slice(from, to);
  }

  #position(offset: number): { row: number; col: number } {
    const prefix = this.#range(0, offset);
    const lines = prefix.split('\n');
    const last = lines[lines.length - 1] ?? '';
    return { row: lines.length - 1, col: this.#cells(last) };
  }

  #push(): void {
    this.#history.push({ text: this.plainText, cursor: this.cursorOffset, selection: this.#selection });
    this.#redo.length = 0;
  }

  #emitContent(): void {
    for (const fn of this.#content) fn();
  }

  #emitCursor(): void {
    for (const fn of this.#cursor) fn();
  }
}

class FakeOverlay implements TextOverlay {
  id: string;
  visible = true;
  content: string;
  plainText: string;
  left = 0;
  top = 0;
  width: number;
  height: number;
  zIndex: number;
  fg?: string;
  bg?: string;
  destroyed = false;
  constructor(rendererOrOptions: unknown, maybeOptions?: OverlayOptions) {
    const options = maybeOptions ?? (rendererOrOptions as OverlayOptions) ?? {};
    this.id = options.id ?? 'overlay';
    this.content = options.content ?? '';
    this.plainText = this.content;
    this.width = options.width ?? 88;
    this.height = options.height ?? 1;
    this.zIndex = options.zIndex ?? 0;
    if (options.fg !== undefined) this.fg = options.fg;
    if (options.bg !== undefined) this.bg = options.bg;
  }
  destroy(): void {
    this.destroyed = true;
    this.visible = false;
  }
}

export class FakeOpenCode {
  readonly prompt: FakeTextarea;
  mode = 'base';
  pendingKeys: { key: string; token?: string }[] = [];
  shortcuts: Record<string, string[]> = {
    'input.undo': ['ctrl+-', 'super+z'],
    'input.newline': ['shift+enter'],
    'prompt.submit': ['enter', 'ctrl+m'],
    'prompt.queue': ['ctrl+x enter'],
  };
  dispatched: string[] = [];
  sessionStatus = 'idle';
  slotClaims: { append?: string; prepend?: string }[] = [];
  inbox: ((event: { inboxID: string; item: { payload: { text: string } } }) => void)[] = [];
  layers: { id: string; run: () => void }[] = [];
  readonly children: unknown[] = [];
  readonly api: OpenCodeApi;
  readonly core: OpenTuiCore;
  #keypress: KeypressHandler[] = [];
  #paste: PasteHandler[] = [];
  #focus: Array<(...args: unknown[]) => void> = [];
  #applyKeys = true;

  constructor() {
    this.prompt = new FakeTextarea({ initialValue: '' });
    const host = this;
    this.api = {
      renderer: {
        get currentFocusedEditor() {
          return host.prompt.isDestroyed ? null : host.prompt;
        },
        set currentFocusedEditor(value) {
          void value;
        },
        keyInput: {
          prependListener(event, fn) {
            if (event === 'keypress') host.#keypress.unshift(fn as KeypressHandler);
            else host.#paste.unshift(fn as PasteHandler);
          },
          removeListener(event, fn) {
            if (event === 'keypress') host.#keypress = host.#keypress.filter((h) => h !== fn);
            else host.#paste = host.#paste.filter((h) => h !== fn);
          },
          listeners(event: string) {
            return event === 'keypress' ? host.#keypress : [];
          },
          listenerCount(event) {
            return event === 'keypress' ? host.#keypress.length : host.#paste.length;
          },
          processParsedKey(raw) {
            let prevented = false;
            const key: ParsedKey = {
              ...raw,
              preventDefault() {
                prevented = true;
                this.defaultPrevented = true;
              },
              stopPropagation() {
                prevented = true;
              },
            };
            for (const handler of [...host.#keypress]) handler(key);
            if (!prevented && host.#applyKeys) host.#apply(key);
          },
        },
        root: {
          add(node) {
            host.children.push(node);
          },
          getChildren() {
            return host.children;
          },
        },
        width: 120,
        height: 40,
        requestRender() {},
        on(event, fn) {
          if (event === FOCUSED_EDITOR) host.#focus.push(fn);
        },
        removeListener(event, fn) {
          if (event === FOCUSED_EDITOR) host.#focus = host.#focus.filter((h) => h !== fn);
        },
      },
      keymap: {
        shortcuts: (id) => host.shortcuts[id] ?? [],
        pending: () => host.pendingKeys,
        mode: { current: () => host.mode },
        dispatch(command) {
          host.dispatched.push(command);
          if (command === 'prompt.submit' || command === 'prompt.queue') {
            const text = host.prompt.plainText;
            host.prompt.replaceText('');
            for (const fn of host.inbox)
              fn({ inboxID: `inbox-${host.dispatched.length}`, item: { payload: { text } } });
          }
        },
        layer(factory) {
          const spec = factory();
          for (const command of spec.commands ?? []) host.layers.push({ id: command.id, run: command.run });
          return () => {
            host.layers = [];
          };
        },
        commands: () => host.layers.map((c) => ({ id: c.id, title: c.id })),
      },
      ui: {
        slot(claim) {
          host.slotClaims.push({
            ...(claim.append ? { append: claim.append } : {}),
            ...(claim.prepend ? { prepend: claim.prepend } : {}),
          });
          try {
            claim.render();
          } catch {
            // Host Solid JSX is not required for the claim itself.
          }
          return () => {
            host.slotClaims = host.slotClaims.filter((c) => c.append !== claim.append);
          };
        },
        router: { current: () => ({ type: 'session', sessionID: 's1' }) },
        model: { current: () => 'fake' },
      },
      data: {
        session: { status: () => host.sessionStatus },
        on(event, fn) {
          if (event === 'session.inbox.enqueued') host.inbox.push(fn);
          return () => {
            host.inbox = host.inbox.filter((h) => h !== fn);
          };
        },
      },
    };
    this.core = {
      TextareaRenderable: FakeTextarea as unknown as OpenTuiCore['TextareaRenderable'],
      TextRenderable: FakeOverlay as unknown as OpenTuiCore['TextRenderable'],
    };
  }

  /** Peer prepends after Murmo; public listener order is the evidence (E4). */
  prependPeer(fn: KeypressHandler): void {
    this.#keypress.unshift(fn);
  }

  keypressHandlers(): readonly KeypressHandler[] {
    return this.#keypress;
  }

  focusPrompt(): void {
    for (const fn of this.#focus) fn(this.prompt, null);
  }

  type(text: string): void {
    for (const ch of text) {
      this.press({
        name: ch === ' ' ? 'space' : ch,
        sequence: ch,
      });
    }
  }

  press(partial: Omit<ParsedKey, 'preventDefault' | 'stopPropagation' | 'defaultPrevented'>): void {
    this.api.renderer.keyInput.processParsedKey(partial);
  }

  paste(text: string): void {
    const bytes = new TextEncoder().encode(text);
    const event: PasteEvent = { bytes };
    for (const handler of [...this.#paste]) handler(event);
    if (this.#applyKeys) {
      const at = this.prompt.cursorOffset;
      this.prompt.clearSelection();
      this.prompt.cursorOffset = at;
      this.prompt.insertText(text);
    }
  }

  openAutocomplete(): void {
    this.mode = 'autocomplete';
  }

  openModal(): void {
    this.mode = 'modal';
  }

  /** Approval dialog: host reports no modal (E9). Focus may keep the prompt. */
  openApproval(): void {
    this.mode = 'base';
  }

  #apply(key: ParsedKey): void {
    if (key.ctrl || key.meta || key.super || key.option) return;
    const seq = key.sequence;
    if (typeof seq === 'string' && seq.length === 1) this.prompt.insertText(seq);
    else if (key.name === 'backspace') {
      const text = this.prompt.plainText;
      if (!text) return;
      this.prompt.replaceText(text.slice(0, -1));
    } else if (key.name === 'return' || key.name === 'enter') {
      this.api.keymap.dispatch('prompt.submit');
    }
  }
}
