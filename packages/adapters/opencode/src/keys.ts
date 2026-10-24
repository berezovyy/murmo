// Canonical key IDs and OpenCode keymap binding matching (r10 O1, r13 adapter).
// Super is not a Murmo modifier: configured undo chords become the logical `Undo`.

import { isCanonicalKey, type KeyId } from '@murmo/api';
import { graphemeBoundaries, unsafeText } from '@murmo/text';
import type { KeymapPending, OpenCodeKeymap, ParsedKey } from './types.ts';

const NAMED: Readonly<Record<string, KeyId>> = {
  tab: 'Tab',
  return: 'Enter',
  enter: 'Enter',
  kpenter: 'Enter',
  linefeed: 'Newline',
  escape: 'Escape',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  backspace: 'Backspace',
  delete: 'Delete',
  f6: 'F6',
  space: 'space',
};

function keyName(parsed: ParsedKey): string {
  const name = parsed.name.toLowerCase();
  return name === 'return' ? 'enter' : name;
}

function strokeParts(stroke: string): { readonly name: string; readonly mods: ReadonlySet<string> } {
  const parts = stroke.toLowerCase().split('+');
  const name = parts.pop() ?? '';
  return { name, mods: new Set(parts) };
}

function pendingMatches(prefix: readonly string[], pending: readonly KeymapPending[]): boolean {
  if (prefix.length !== pending.length) return false;
  return prefix.every((stroke, index) => {
    const got = pending[index];
    if (!got) return false;
    const want = stroke.toLowerCase();
    if (want === got.key.toLowerCase()) return true;
    return want.replace(/[<>]/g, '') === 'leader' && got.token === 'leader';
  });
}

/** True when `parsed` is the last stroke of a configured binding, with any multi-stroke prefix already pending. */
export function bindingMatches(keymap: OpenCodeKeymap, id: string, parsed: ParsedKey): boolean {
  let bindings: readonly string[] = [];
  try {
    bindings = keymap.shortcuts(id);
  } catch {
    return false;
  }
  const pending = keymap.pending();
  const parsedName = keyName(parsed);
  for (const binding of bindings) {
    const strokes = binding.toLowerCase().split(' ').filter(Boolean);
    const stroke = strokes.pop();
    if (!stroke) continue;
    if (!pendingMatches(strokes, pending)) continue;
    const { name, mods } = strokeParts(stroke);
    if (name !== parsedName) continue;
    if (!!parsed.ctrl !== mods.has('ctrl')) continue;
    if (!!parsed.shift !== mods.has('shift')) continue;
    if (!!parsed.super !== (mods.has('super') || mods.has('cmd'))) continue;
    if (!!(parsed.meta || parsed.option) !== (mods.has('alt') || mods.has('meta') || mods.has('option'))) continue;
    return true;
  }
  return false;
}

/**
 * Map an OpenTUI keypress to a Murmo `KeyId`. Configured undo becomes `Undo`;
 * a configured newline chord becomes `Newline`. Unrecognized non-ASCII bulk
 * input stays the sequence so the adapter can label it `unknown` (lesson 12).
 */
export function canonicalKey(parsed: ParsedKey, keymap: OpenCodeKeymap): KeyId {
  if (
    (parsed.ctrl || parsed.shift || parsed.meta || parsed.option || parsed.super) &&
    bindingMatches(keymap, 'input.newline', parsed)
  ) {
    return 'Newline';
  }
  if (bindingMatches(keymap, 'input.undo', parsed)) return 'Undo';
  if (parsed.shift && parsed.name.toLowerCase() === 'tab') return 'Shift+Tab';
  const name = keyName(parsed);
  if (parsed.ctrl) {
    const id = `Ctrl+${name}`;
    return isCanonicalKey(id) ? id : `Ctrl+${parsed.name}`;
  }
  if (parsed.super) return `Super+${name}`;
  const named = NAMED[name];
  if (named) return named;
  if (typeof parsed.sequence === 'string' && parsed.sequence.length > 0) return parsed.sequence;
  return parsed.name;
}

const CONTROL = /\p{Cc}/u;

/**
 * A key that types one printable character: any single grapheme (Cyrillic,
 * accents, CJK, emoji), never a chord, a control or escape sequence, a bidi
 * control or a multi-character chunk of bulk input.
 */
export function isPrintableTyped(parsed: ParsedKey): boolean {
  if (parsed.ctrl || parsed.meta || parsed.super || parsed.option) return false;
  const text = parsed.sequence;
  if (typeof text !== 'string' || text.length === 0 || CONTROL.test(text) || unsafeText(text) !== null) return false;
  return graphemeBoundaries(text).length === 2;
}

/** Single-stroke undo bindings that are already canonical Murmo IDs (custom keys). */
export function extraUndoKeys(keymap: OpenCodeKeymap): KeyId[] {
  let bindings: readonly string[] = [];
  try {
    bindings = keymap.shortcuts('input.undo');
  } catch {
    return [];
  }
  const extras: KeyId[] = [];
  for (const binding of bindings) {
    const strokes = binding.trim().split(/\s+/);
    if (strokes.length !== 1) continue;
    const stroke = strokes[0];
    if (!stroke) continue;
    const { name, mods } = strokeParts(stroke);
    if (mods.size > 0) continue;
    const named = NAMED[name];
    if (named && named !== 'Undo' && isCanonicalKey(named)) extras.push(named);
  }
  return extras;
}

export const PROBE_KEYS: readonly string[] = [
  'Tab',
  'Enter',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'Backspace',
  'Delete',
  'F6',
  'Ctrl+-',
  'Super+z',
  'Undo',
  'space',
  'Newline',
  'Queue',
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
];
