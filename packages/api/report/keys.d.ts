/**
 * Named key IDs. Printable characters are their own ID (`a`, `;`, `?`), except
 * the space bar, which is `space`. Adapters normalize raw encodings (CSI, kitty,
 * tmux extended keys) to these IDs and resolve the host's newline key before
 * submit.
 */
export declare const NAMED_KEYS: readonly ['space', 'Tab', 'Enter', 'Backspace', 'Escape', 'Up', 'Down', 'Left', 'Right', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
export type NamedKey = (typeof NAMED_KEYS)[number];
/** Modifier prefixes, in the only order an ID may use them: `Ctrl+Alt+Shift+Tab`. */
export declare const KEY_MODIFIERS: readonly ['Ctrl', 'Alt', 'Shift'];
/**
 * Keys the host or the user's muscle memory owns. A third-party plugin can't hold
 * an `always` claim that consumes one of these (lesson 77: a plugin with no
 * permissions grabbed another plugin's Tab).
 */
export declare const SHARED_KEYS: readonly ['Tab', 'Enter', 'Escape', 'Up', 'Down', 'Left', 'Right'];
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
export declare const KEY_CONDITIONS: readonly ['always', 'editable', 'ghost-visible-by-me', 'menu-open', 'at-word-start', 'after-my-edit'];
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
export type KeyClaim = {
    readonly key: KeyId;
    readonly when: readonly KeyCondition[];
    readonly action: 'accept-ghost' | 'consume';
} | {
    readonly key: KeyId;
    readonly when: readonly KeyCondition[];
    readonly action: 'dispatch';
    /** Also consume the key; still subject to the shared-key rule. */
    readonly consume?: boolean;
};
/** Logical actions an adapter can route from a configurable key or a host command. */
export declare const ACTIONS: readonly ['murmo.undo', 'murmo.menu'];
export type ActionId = (typeof ACTIONS)[number];
/**
 * Actions a plugin may declare. `murmo.undo` belongs to the core.
 * `murmo.menu` asks for this plugin's menu without guessing a free raw key
 * (lesson 72; the r14 linter's default F7 was absent on real hosts).
 */
export type PluginAction = Extract<ActionId, 'murmo.menu'>;
/**
 * True when `id` follows the canonical grammar: optional `Ctrl+`, `Alt+`,
 * `Shift+` prefixes in that order, then a named key or one printable code point.
 * `Shift+` only combines with named keys (Shift+a is `A`); with `Ctrl+` or
 * `Alt+`, letters are lowercase (`Ctrl+x`, never `Ctrl+X`).
 */
export declare function isCanonicalKey(id: string): boolean;
