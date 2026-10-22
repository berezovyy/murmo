// Word tokens for history search. NFC, lowercase, AND over word prefixes,
// including code-like `_ / . :` tokens (r9, E3). Unique per string.

const TOKEN = /[\p{L}\p{N}_./:-]+/gu;

export function tokens(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const nfc = text.normalize('NFC').toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  for (const match of nfc.matchAll(TOKEN)) {
    const token = match[0];
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function isWordByte(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 46 || c === 47 || c === 58 || c === 45;
}
