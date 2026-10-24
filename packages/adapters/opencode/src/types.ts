// OpenCode / OpenTUI surfaces this adapter actually calls. Kept as structural
// types so tests inject fakes and the TUI entry never depends on a pin of
// `@opentui/core` (lessons 7, 35).

export interface ParsedKey {
  name: string;
  sequence: string;
  raw?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  option?: boolean;
  super?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  defaultPrevented?: boolean;
}

/** OpenTUI paste events carry bytes and no `text` field (phase 22 Design). */
export interface PasteEvent {
  readonly bytes: Uint8Array;
}

export interface Extmark {
  readonly start: number;
  readonly end: number;
  readonly virtual?: boolean;
}

export interface EditorTraits {
  readonly owner?: string;
  readonly role?: string;
  readonly status?: string;
  readonly capture?: readonly string[];
}

export interface BufferPosition {
  readonly row: number;
  readonly col: number;
}

export interface EditBuffer {
  measureText(text: string): number;
  getTextRange(start: number, end: number): string;
  offsetToPosition(offset: number): BufferPosition;
  on(event: 'content-changed' | 'cursor-changed', fn: () => void): void;
  off(event: 'content-changed' | 'cursor-changed', fn: () => void): void;
  listenerCount?(event: string): number;
}

export interface SyntaxStyle {
  resolveStyleId(name: string): number | undefined;
  registerStyle(name: string, attrs: { readonly underline?: boolean }): number;
  getStyleCount?(): number;
}

export interface Highlight {
  start: number;
  end: number;
  styleId: number;
  hlRef: number;
}

export interface Selection {
  readonly start: number;
  readonly end: number;
}

export interface VisualCursor {
  readonly visualCol: number;
  readonly visualRow: number;
}

export interface TextareaEditor {
  plainText: string;
  cursorOffset: number;
  traits: EditorTraits;
  isDestroyed: boolean;
  readonly editBuffer: EditBuffer;
  readonly extmarks: { getAll(): readonly Extmark[] };
  syntaxStyle: SyntaxStyle;
  readonly visualCursor: VisualCursor;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  /** The prompt box the textarea sits in (OpenTUI `parent`): screen position and size. */
  readonly parent?: PromptBox | null;
  setSelection(start: number, end: number): void;
  clearSelection(): void;
  getSelection(): Selection | null;
  insertText(text: string): void;
  replaceText(text: string): void;
  undo(): void;
  redo(): void;
  addHighlightByCharRange(highlight: Highlight): void;
  removeHighlightsByRef(ref: number): void;
  getLineHighlights(line: number): readonly Highlight[];
  destroy(): void;
}

/**
 * A host layout node Murmo may draw into: the prompt's box. Absolute children
 * are placed relative to it and move with it when the host lays it out again.
 */
export interface PromptBox {
  readonly id?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly isDestroyed?: boolean;
  add?(node: TextOverlay): unknown;
}

export interface TextOverlay {
  id: string;
  visible: boolean;
  content: string;
  /** Read-only on OpenTUI's TextRenderable: assigning it throws. */
  readonly plainText: string;
  readonly isDestroyed?: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
  fg?: string;
  bg?: string;
  destroy(): void;
}

export type KeypressHandler = (key: ParsedKey) => void;
export type PasteHandler = (event: PasteEvent) => void;

export interface KeyInput {
  prependListener(event: 'keypress', fn: KeypressHandler): void;
  prependListener(event: 'paste', fn: PasteHandler): void;
  removeListener(event: 'keypress', fn: KeypressHandler): void;
  removeListener(event: 'paste', fn: PasteHandler): void;
  listeners(event: 'keypress'): readonly KeypressHandler[];
  listeners(event: string): readonly unknown[];
  listenerCount(event: string): number;
  processParsedKey(key: Omit<ParsedKey, 'preventDefault' | 'stopPropagation' | 'defaultPrevented'>): void;
}

export interface KeymapPending {
  readonly key: string;
  readonly token?: string;
}

export interface KeymapLayerCommand {
  readonly id: string;
  readonly title?: string;
  readonly run: () => void;
}

export interface OpenCodeKeymap {
  shortcuts(id: string): readonly string[];
  pending(): readonly KeymapPending[];
  readonly mode: { current(): string };
  dispatch(command: string): void;
  layer(factory: () => { readonly commands?: readonly KeymapLayerCommand[] }): () => void;
  commands(): readonly { readonly id: string; readonly title?: string; readonly group?: string }[];
}

/** What the host passes a slot's render; `prompt.footer` has a session ID only in a session. */
export interface SlotInput {
  readonly sessionID?: string;
  readonly mode?: string;
}

export interface SlotClaim {
  readonly append?: string;
  readonly prepend?: string;
  readonly render: (input?: SlotInput) => unknown;
}

export interface OpenCodeUi {
  slot(claim: SlotClaim): () => void;
  readonly router: { current(): { readonly type: string; readonly sessionID?: string } };
  readonly model: { current(): unknown };
}

export interface InboxEnqueued {
  readonly sessionID?: string;
  readonly inboxID?: string;
  readonly item?: { readonly payload?: { readonly text?: string } };
}

export interface OpenCodeData {
  readonly session: { status(id: string): string };
  on?(event: string, fn: (payload: InboxEnqueued) => void): () => void;
}

export interface OpenCodeRenderer {
  currentFocusedEditor: TextareaEditor | null;
  readonly keyInput: KeyInput;
  readonly root: {
    add(node: TextOverlay): void;
    getChildren(): readonly unknown[];
  };
  width: number;
  height: number;
  requestRender(): void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  removeListener(event: string, fn: (...args: unknown[]) => void): void;
  setFrameCallback?(fn: () => void | Promise<void>): void;
  removeFrameCallback?(fn: () => void | Promise<void>): void;
}

export interface OpenCodeApi {
  readonly renderer: OpenCodeRenderer;
  readonly keymap: OpenCodeKeymap;
  readonly ui: OpenCodeUi;
  readonly data: OpenCodeData;
}

export interface TextareaOptions {
  readonly initialValue?: string;
  readonly width?: number;
  readonly height?: number;
  readonly id?: string;
}

export type TextareaConstructor = new (renderer: OpenCodeRenderer, options: TextareaOptions) => TextareaEditor;

export interface OverlayOptions {
  readonly id?: string;
  readonly position?: string;
  readonly top?: number;
  readonly left?: number;
  readonly width?: number;
  readonly height?: number;
  readonly zIndex?: number;
  readonly bg?: string;
  readonly fg?: string;
  readonly content?: string;
  readonly wrapMode?: 'none' | 'char' | 'word';
  readonly truncate?: boolean;
  readonly flexShrink?: number;
}

export type TextRenderableConstructor = new (renderer: OpenCodeRenderer, options: OverlayOptions) => TextOverlay;

export interface OpenTuiCore {
  readonly TextareaRenderable: TextareaConstructor;
  readonly TextRenderable: TextRenderableConstructor;
}

export const FOCUSED_EDITOR = 'focused_editor';

export const MURMO_HIGHLIGHT_REF = 65533;
export const MURMO_INLINE_HIGHLIGHT_REF = 65532;

export const STATUS_COLUMNS = 88;
export const STATUS_MAX_ROWS = 3;
export const MENU_WINDOW = 7;
export const INLINE_MAX_BYTES = 16384;
