// The corrector's lookup key (docs/plan/19): lowercase ASCII [a-z]{2,64}.
// One function, used by @murmo/vocab and @murmo/plugin-autocorrect, so a
// raw-vs-lowercase mismatch cannot miss a collision again (r6).

/** Bump when the key function changes; part of the protection cache key. */
export const NORMALIZE_VERSION = 1;

export const MIN_KEY_LENGTH = 2;
export const MAX_KEY_LENGTH = 64;

/**
 * Lowercase ASCII `[a-z]{2,64}`, or null. Title-case `Teh` becomes `teh`;
 * camelCase, digits, `_`, paths and non-ASCII never match the corrector.
 */
export function normalizeKey(token: string): string | null {
  if (token.length < MIN_KEY_LENGTH || token.length > MAX_KEY_LENGTH) return null;
  let out = '';
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) out += String.fromCharCode(c + 32);
    else if (c >= 0x61 && c <= 0x7a) out += token[i] as string;
    else return null;
  }
  return out;
}
