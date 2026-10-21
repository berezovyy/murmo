// Public Pi surfaces the adapter wraps. Named by behavior, not by host version
// (lesson 23): probes check these methods exist and work.

export interface PiCursor {
  readonly line: number;
  readonly col: number;
}

export interface PiKeybindings {
  matches(data: string, action: string): boolean;
}

export interface PiAutocompleteItem {
  readonly value: string;
  readonly label?: string;
}

export interface PiAutocompleteSuggestions {
  readonly prefix: string;
  readonly items: readonly PiAutocompleteItem[];
}

export interface PiAutocompleteApply {
  readonly lines: string[];
  readonly cursorLine: number;
  readonly cursorCol: number;
}

export interface PiAutocompleteProvider {
  readonly triggerCharacters?: readonly string[];
  shouldTriggerFileCompletion?(...args: unknown[]): boolean;
  getSuggestions(
    lines: string[],
    line: number,
    col: number,
    opts: { force?: boolean },
  ): PiAutocompleteSuggestions | null | Promise<PiAutocompleteSuggestions | null>;
  applyCompletion(
    lines: string[],
    line: number,
    col: number,
    item: PiAutocompleteItem,
    prefix: string,
  ): PiAutocompleteApply;
}

export type PiAutocompleteFactory = (current: PiAutocompleteProvider) => PiAutocompleteProvider;

export interface PiEditor {
  handleInput(data: string): void;
  render(width: number): string[];
  getText(): string;
  getCursor(): PiCursor;
  getLines(): string[];
  getExpandedText(): string;
  setText(text: string): void;
  onAction(action: string, handler: () => void): void;
  isShowingAutocomplete(): boolean;
  focused: boolean;
  onChange?: (text: string) => void;
  onSubmit?: (text: string) => void;
  addToHistory?(text: string): void;
  insertTextAtCursor?(text: string): void;
  nativeKey?(data: string): void;
}

export type PiEditorFactory = (...args: unknown[]) => PiEditor;

export interface PiTui {
  renderNow(): void;
  hasOverlay?(): boolean;
}

export interface PiUi {
  setEditorComponent(factory: PiEditorFactory | undefined): void;
  getEditorComponent(): PiEditorFactory | undefined;
  addAutocompleteProvider(factory: PiAutocompleteFactory): void;
  notify(message: string, level?: string): void;
  onTerminalInput(handler: (data: string) => { consume: boolean } | undefined): () => void;
  readonly tui?: PiTui;
}

export interface PiSessionContext {
  readonly mode: string;
  readonly hasUI?: boolean;
  readonly model?: { readonly baseUrl?: string };
  isIdle(): boolean;
  readonly ui: PiUi;
}

export type PiEventResult = unknown;

export interface PiHost {
  on(event: string, handler: (...args: unknown[]) => PiEventResult | Promise<PiEventResult>): () => void;
  registerCommand?(name: string, spec: { description: string; handler: () => Promise<void> | void }): void;
}

export interface TuiApi {
  readonly CURSOR_MARKER?: string;
  parseKey(data: string): string | undefined;
  renderFakeCursor?(ch: string): string;
  truncateToWidth(text: string, width: number): string;
  visibleWidth?(text: string): number;
}

export type EditorBase = new (tui: PiTui, theme: unknown, keybindings: PiKeybindings, options?: unknown) => PiEditor;

export const EDITOR_CONTRACT = [
  'handleInput',
  'render',
  'getText',
  'getCursor',
  'getLines',
  'getExpandedText',
  'onAction',
] as const;

export function hasEditorContract(value: unknown): value is PiEditor {
  if (!value || typeof value !== 'object') return false;
  const editor = value as Record<string, unknown>;
  return EDITOR_CONTRACT.every((name) => typeof editor[name] === 'function');
}

export const MURMO_UNDO = '\x1f';
export const CURSOR_APC = '\x1b_pi:c\x07';
export const FAKE_CURSOR_START = '\x1b_pi:fc\x07';
export const FAKE_CURSOR_END = '\x1b_pi:/fc\x07';
export const OWNERSHIP_LOST = 'ownership-lost';
export const PI_SLOT = Symbol.for('murmo.pi');
export const HIGHLIGHT_MS = 1500;
export const EDIT_TIMEOUT_MS = 100;
export const INLINE_MAX_BYTES = 16384;
