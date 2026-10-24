// Claude Code plugin runtime as the adapter uses it (2.1.302–2.1.304).
// Generated host types are a dev input, never shipped (docs/plan/24).

export const PLUGIN_VERSION = '0.0.0';
export const TESTED_HOST = '2.1.304';
/** Real `prompt.edit` budget (types still say 10 s). A slow handler is skipped (lesson 15). */
export const EDIT_BUDGET_MS = 50;
/** Classic `UserPromptSubmit` timeout we ship. Tool hooks allowed the action after 1 s (E20). */
export const CLASSIC_GUARD_TIMEOUT_MS = 1000;
/** `$.fs` per-call ceiling. */
export const FS_MAX_BYTES = 4 * 1024 * 1024;
/** Space expansions above this stay literal; Tab inserts the large value (lesson 70). */
export const INLINE_MAX_BYTES = 1024;
export const HINT_SEPARATOR = ' · ';
export const INLINE_DISABLED_NOTICE = 'Inline disabled: prompt.edit unavailable';

export interface ClaudeKeyEvent {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export interface PromptBox {
  readonly text: string;
  readonly cursor: number;
}

export interface PromptDecoration {
  readonly start: number;
  readonly end: number;
  readonly virtualText?: string;
  readonly dimColor?: boolean;
  readonly underline?: boolean;
  readonly color?: string;
}

export interface PromptEditInput extends PromptBox {
  readonly origin: { readonly kind: string };
  readonly key?: ClaudeKeyEvent;
  readonly start: number;
  readonly end: number;
  readonly inputText: string;
}

export interface PromptEditResult extends PromptBox {
  readonly decorations?: readonly PromptDecoration[];
}

export interface PromptChangeInput extends PromptBox {
  readonly origin: { readonly kind: string };
}

export interface PromptSubmitInput {
  readonly text: string;
  readonly origin?: { readonly kind: string };
}

export interface PromptSubmitResult {
  readonly drop?: string;
}

export interface ClassicSubmitInput {
  readonly prompt: string;
}

export interface ClassicSubmitResult {
  readonly block?: string;
}

export interface AutocompleteInput extends PromptBox {
  readonly token: string;
  readonly start: number;
}

export interface AutocompleteSuggestion {
  readonly text: string;
  readonly label?: string;
  readonly description?: string;
}

export interface AutocompleteResult {
  readonly suggestions: readonly AutocompleteSuggestion[];
}

export interface PromptHintProps {
  readonly hint: string;
  readonly isWorking?: boolean;
  readonly isDraft?: boolean;
  readonly tail?: string;
}

export interface RenderEvent {
  readonly component?: string;
  /** The surface's size in cells; absent where none has measured. */
  readonly viewport?: { readonly columns?: number; readonly rows?: number };
  readonly props: PromptHintProps & Record<string, unknown>;
}

export interface FillResult extends PromptBox {
  readonly isFilled?: boolean;
  readonly refusal?: string;
}

/** `prompt.suggest`: false while the box holds text, a turn runs, or headless. */
export interface SuggestResult {
  readonly isShown: boolean;
}

export interface FsBytes {
  readonly base64: string;
}

export interface ClockHandle {
  cancel(): void;
}

export interface SpawnChunk {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface SpawnStream extends AsyncIterable<SpawnChunk> {
  return?(): Promise<IteratorResult<SpawnChunk>>;
}

export interface ConfigRow {
  readonly key: string;
  readonly value: unknown;
}

export interface UiComponents {
  readonly Box: unknown;
  readonly Text: unknown;
}

export interface ClaudeFetchInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly socketPath?: string;
}

export interface ClaudeFetchResult {
  readonly text: string;
}

/**
 * What a session uses of `$` beyond startup reads. Claude 2.1.30x's marketplace
 * analyzer refuses a hooks module that passes `$` itself (or an alias of it) as
 * an argument, so the packed entry hands over these closures instead, each a
 * plain `$.noun.event(...)` call.
 */
export interface HostServices {
  after(ms: number, callback: () => void): ClockHandle;
  spawn(argv: readonly string[]): SpawnStream;
  fetch(url: string, init: ClaudeFetchInit): Promise<ClaudeFetchResult>;
  /** Draws Murmo's status tail again: Claude keeps a render's answer until its props change. */
  repaint(): void;
  /** Claude's dim suggestion in the empty prompt, which Tab or → puts in the box. */
  suggest(text: string): Promise<SuggestResult>;
}

/** The `$` object Claude injects into every hook. */
export interface ClaudeRuntime {
  readonly plugin: { readonly root: string };
  readonly env: { get(name: string): Promise<string | undefined> };
  readonly fs: {
    read(path: string, options?: { readonly as?: 'bytes' | 'text' }): Promise<string | FsBytes>;
    write(path: string, content: string): Promise<void>;
    exists(path: string): Promise<boolean>;
  };
  readonly session: { cwd(): Promise<string> };
  readonly prompt: {
    read(): Promise<PromptBox>;
    fill(request: {
      readonly text: string;
      readonly mode?: string;
      readonly decorations?: readonly PromptDecoration[];
    }): Promise<FillResult>;
    suggest(request: { readonly text: string }): Promise<SuggestResult>;
  };
  readonly clock: {
    after(ms: number, callback: () => void): ClockHandle;
    every(ms: number, callback: () => void): ClockHandle;
    sleep(ms: number): Promise<void>;
  };
  readonly process: {
    spawn(request: { readonly argv: readonly string[] }): SpawnStream;
    run?(
      argv: readonly string[],
    ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  };
  readonly http: {
    fetch(url: string, init: ClaudeFetchInit): Promise<ClaudeFetchResult>;
  };
  readonly config: { list(): Promise<readonly ConfigRow[]> };
  readonly ui: {
    invalidate(name: string): void;
    resolve(event: RenderEvent): UiComponents;
  };
}

export type NextFn<T, R> = (event: T) => R | Promise<R>;

export type HookHandler<T, R> = ($: ClaudeRuntime, event: T, next: NextFn<T, R>) => R | Promise<R>;

export interface HookOptions {
  readonly component?: string;
  readonly timeout?: number;
}

export interface ClaudeRegister {
  (name: 'session.start' | 'session.end', handler: HookHandler<unknown, unknown>): void;
  (name: 'prompt.edit', handler: HookHandler<PromptEditInput, PromptEditResult>): void;
  (name: 'prompt.change', handler: HookHandler<PromptChangeInput, unknown>): void;
  (name: 'prompt.submit', handler: HookHandler<PromptSubmitInput, PromptSubmitResult>): void;
  (
    name: 'classic.UserPromptSubmit',
    options: HookOptions,
    handler: HookHandler<ClassicSubmitInput, ClassicSubmitResult>,
  ): void;
  (name: 'prompt.autocomplete', handler: HookHandler<AutocompleteInput, AutocompleteResult>): void;
  (name: 'ui.render', options: HookOptions, handler: HookHandler<RenderEvent, unknown>): void;
  (name: string, handler: HookHandler<unknown, unknown>): void;
  (name: string, options: HookOptions, handler: HookHandler<unknown, unknown>): void;
}

export interface ProbeFlags {
  promptEdit: boolean;
  virtualText: boolean;
  autocomplete: boolean;
  classicGuard: boolean;
  hintCalibration: boolean;
  base64Fs: boolean;
  helper: boolean;
}

export const defaultProbes = (): ProbeFlags => ({
  promptEdit: true,
  virtualText: true,
  autocomplete: true,
  classicGuard: true,
  hintCalibration: true,
  base64Fs: true,
  helper: false,
});
