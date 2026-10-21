// Identifier word splitting from experiments/names/match/matcher.mjs.
// Protection uses it only to tell a whole identifier from a fragment
// (docs/plan/19: fragments are not protected). Phase 36 reuses the same split.

/**
 * NFC, Unicode case boundaries, digit runs stay attached, all-uppercase
 * plural `URLs` becomes `URL`, separator punctuation is dropped.
 */
export function splitWords(input: string): string[] {
  return input
    .normalize('NFC')
    .replace(/`/g, '')
    .replace(/\(\)$/, '')
    .replace(/([\p{Lu}]{2,})s(?=$|[^\p{L}\p{N}])/gu, '$1')
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, '$1 $2')
    .replace(/([\p{Ll}\p{Lo}\p{M}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}
