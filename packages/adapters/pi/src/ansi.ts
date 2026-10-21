// Strip and measure terminal sequences so a ghost cannot grow a row past
// `width` (lesson 3). OSC/APC payloads must not reach the TUI as controls.

const ESC = 0x1b;
const BEL = 0x07;

function skipSequence(text: string, at: number): number {
  if (text.charCodeAt(at) !== ESC || at + 1 >= text.length) return at;
  const next = text.charCodeAt(at + 1);
  if (next === 0x5b) {
    let i = at + 2;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1;
      i++;
    }
    return text.length;
  }
  if (next === 0x5d || next === 0x5f) {
    let i = at + 2;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      if (c === BEL) return i + 1;
      if (c === ESC && text.charCodeAt(i + 1) === 0x5c) return i + 2;
      i++;
    }
    return text.length;
  }
  if (next === 0x28 || next === 0x29) return Math.min(text.length, at + 3);
  return at + 2;
}

export function stripSequences(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) === ESC) {
      i = skipSequence(text, i);
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

export function visibleWidth(text: string, measure?: (value: string) => number): number {
  const plain = stripSequences(text);
  if (measure) return measure(plain);
  let cells = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0;
    cells += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? 0 : code > 0xff && wide(code) ? 2 : 1;
  }
  return cells;
}

function wide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff)
  );
}

/** Longest prefix of `text` whose visible width is ≤ `width`. Sequences stay attached to the text they wrap. */
export function clipVisible(text: string, width: number, measure?: (value: string) => number): string {
  if (visibleWidth(text, measure) <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (visibleWidth(text.slice(0, mid), measure) <= width) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}
