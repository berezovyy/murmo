// A public-contract Pi editor and TUI for offline tests. Behavior matches
// Pi 1.3.0's documented surface: setText clears the paste registry and jumps
// the cursor to the end; undo has no redo; Tab runs stacked providers.

import { stripSequences } from '../src/ansi.ts';
import { stripPasteMarkers } from '../src/keys.ts';
import {
  CURSOR_APC,
  FAKE_CURSOR_END,
  FAKE_CURSOR_START,
  type PiAutocompleteFactory,
  type PiAutocompleteProvider,
  type PiEditor,
  type PiEditorFactory,
  type PiHost,
  type PiKeybindings,
  type PiSessionContext,
  type PiTui,
  type PiUi,
  type TuiApi,
} from '../src/types.ts';

export type FakeCursorFormat = 'pi:fc' | 'sgr-7m';

function parsePiKey(data: string): string | undefined {
  if (data === '\t') return 'tab';
  if (data === '\x1b[Z') return 'shift+tab';
  if (data === '\r') return 'enter';
  if (data === '\n') return 'enter';
  if (data === '\x1b') return 'escape';
  if (data === '\x1b[A') return 'up';
  if (data === '\x1b[B') return 'down';
  if (data === '\x1b[C') return 'right';
  if (data === '\x1b[D') return 'left';
  if (data === '\x7f') return 'backspace';
  if (data === '\x1b[17~') return 'f6';
  if (data === '\x1f') return 'ctrl+_';
  if (data === ' ') return 'space';
  if (data === '\x1bc') return 'alt+c';
  if (data === '\x1b\r' || data === '\x1b[13;3u') return 'alt+enter';
  if (data.length === 1) {
    const c = data.charCodeAt(0);
    if (c > 0x1f && !(c >= 0x7f && c <= 0x9f)) return data;
  }
  return undefined;
}

export class FakePiEditor implements PiEditor {
  lines = [''];
  cursor = { line: 0, col: 0 };
  focused = true;
  showingAutocomplete = false;
  format: FakeCursorFormat = 'pi:fc';
  onChange?: (text: string) => void;
  onSubmit?: (text: string) => void;
  ui: FakePiUi | undefined;
  nativeKey?: (data: string) => void;
  readonly paste = new Map<string, string>();
  #pastes = 0;
  readonly undo: { text: string; cursor: { line: number; col: number } }[] = [];
  throwOnInput = false;
  throwOnRender = false;
  submitCount = 0;

  // EditorBase is `new (tui, theme, keybindings)`.
  constructor(_tui?: unknown, _theme?: unknown, _bindings?: unknown) {
    void _tui;
    void _theme;
    void _bindings;
  }

  getText(): string {
    return this.lines.join('\n');
  }

  getExpandedText(): string {
    let text = this.getText();
    for (const [marker, full] of this.paste) text = text.split(marker).join(full);
    return text;
  }

  getLines(): string[] {
    return [...this.lines];
  }

  getCursor(): { line: number; col: number } {
    return { ...this.cursor };
  }

  setText(text: string): void {
    this.#push();
    this.lines = text.split('\n');
    this.cursor = { line: this.lines.length - 1, col: (this.lines[this.lines.length - 1] ?? '').length };
    this.paste.clear();
    this.onChange?.(this.getText());
  }

  isShowingAutocomplete(): boolean {
    return this.showingAutocomplete;
  }

  onAction(_action: string, _handler: () => void): void {}

  addToHistory(_text: string): void {}

  insertTextAtCursor(text: string): void {
    this.#push();
    this.#insert(text);
    this.onChange?.(this.getText());
  }

  handleInput(data: string): void {
    if (this.throwOnInput) throw new Error('injected handleInput throw');
    if (data.includes('\x1b[200~')) {
      const inner = stripPasteMarkers(data);
      this.#push();
      if (inner.split('\n').length > 10 || inner.length > 1000) {
        this.#pastes++;
        const extra = inner.split('\n').length - 1;
        const marker = `[paste #${this.#pastes} +${extra} lines]`;
        this.paste.set(marker, inner);
        this.#insert(marker);
      } else {
        this.#insert(inner);
      }
      this.onChange?.(this.getText());
      return;
    }
    if (data === '\t') {
      void this.#tab();
      return;
    }
    if (data === '\r') {
      this.submitCount++;
      this.onSubmit?.(this.getText());
      this.setText('');
      return;
    }
    if (data === '\n') {
      this.#push();
      this.#insert('\n');
      this.onChange?.(this.getText());
      return;
    }
    if (data === '\x7f') {
      const at = this.#offset();
      if (at === 0) return;
      this.#push();
      const text = this.getText();
      const next = text.slice(0, at - 1) + text.slice(at);
      this.#load(next, at - 1);
      this.onChange?.(this.getText());
      return;
    }
    if (data === '\x1f') {
      const snap = this.undo.pop();
      if (!snap) return;
      this.lines = snap.text.split('\n');
      this.cursor = { ...snap.cursor };
      this.onChange?.(this.getText());
      return;
    }
    if (data === '\x1b[C') {
      const at = this.#offset();
      if (at < this.getText().length) this.#load(this.getText(), at + 1);
      return;
    }
    if (data === '\x1b[D') {
      const at = this.#offset();
      if (at > 0) this.#load(this.getText(), at - 1);
      return;
    }
    if (data === '\x1b') {
      this.showingAutocomplete = false;
      return;
    }
    if (data.length === 1) {
      const c = data.charCodeAt(0);
      if (c > 0x1f && !(c >= 0x7f && c <= 0x9f)) {
        if (data === ' ') this.#push();
        this.#insert(data);
        this.onChange?.(this.getText());
      }
    }
  }

  render(width: number): string[] {
    if (this.throwOnRender) throw new Error('injected render throw');
    const line = this.lines[this.cursor.line] ?? '';
    const before = line.slice(0, this.cursor.col);
    const after = line.slice(this.cursor.col);
    const fake = this.format === 'pi:fc' ? `${FAKE_CURSOR_START} ${FAKE_CURSOR_END}` : '\x1b[7m \x1b[0m';
    const pad = Math.max(0, width - before.length - 1 - after.length);
    const row = `${before}${CURSOR_APC}${fake}${after}${' '.repeat(pad)}`;
    const rows = this.lines.map((text, i) => (i === this.cursor.line ? row : text.padEnd(width, ' ')));
    return rows;
  }

  #offset(): number {
    return this.lines.slice(0, this.cursor.line).reduce((n, line) => n + line.length + 1, 0) + this.cursor.col;
  }

  #load(text: string, offset: number): void {
    this.lines = text.split('\n');
    let rest = offset;
    for (let i = 0; i < this.lines.length; i++) {
      const line = this.lines[i] ?? '';
      if (rest <= line.length) {
        this.cursor = { line: i, col: rest };
        return;
      }
      rest -= line.length + 1;
    }
    const last = this.lines[this.lines.length - 1] ?? '';
    this.cursor = { line: this.lines.length - 1, col: last.length };
  }

  #insert(text: string): void {
    const current = this.getText();
    const at = this.#offset();
    this.#load(current.slice(0, at) + text + current.slice(at), at + text.length);
  }

  #push(): void {
    this.undo.push({ text: this.getText(), cursor: { ...this.cursor } });
  }

  async #tab(): Promise<void> {
    const provider = this.ui?.provider();
    if (!provider) return;
    // pi-tui applies a lone forced Tab suggestion without ever showing the list.
    const suggestions = await provider.getSuggestions(this.getLines(), this.cursor.line, this.cursor.col, {
      force: true,
    });
    const item = suggestions?.items[0];
    if (item && suggestions) {
      const applied = provider.applyCompletion(
        this.getLines(),
        this.cursor.line,
        this.cursor.col,
        item,
        suggestions.prefix,
      );
      this.lines = applied.lines;
      this.cursor = { line: applied.cursorLine, col: applied.cursorCol };
      this.showingAutocomplete = false;
      this.onChange?.(this.getText());
    } else {
      this.showingAutocomplete = false;
    }
  }
}

export class FakePiUi implements PiUi {
  factory: PiEditorFactory | undefined;
  editor: FakePiEditor;
  overlay = false;
  readonly tui: PiTui;
  readonly notices: string[] = [];
  readonly providers: PiAutocompleteProvider[] = [];
  readonly inputHandlers: ((data: string) => { consume: boolean } | undefined)[] = [];
  locked = false;

  constructor(editor: FakePiEditor, tui: PiTui) {
    this.editor = editor;
    this.tui = tui;
    editor.ui = this;
  }

  setEditorComponent(factory: PiEditorFactory | undefined): void {
    if (this.locked) return;
    this.factory = factory;
    if (factory) {
      const next = factory(this.tui, {}, bindings);
      if (next instanceof FakePiEditor) {
        next.ui = this;
        this.editor = next;
      } else {
        this.editor = next as FakePiEditor;
        (this.editor as FakePiEditor).ui = this;
      }
    }
  }

  getEditorComponent(): PiEditorFactory | undefined {
    return this.factory;
  }

  /** Exclusive peer: keep the current factory and ignore later Murmo writes. */
  steal(factory: PiEditorFactory): void {
    this.factory = factory;
    this.locked = true;
  }

  terminalInput(data: string): void {
    for (const handler of this.inputHandlers) handler(data);
  }

  addAutocompleteProvider(factory: PiAutocompleteFactory): void {
    const current: PiAutocompleteProvider = this.providers[0] ?? {
      getSuggestions: () => null,
      applyCompletion: (lines, line, col) => ({ lines: [...lines], cursorLine: line, cursorCol: col }),
    };
    this.providers.unshift(factory(current));
  }

  provider(): PiAutocompleteProvider | undefined {
    return this.providers[0];
  }

  notify(message: string): void {
    this.notices.push(message);
  }

  onTerminalInput(handler: (data: string) => { consume: boolean } | undefined): () => void {
    this.inputHandlers.push(handler);
    return () => {
      const at = this.inputHandlers.indexOf(handler);
      if (at >= 0) this.inputHandlers.splice(at, 1);
    };
  }
}

export class FakePiHost implements PiHost {
  readonly handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();

  on(event: string, handler: (...args: unknown[]) => unknown): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {
      const next = (this.handlers.get(event) ?? []).filter((h) => h !== handler);
      this.handlers.set(event, next);
    };
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

const bindings: PiKeybindings = {
  matches(data, action) {
    if (action === 'tui.input.submit') return data === '\r';
    if (action === 'tui.input.newLine') return data === '\n' || data === '\x1b\r';
    if (action === 'tui.editor.undo') return data === '\x1f';
    if (action === 'app.message.followUp') return data === '\x1b\r' || data === '\x1b[13;3u';
    return false;
  },
};

export const fakeTuiApi: TuiApi = {
  CURSOR_MARKER: CURSOR_APC,
  parseKey: parsePiKey,
  renderFakeCursor: (ch) => `${FAKE_CURSOR_START}${ch}${FAKE_CURSOR_END}`,
  truncateToWidth: (text, width) => (text.length <= width ? text : text.slice(0, width)),
  visibleWidth: (text) => stripSequences(text).length,
};

export interface FakePi {
  readonly host: FakePiHost;
  readonly ctx: PiSessionContext;
  readonly ui: FakePiUi;
  readonly tui: PiTui;
  editor: FakePiEditor;
  idle: boolean;
}

export function createFakePi(): FakePi {
  const tui: PiTui = {
    renderNow() {},
    hasOverlay() {
      return ui.overlay;
    },
  };
  const editor = new FakePiEditor(tui, {}, bindings);
  const ui = new FakePiUi(editor, tui);
  const host = new FakePiHost();
  const box: FakePi = {
    host,
    ui,
    tui,
    editor,
    idle: true,
    ctx: {
      mode: 'tui',
      hasUI: true,
      isIdle: () => box.idle,
      ui,
    },
  };
  Object.defineProperty(box, 'editor', {
    get: () => ui.editor,
  });
  return box;
}
