// Pi parseKey / keybinding names → Murmo canonical KeyIds. Named keys stay
// Title-case; modifiers are Ctrl+ / Alt+ / Shift+ in that order.

import { isCanonicalKey, type KeyId } from '@murmo/api';
import type { PiEditor, PiKeybindings } from './types.ts';

const NAMED: Readonly<Record<string, KeyId>> = {
  tab: 'Tab',
  enter: 'Enter',
  return: 'Enter',
  escape: 'Escape',
  esc: 'Escape',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  backspace: 'Backspace',
  space: 'space',
  f1: 'F1',
  f2: 'F2',
  f3: 'F3',
  f4: 'F4',
  f5: 'F5',
  f6: 'F6',
  f7: 'F7',
  f8: 'F8',
  f9: 'F9',
  f10: 'F10',
  f11: 'F11',
  f12: 'F12',
};

const MOD_ORDER = ['ctrl', 'alt', 'shift'] as const;

export type PiKeyKind = 'key' | 'newline' | 'undo' | 'submit' | 'queue';

export interface DecodedKey {
  readonly id: KeyId;
  readonly kind: PiKeyKind;
  readonly raw: string;
}

function titleNamed(name: string): string {
  if (name === 'space') return 'space';
  if (name.length === 1) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `ctrl+alt+shift+tab` → `Ctrl+Alt+Shift+Tab`. */
export function fromPiKeyId(name: string): KeyId {
  const parts = name.split('+');
  const base = parts[parts.length - 1] ?? name;
  const used = new Set(parts.slice(0, -1).map((p) => p.toLowerCase()));
  const named = NAMED[base] ?? (base.length === 1 ? base : titleNamed(base));
  const prefix = MOD_ORDER.filter((m) => used.has(m))
    .map((m) => m.charAt(0).toUpperCase() + m.slice(1))
    .join('+');
  const id = prefix ? `${prefix}+${named}` : named;
  return isCanonicalKey(id) ? id : named;
}

export function cursorOffset(editor: PiEditor): number {
  const cursor = editor.getCursor();
  return (
    editor
      .getLines()
      .slice(0, cursor.line)
      .reduce((n, line) => n + line.length + 1, 0) + cursor.col
  );
}

export function offsetToPosition(text: string, offset: number): { line: number; col: number } {
  const clamped = Math.max(0, Math.min(text.length, offset));
  const lines = text.slice(0, clamped).split('\n');
  const last = lines[lines.length - 1] ?? '';
  return { line: lines.length - 1, col: last.length };
}

function lineBeforeCursor(editor: PiEditor): string {
  const cursor = editor.getCursor();
  const line = editor.getLines()[cursor.line] ?? '';
  return line.slice(0, cursor.col);
}

export function decodeKey(
  data: string,
  parseKey: (raw: string) => string | undefined,
  bindings: PiKeybindings | undefined,
  editor: PiEditor | undefined,
): DecodedKey {
  if (bindings?.matches(data, 'app.message.followUp')) return { id: 'Queue', kind: 'queue', raw: data };
  if (bindings?.matches(data, 'tui.input.newLine') || data === '\n') {
    return { id: 'Enter', kind: 'newline', raw: data };
  }
  if (editor && bindings?.matches(data, 'tui.input.submit') && !bindings.matches(data, 'tui.input.newLine')) {
    const before = lineBeforeCursor(editor);
    if (before.endsWith('\\')) return { id: 'Enter', kind: 'newline', raw: data };
  }
  if (bindings?.matches(data, 'tui.editor.undo') || data === '\x1f') return { id: 'Undo', kind: 'undo', raw: data };
  if (bindings?.matches(data, 'tui.input.submit') || data === '\r') return { id: 'Enter', kind: 'submit', raw: data };
  const parsed = parseKey(data);
  if (parsed === 'f6') return { id: 'F6', kind: 'key', raw: data };
  if (parsed) {
    const id = fromPiKeyId(parsed);
    return { id, kind: 'key', raw: data };
  }
  if (data.length === 1 && data !== '\x7f' && isPrintableRaw(data)) {
    return { id: data === ' ' ? 'space' : data, kind: 'key', raw: data };
  }
  return { id: data, kind: 'key', raw: data };
}

export function isPrintableRaw(data: string): boolean {
  if (data.length === 0) return false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return false;
  }
  return true;
}

export function stripPasteMarkers(data: string): string {
  let text = data;
  if (text.startsWith('\x1b[200~')) text = text.slice('\x1b[200~'.length);
  if (text.endsWith('\x1b[201~')) text = text.slice(0, -'\x1b[201~'.length);
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
}

export function isBracketedPaste(data: string): boolean {
  return data.includes('\x1b[200~') || data.includes('\x1b[201~');
}
