// Keys are data on the synchronous path: claims are declared once and evaluated
// by the core against cached state. No plugin code ever runs while a physical key
// waits for its answer (shared-v2 api.md § Keys).

/**
 * Named key IDs. Printable characters are their own ID (`a`, `;`, `?`), except
 * the space bar, which is `space`. Adapters normalize raw encodings (CSI, kitty,
 * tmux extended keys) to these IDs and resolve the host's newline key before
 * submit.
 */
export const NAMED_KEYS = [
  'space',
  'Tab',
  'Enter',
  'Backspace',
  'Escape',
  'Up',
  'Down',
  'Left',
  'Right',
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
] as const;

export type NamedKey = (typeof NAMED_KEYS)[number];

/** Modifier prefixes, in the only order an ID may use them: `Ctrl+Alt+Shift+Tab`. */
export const KEY_MODIFIERS = ['Ctrl', 'Alt', 'Shift'] as const;

/**
 * Keys the host or the user's muscle memory owns. A third-party plugin can't hold
 * an `always` claim that consumes one of these (lesson 77: a plugin with no
 * permissions grabbed another plugin's Tab).
 */
export const SHARED_KEYS = ['Tab', 'Enter', 'Escape', 'Up', 'Down', 'Left', 'Right'] as const;

/**
 * Claim conditions, a fixed vocabulary combined with AND. The six stay fixed for
 * the preview; new ones (e.g. `at-code-like-word`) come after v1 as a minor
 * release.
 *
 * - `always`: true.
 * - `editable`: prose mode, insert editor mode, not busy, no dialog, no popup,
 *   not history, certainty known.
 * - `ghost-visible-by-me`: the ghost on screen is this plugin's.
 * - `menu-open`: the merged menu shows rows at the current version.
 * - `at-word-start`: exactly `cursor === 0 || /\s/.test(text[cursor - 1])`;
 *   punctuation alone does not match, the selection is not inspected.
 * - `after-my-edit`: the latest undo record belongs to this plugin.
 */
export const KEY_CONDITIONS = [
  'always',
  'editable',
  'ghost-visible-by-me',
  'menu-open',
  'at-word-start',
  'after-my-edit',
] as const;

export type KeyCondition = (typeof KEY_CONDITIONS)[number];

/**
 * A canonical key ID (see `isCanonicalKey`). Typed as a string so plugins can
 * take keys from settings; the core refuses non-canonical IDs at load.
 */
export type KeyId = string;

/**
 * A declarative key claim. The first consuming claim in plugin order wins.
 * `accept-ghost` inserts exactly the visible ghost; `consume` swallows the key;
 * `dispatch` runs `onKey` asynchronously and lets the key through unless
 * `consume` is true. A claim that writes also needs `editable` and the key in
 * `Capabilities.keys`, whether or not it lists `editable`.
 *
 * An `always` claim on a shared key type-checks but is refused at load for
 * third-party plugins (and, per phase 06, for built-ins too).
 */
export type KeyClaim =
  | { readonly key: KeyId; readonly when: readonly KeyCondition[]; readonly action: 'accept-ghost' | 'consume' }
  | {
      readonly key: KeyId;
      readonly when: readonly KeyCondition[];
      readonly action: 'dispatch';
      /** Also consume the key; still subject to the shared-key rule. */
      readonly consume?: boolean;
    };

/** Logical actions an adapter can route from a configurable key or a host command. */
export const ACTIONS = ['murmo.undo', 'murmo.menu'] as const;

export type ActionId = (typeof ACTIONS)[number];

/**
 * Actions a plugin may declare. `murmo.undo` belongs to the core.
 * `murmo.menu` asks for this plugin's menu without guessing a free raw key
 * (lesson 72; the r14 linter's default F7 was absent on real hosts).
 */
export type PluginAction = Extract<ActionId, 'murmo.menu'>;

const named: ReadonlySet<string> = new Set(NAMED_KEYS);

/**
 * True when `id` follows the canonical grammar: optional `Ctrl+`, `Alt+`,
 * `Shift+` prefixes in that order, then a named key or one printable code point.
 * `Shift+` only combines with named keys (Shift+a is `A`); with `Ctrl+` or
 * `Alt+`, letters are lowercase (`Ctrl+x`, never `Ctrl+X`).
 */
export function isCanonicalKey(id: string): boolean {
  let rest = id;
  const used: string[] = [];
  for (const modifier of KEY_MODIFIERS) {
    if (rest.startsWith(`${modifier}+`) && rest.length > modifier.length + 1) {
      used.push(modifier);
      rest = rest.slice(modifier.length + 1);
    }
  }
  if (named.has(rest)) return true;
  if (!isPrintable(rest) || used.includes('Shift')) return false;
  return used.length === 0 || rest.toLowerCase() === rest;
}

function isPrintable(text: string): boolean {
  const points = Array.from(text);
  if (points.length !== 1) return false;
  // Only categories every engine agrees on: `Cn` (unassigned) depends on each
  // engine's Unicode version, so it is not used.
  return !/[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(text);
}
