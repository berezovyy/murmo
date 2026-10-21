// Type-only fallbacks so the extension entry type-checks without Pi installed.
// The compiled bundle leaves these imports external; Pi's node_modules resolves them.

declare module '@earendil-works/pi-coding-agent' {
  export const VERSION: string;
  export class CustomEditor {
    constructor(tui: unknown, theme: unknown, keybindings: unknown, options?: unknown);
    handleInput(data: string): void;
    render(width: number): string[];
    getText(): string;
    getCursor(): { line: number; col: number };
    getLines(): string[];
    getExpandedText(): string;
    setText(text: string): void;
    onAction(action: string, handler: () => void): void;
    isShowingAutocomplete(): boolean;
    focused: boolean;
    onChange?: (text: string) => void;
    onSubmit?: (text: string) => void;
  }
}

declare module '@earendil-works/pi-tui' {
  export const CURSOR_MARKER: string;
  export function parseKey(data: string): string | undefined;
  export function renderFakeCursor(ch: string): string;
  export function truncateToWidth(text: string, width: number): string;
  export function visibleWidth(text: string): number;
}
