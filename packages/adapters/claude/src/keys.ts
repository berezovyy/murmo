import { isCanonicalKey, type KeyId } from '@murmo/api';
import type { ClaudeKeyEvent, PromptEditInput } from './types.ts';

const NAMED: Readonly<Record<string, KeyId>> = {
  space: 'space',
  backspace: 'Backspace',
  return: 'Enter',
  enter: 'Enter',
  escape: 'Escape',
  left: 'Left',
  right: 'Right',
  up: 'Up',
  down: 'Down',
  tab: 'Tab',
};

/** Claude's `ClientKeyEvent.key` to a canonical Murmo key id, or null if unusable. */
export function canonicalKey(event: ClaudeKeyEvent | undefined): KeyId | null {
  if (!event || event.ctrl || event.alt || event.meta) return null;
  const raw = event.key;
  const named = NAMED[raw];
  if (named) return named;
  if (raw === ' ') return 'space';
  if (isCanonicalKey(raw)) return raw;
  return null;
}

export function isKeyedSingle(event: PromptEditInput, key: KeyId | null): boolean {
  if (!key || !event.key) return false;
  if (event.key.ctrl || event.key.alt || event.key.meta) return false;
  return true;
}

export function observedKeys(): KeyId[] {
  const printable: KeyId[] = [];
  for (let code = 33; code <= 126; code++) {
    const ch = String.fromCharCode(code);
    if (isCanonicalKey(ch)) printable.push(ch);
  }
  return ['space', 'Backspace', ...printable];
}
