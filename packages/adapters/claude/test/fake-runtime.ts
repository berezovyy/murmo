// In-memory Claude `$` and a tiny editor, so adapter tests never launch a host.

import { encodeTable } from '@murmo/lang';
import type {
  AutocompleteInput,
  AutocompleteResult,
  ClassicSubmitInput,
  ClassicSubmitResult,
  ClaudeRegister,
  ClaudeRuntime,
  ClockHandle,
  ConfigRow,
  FillResult,
  FsBytes,
  HostServices,
  PromptBox,
  PromptChangeInput,
  PromptEditInput,
  PromptEditResult,
  PromptSubmitInput,
  PromptSubmitResult,
  RenderEvent,
  SpawnChunk,
} from '../src/types.ts';
import { PLUGIN_VERSION } from '../src/types.ts';

export interface FakeDraft {
  text: string;
  cursor: number;
}

export interface FakeClaudeOptions {
  readonly files?: Record<string, string | Uint8Array>;
  readonly env?: Record<string, string>;
  readonly config?: readonly ConfigRow[];
  readonly hidePromptEdit?: boolean;
  readonly hideClassic?: boolean;
  readonly pluginRoot?: string;
}

function b64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : chars[(((b1 ?? 0) & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : chars[b2 & 63];
  }
  return out;
}

export function packedTable(
  pairs: readonly (readonly [string, string])[] = [
    ['teh', 'the'],
    ['adn', 'and'],
  ],
): Uint8Array {
  return encodeTable(pairs);
}

export function payloadFiles(pairs?: readonly (readonly [string, string])[]): Record<string, string | Uint8Array> {
  const table = packedTable(pairs);
  return {
    '/data/murmo/package/integrity.json': JSON.stringify({
      version: PLUGIN_VERSION,
      files: [{ path: 'data/en/english.bin', sha256: 'test', size: table.byteLength, mode: 420 }],
    }),
    '/data/murmo/package/data/en/english.bin': table,
    '/data/murmo/package/data/en/case-policy.json': JSON.stringify({ lowercaseOnly: [] }),
  };
}

export class FakeClaude {
  draft: FakeDraft = { text: '', cursor: 0 };
  readonly sent: string[] = [];
  readonly blocked: string[] = [];
  readonly files: Map<string, string | Uint8Array>;
  readonly env: Record<string, string>;
  /** Every `$.ui.invalidate` call: Claude redraws PromptHint only on one. */
  readonly invalidated: string[] = [];
  /** Every `$.prompt.suggest` text; Claude shows one only in an empty box. */
  readonly suggested: string[] = [];
  readonly hooks = new Map<string, { options?: object; handler: (...args: never[]) => unknown }[]>();
  hint = 'Esc to clear · ';
  working = false;
  readonly $: ClaudeRuntime;
  readonly on: ClaudeRegister;

  constructor(options: FakeClaudeOptions = {}) {
    this.files = new Map(Object.entries({ ...payloadFiles(), ...options.files }));
    this.env = {
      HOME: '/home',
      XDG_DATA_HOME: '/data',
      XDG_CONFIG_HOME: '/config',
      TMPDIR: '/tmp',
      ...options.env,
    };
    const self = this;
    const config = options.config ?? [];
    this.$ = {
      plugin: { root: options.pluginRoot ?? '/plugin' },
      env: {
        async get(name) {
          return self.env[name];
        },
      },
      fs: {
        async read(path, opts) {
          const value = self.files.get(path);
          if (value === undefined) throw new Error(`missing ${path}`);
          if (opts?.as === 'bytes') {
            const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
            return { base64: b64(bytes) } satisfies FsBytes;
          }
          return typeof value === 'string' ? value : new TextDecoder().decode(value);
        },
        async write(path, content) {
          self.files.set(path, content);
        },
        async exists(path) {
          return self.files.has(path);
        },
      },
      session: {
        async cwd() {
          return '/project';
        },
      },
      prompt: {
        async read() {
          return { text: self.draft.text, cursor: self.draft.cursor };
        },
        async fill(request) {
          self.draft = { text: request.text, cursor: request.text.length };
          return { text: self.draft.text, cursor: self.draft.cursor, isFilled: true } satisfies FillResult;
        },
        async suggest(request) {
          self.suggested.push(request.text);
          return { isShown: self.draft.text === '' };
        },
      },
      clock: {
        after(ms, callback) {
          const id = setTimeout(callback, ms);
          return { cancel: () => clearTimeout(id) } satisfies ClockHandle;
        },
        every(ms, callback) {
          const id = setInterval(callback, ms);
          return { cancel: () => clearInterval(id) };
        },
        sleep(ms) {
          return new Promise((resolve) => setTimeout(resolve, ms));
        },
      },
      process: {
        spawn() {
          const empty: SpawnChunk[] = [];
          return {
            async *[Symbol.asyncIterator]() {
              yield* empty;
            },
          };
        },
      },
      http: {
        async fetch() {
          return { text: JSON.stringify({ status: 'ok' }) };
        },
      },
      config: {
        async list() {
          return config;
        },
      },
      ui: {
        invalidate: (name: string) => {
          this.invalidated.push(name);
        },
        resolve() {
          return {
            Box: (props: Record<string, unknown>) => ({ type: 'Box', props }),
            Text: (props: Record<string, unknown>) => ({ type: 'Text', props }),
          };
        },
      },
    };
    const add = (name: string, options: object | undefined, handler: (...args: never[]) => unknown) => {
      const list = this.hooks.get(name) ?? [];
      list.push({ ...(options ? { options } : {}), handler });
      this.hooks.set(name, list);
    };
    this.on = ((name: string, a: unknown, b?: unknown) => {
      if (typeof a === 'function') add(name, undefined, a as (...args: never[]) => unknown);
      else add(name, a as object, b as (...args: never[]) => unknown);
    }) as ClaudeRegister;
  }

  apply(event: PromptEditInput): PromptEditResult {
    const text = event.text.slice(0, event.start) + event.inputText + event.text.slice(event.end);
    const cursor = event.start + event.inputText.length;
    this.draft = { text, cursor };
    return { text, cursor };
  }

  keyEvent(inputText: string, keyName: string): PromptEditInput {
    const start = this.draft.cursor;
    return {
      origin: { kind: 'composer' },
      key: { key: keyName },
      text: this.draft.text,
      cursor: this.draft.cursor,
      start,
      end: start,
      inputText,
    };
  }

  backspaceEvent(): PromptEditInput {
    const cursor = this.draft.cursor;
    const start = Math.max(0, cursor - 1);
    return {
      origin: { kind: 'composer' },
      key: { key: 'backspace' },
      text: this.draft.text,
      cursor,
      start,
      end: cursor,
      inputText: '',
    };
  }

  keylessEvent(insert: string): PromptEditInput {
    const start = this.draft.cursor;
    return {
      origin: { kind: 'composer' },
      text: this.draft.text,
      cursor: this.draft.cursor,
      start,
      end: start,
      inputText: insert,
    };
  }

  changeEvent(kind: string, box: PromptBox): PromptChangeInput {
    return { ...box, origin: { kind } };
  }

  hintEvent(): RenderEvent {
    return { component: 'PromptHint', props: { hint: this.hint, isWorking: this.working, isDraft: false } };
  }
}

export type NativeApply = (event: PromptEditInput) => PromptEditResult;

export const nativeApply =
  (fake: FakeClaude): NativeApply =>
  (event) =>
    fake.apply(event);

export async function typeChars(
  handle: (event: PromptEditInput, next: NativeApply) => Promise<PromptEditResult>,
  fake: FakeClaude,
  text: string,
): Promise<void> {
  for (const char of text) {
    if (char === '\n') continue;
    const event = char === ' ' ? fake.keyEvent(' ', 'space') : fake.keyEvent(char, char);
    const result = await handle(event, nativeApply(fake));
    fake.draft = { text: result.text, cursor: result.cursor };
  }
}

export async function paste(
  handle: (event: PromptEditInput, next: NativeApply) => Promise<PromptEditResult>,
  fake: FakeClaude,
  text: string,
): Promise<void> {
  const result = await handle(fake.keylessEvent(text), nativeApply(fake));
  fake.draft = { text: result.text, cursor: result.cursor };
}

export async function backspace(
  handle: (event: PromptEditInput, next: NativeApply) => Promise<PromptEditResult>,
  fake: FakeClaude,
  times = 1,
): Promise<void> {
  for (let i = 0; i < times; i++) {
    const result = await handle(fake.backspaceEvent(), nativeApply(fake));
    fake.draft = { text: result.text, cursor: result.cursor };
  }
}

export function submitNext(fake: FakeClaude): (event: PromptSubmitInput) => PromptSubmitResult {
  return (event) => {
    fake.sent.push(event.text);
    fake.draft = { text: '', cursor: 0 };
    return {};
  };
}

export function classicNext(fake: FakeClaude): (event: ClassicSubmitInput) => ClassicSubmitResult {
  return (event) => {
    fake.sent.push(event.prompt);
    return {};
  };
}

/** `bootPacked` services with real timers and no helper process. */
export function liveServices(): HostServices {
  return {
    after(ms, callback) {
      const id = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(id) };
    },
    spawn() {
      return {
        async *[Symbol.asyncIterator]() {},
      };
    },
    async fetch() {
      return { text: JSON.stringify({ status: 'error', error: 'no helper' }) };
    },
    repaint() {},
    async suggest() {
      return { isShown: false };
    },
  };
}

export function autocompleteNext(): (event: AutocompleteInput) => AutocompleteResult {
  return () => ({ suggestions: [] });
}
