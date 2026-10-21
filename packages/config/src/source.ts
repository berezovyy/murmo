// Source-level work on a TOML file before and after the parser runs: line
// ending normalization, the pre-parse nesting bound, and the key locator that
// gives validation diagnostics their `line:col`. One linear scanner serves
// both, and the Rust twin (rust/src/source.rs) ports it line for line, so JS
// and Rust report the same positions for the same file.
import type { Position } from './diagnostics.ts';
import { CONFIG_LIMITS } from './limits.ts';

/**
 * Strips one leading BOM and turns CRLF into LF. Parsers disagree on CRLF inside
 * multi-line strings until the source is normalized (r8 § 53, lesson 27).
 */
export function normalizeToml(text: string): string {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return body.includes('\r\n') ? body.replace(/\r\n/g, '\n') : body;
}

/** UTF-8 byte length without allocating (TextEncoder is missing in QuickJS). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** The first `max` code points of `text`, with `…` when it was cut. */
export function clipCodePoints(text: string, max: number): string {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (count === max) return `${text.slice(0, i)}\u{2026}`;
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return text;
}

/** The source line `line` (1-based), cut for a diagnostic excerpt. */
export function excerptAt(source: string, line: number): string | undefined {
  let start = 0;
  for (let n = 1; n < line; n++) {
    const end = source.indexOf('\n', start);
    if (end < 0) return undefined;
    start = end + 1;
  }
  const end = source.indexOf('\n', start);
  const text = end < 0 ? source.slice(start) : source.slice(start, end);
  return clipCodePoints(text, CONFIG_LIMITS.excerptCodePoints);
}

/**
 * The position a parser reported, made comparable across parsers: columns are
 * counted in code points, and an error at the very end of a file that ends
 * with a newline is reported on the last line that has content (smol-toml says
 * "line 4" where Rust `toml` says "line 3" for an unclosed inline table, r8).
 */
export function parserPosition(source: string, line: number, utf16Column: number): Position {
  const lines = source.split('\n');
  if (line > 1 && line === lines.length && lines[line - 1] === '') {
    const previous = lines[line - 2] ?? '';
    return { line: line - 1, column: codePointLength(previous) + 1 };
  }
  const text = lines[line - 1] ?? '';
  return { line, column: codePointLength(text.slice(0, Math.max(0, utf16Column - 1))) + 1 };
}

// ---------------------------------------------------------------------------
// The scanner

/** Where a key or table header was written: enough to compute its position later. */
interface Mark {
  readonly line: number;
  readonly lineIndex: number;
  readonly index: number;
}

const CH = {
  NEWLINE: 0x0a,
  SPACE: 0x20,
  TAB: 0x09,
  HASH: 0x23,
  QUOTE: 0x22,
  APOSTROPHE: 0x27,
  OPEN_BRACKET: 0x5b,
  CLOSE_BRACKET: 0x5d,
  OPEN_BRACE: 0x7b,
  CLOSE_BRACE: 0x7d,
  BACKSLASH: 0x5c,
  DOT: 0x2e,
  EQUALS: 0x3d,
} as const;

function isBareKeyUnit(unit: number): boolean {
  return (
    (unit >= 0x30 && unit <= 0x39) ||
    (unit >= 0x41 && unit <= 0x5a) ||
    (unit >= 0x61 && unit <= 0x7a) ||
    unit === 0x5f ||
    unit === 0x2d
  );
}

/** Index just past the string that starts at `i` (a quote), or the end of its line when unterminated. */
function skipString(source: string, i: number): number {
  const quote = source.charCodeAt(i);
  const triple = source.charCodeAt(i + 1) === quote && source.charCodeAt(i + 2) === quote;
  const escapes = quote === CH.QUOTE;
  if (triple) {
    let j = i + 3;
    while (j < source.length) {
      const unit = source.charCodeAt(j);
      if (escapes && unit === CH.BACKSLASH) {
        j += 2;
        continue;
      }
      if (unit === quote && source.charCodeAt(j + 1) === quote && source.charCodeAt(j + 2) === quote) {
        j += 3;
        // Up to two more quotes belong to the content (`""""` ends with one quote).
        for (let extra = 0; extra < 2 && source.charCodeAt(j) === quote; extra++) j++;
        return j;
      }
      j++;
    }
    return source.length;
  }
  let j = i + 1;
  while (j < source.length) {
    const unit = source.charCodeAt(j);
    if (unit === CH.NEWLINE) return j;
    if (escapes && unit === CH.BACKSLASH) {
      j += 2;
      continue;
    }
    if (unit === quote) return j + 1;
    j++;
  }
  return source.length;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\u001b',
  '"': '"',
  '\\': '\\',
};

/** Decodes a basic-string key's escapes; an invalid escape keeps its raw text. */
function decodeBasic(raw: string): string {
  if (!raw.includes('\\')) return raw;
  return raw.replace(/\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|(.))/gsu, (whole, u, big, x, c) => {
    const hex = (u ?? big ?? x) as string | undefined;
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      return code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return SIMPLE_ESCAPES[c as string] ?? whole;
  });
}

function skipBlank(source: string, i: number): number {
  let j = i;
  while (j < source.length) {
    const unit = source.charCodeAt(j);
    if (unit !== CH.SPACE && unit !== CH.TAB) break;
    j++;
  }
  return j;
}

/** A dotted key starting at `i`, or undefined when no key starts there. */
function readKeyPath(source: string, i: number): { path: string[]; end: number } | undefined {
  const path: string[] = [];
  let j = i;
  for (;;) {
    j = skipBlank(source, j);
    const unit = source.charCodeAt(j);
    if (unit === CH.QUOTE || unit === CH.APOSTROPHE) {
      const end = skipString(source, j);
      if (source.charCodeAt(end - 1) !== unit || end - j < 2) return undefined;
      const raw = source.slice(j + 1, end - 1);
      path.push(unit === CH.QUOTE ? decodeBasic(raw) : raw);
      j = end;
    } else if (isBareKeyUnit(unit)) {
      const start = j;
      while (j < source.length && isBareKeyUnit(source.charCodeAt(j))) j++;
      path.push(source.slice(start, j));
    } else {
      return undefined;
    }
    j = skipBlank(source, j);
    if (source.charCodeAt(j) !== CH.DOT) return { path, end: j };
    j++;
  }
}

/** Finds where a key path was written, for validation diagnostics. */
export interface Locator {
  /** The key's position, else its nearest written ancestor's, else line 1. */
  locate(path: readonly string[]): Position;
}

export interface SourceScan {
  /** Where arrays and inline tables first nest past `CONFIG_LIMITS.nestingDepth`, or null. */
  readonly overflow: Position | null;
  readonly locator: Locator;
}

/**
 * One linear pass over the normalized source, before the parser runs. Strings
 * and comments are skipped; `[` and `{` inside values count toward the nesting
 * depth; a `[` at the start of a line outside any value is a table header; a
 * key followed by `=` at the start of a line is recorded with its full dotted
 * path. Positions are computed only when a diagnostic asks for one.
 */
export function scanSource(source: string): SourceScan {
  const marks = new Map<string, Mark>();
  let depth = 0;
  let lineStart = true;
  let line = 1;
  let lineIndex = 0;
  let table: string[] = [];
  const record = (path: readonly string[], index: number) => {
    const id = path.join('\u0000');
    if (!marks.has(id)) marks.set(id, { line, lineIndex, index });
  };
  // Strings may span lines; keep the line counters right after skipping one.
  const advance = (from: number, to: number) => {
    for (let k = source.indexOf('\n', from); k >= 0 && k < to; k = source.indexOf('\n', k + 1)) {
      line++;
      lineIndex = k + 1;
    }
  };
  const position = (mark: Mark): Position => ({
    line: mark.line,
    column: codePointLength(source.slice(mark.lineIndex, mark.index)) + 1,
  });
  const locator: Locator = {
    locate(path) {
      for (let n = path.length; n > 0; n--) {
        const mark = marks.get(path.slice(0, n).join('\u0000'));
        if (mark) return position(mark);
      }
      return { line: 1, column: 1 };
    },
  };

  let i = 0;
  while (i < source.length) {
    const unit = source.charCodeAt(i);
    if (unit === CH.NEWLINE) {
      line++;
      lineIndex = i + 1;
      lineStart = true;
      i++;
      continue;
    }
    if (unit === CH.SPACE || unit === CH.TAB) {
      i++;
      continue;
    }
    if (unit === CH.HASH) {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (lineStart && depth === 0) {
      lineStart = false;
      if (unit === CH.OPEN_BRACKET) {
        const array = source.charCodeAt(i + 1) === CH.OPEN_BRACKET;
        const header = readKeyPath(source, i + (array ? 2 : 1));
        if (header) {
          table = header.path;
          record(table, i);
        }
        // Skip to the closing bracket(s); the rest of the line scans as usual.
        let j = header ? header.end : i + 1;
        while (j < source.length && source.charCodeAt(j) !== CH.NEWLINE) {
          const c = source.charCodeAt(j);
          if (c === CH.QUOTE || c === CH.APOSTROPHE) {
            j = skipString(source, j);
            continue;
          }
          j++;
          if (c === CH.CLOSE_BRACKET) {
            if (array && source.charCodeAt(j) === CH.CLOSE_BRACKET) j++;
            break;
          }
        }
        i = j;
        continue;
      }
      const key = readKeyPath(source, i);
      if (key && source.charCodeAt(key.end) === CH.EQUALS) {
        record([...table, ...key.path], i);
        i = key.end + 1;
        continue;
      }
    }
    lineStart = false;
    if (unit === CH.QUOTE || unit === CH.APOSTROPHE) {
      const end = skipString(source, i);
      advance(i, end);
      i = end;
      continue;
    }
    if (unit === CH.OPEN_BRACKET || unit === CH.OPEN_BRACE) {
      depth++;
      if (depth > CONFIG_LIMITS.nestingDepth) {
        return { overflow: position({ line, lineIndex, index: i }), locator };
      }
    } else if ((unit === CH.CLOSE_BRACKET || unit === CH.CLOSE_BRACE) && depth > 0) {
      depth--;
    }
    i++;
  }
  return { overflow: null, locator };
}
