// packed-sorted-ascii-v1: the on-disk typo table (knowledge lesson 16). Packed
// bytes plus Uint32 offset views; nothing is parsed into JS objects, so a
// session maps the file in well under a millisecond and a lookup is a binary
// search over bytes (r13 E1: p99 2.3 µs in Node, 8.9 µs in native QuickJS).
//
// Layout, little-endian:
//   header   8 × u32: magic, entry count n, data offset (= 32 + 8(n+1)),
//            data length, then four reserved words that must be zero
//   keys     n+1 × u32 offsets into the data
//   values   n+1 × u32 offsets into the data
//   data     every key, then every value, ASCII, keys sorted by bytes
//
// The round-13 table (SHA-256 731f6d7c…) uses exactly this layout, so the
// header stays as it is: a later layout gets a new magic, and the reserved
// words being zero is what tells this one apart from packed.mjs's trie, score
// and block indexes (docs/plan/12, "Packed format").

export const TABLE_FORMAT = 'packed-sorted-ascii-v1';
/** "MRUM" read as a little-endian u32: 1297437261. */
export const TABLE_MAGIC = 0x4d55524d;
export const HEADER_BYTES = 32;
/** Keys are words the corrector looks up; 64 matches its token limit. */
export const MAX_KEY_BYTES = 64;
/** Values are inline insertions; 16 KiB is the inline rules' `maxInsertBytes` ceiling (docs/plan/07). */
export const MAX_VALUE_BYTES = 16384;

export type TableErrorCode =
  | 'unsupported-platform'
  | 'misaligned'
  | 'truncated'
  | 'unknown-format'
  | 'bad-header'
  | 'bad-offsets'
  | 'bad-entry'
  | 'unsorted'
  | 'bad-input';

export class TableError extends Error {
  readonly code: TableErrorCode;
  /** The entry the problem was found at, when it is about one entry. */
  readonly entry: number | undefined;
  constructor(code: TableErrorCode, message: string, entry?: number) {
    super(message);
    this.name = 'TableError';
    this.code = code;
    this.entry = entry;
  }
}

/** Views over one table's bytes. Nothing is copied: the views share the caller's buffer. */
export interface PackedTable {
  readonly entries: number;
  readonly byteLength: number;
  /** `n+1` offsets into `data`; key `i` is `data[keyOffsets[i] .. keyOffsets[i+1])`. */
  readonly keyOffsets: Uint32Array;
  readonly valueOffsets: Uint32Array;
  readonly data: Uint8Array;
}

// Uint32Array reads in the platform's byte order; every platform Murmo
// supports (arm64, x86_64) is little-endian, and this refuses any other.
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Wraps a table's bytes for lookup after checking only what is O(1): the
 * header, the overall offset ranges, alignment. Entry-by-entry validation is
 * `validateTable`'s job and runs at build and install, never at session start
 * (lesson 66: 1.7 s in QuickJS).
 */
export function mapTable(source: ArrayBuffer | Uint8Array): PackedTable {
  if (!littleEndian) throw new TableError('unsupported-platform', 'packed tables need a little-endian platform');
  const buffer = source instanceof Uint8Array ? source.buffer : source;
  const offset = source instanceof Uint8Array ? source.byteOffset : 0;
  const length = source.byteLength;
  if (!(buffer instanceof ArrayBuffer)) throw new TableError('bad-input', 'table bytes must be an ArrayBuffer');
  if (offset % 4 !== 0) throw new TableError('misaligned', 'table bytes must start at a 4-byte aligned offset');
  if (length < HEADER_BYTES + 8) throw new TableError('truncated', `table is ${length} bytes, shorter than any table`);
  const header = new Uint32Array(buffer, offset, 8);
  if (header[0] !== TABLE_MAGIC) {
    throw new TableError('unknown-format', `magic ${header[0]} is not ${TABLE_FORMAT} (${TABLE_MAGIC})`);
  }
  const n = header[1] as number;
  const dataOffset = HEADER_BYTES + 8 * (n + 1);
  if (header[4] !== 0 || header[5] !== 0 || header[6] !== 0 || header[7] !== 0) {
    throw new TableError('unknown-format', 'reserved header words are not zero (another packed layout?)');
  }
  if (header[2] !== dataOffset) throw new TableError('bad-header', `data offset ${header[2]} is not ${dataOffset}`);
  const dataLength = header[3] as number;
  if (dataOffset + dataLength !== length) {
    throw new TableError('bad-header', `header says ${dataOffset + dataLength} bytes, table has ${length}`);
  }
  const keyOffsets = new Uint32Array(buffer, offset + HEADER_BYTES, n + 1);
  const valueOffsets = new Uint32Array(buffer, offset + HEADER_BYTES + 4 * (n + 1), n + 1);
  // Keys come first, values follow, and the last value ends the data.
  if (keyOffsets[0] !== 0 || keyOffsets[n] !== valueOffsets[0] || valueOffsets[n] !== dataLength) {
    throw new TableError('bad-offsets', 'key and value offsets do not span the data');
  }
  return Object.freeze({
    entries: n,
    byteLength: length,
    keyOffsets,
    valueOffsets,
    data: new Uint8Array(buffer, offset + dataOffset, dataLength),
  });
}

/** What full validation found: the counts a validation receipt records. */
export interface TableCheck {
  readonly entries: number;
  readonly keyBytes: number;
  readonly valueBytes: number;
}

const isKeyByte = (b: number) => b > 0x20 && b < 0x7f;
const isValueByte = (b: number) => b >= 0x20 && b < 0x7f;

/**
 * Every entry: offsets ascending and inside their area, key 1–64 printable ASCII bytes
 * without spaces, value 1–16 KiB printable ASCII, keys strictly ascending by
 * bytes (so binary search finds every key and there are no duplicates).
 */
export function validateTable(table: PackedTable): TableCheck {
  const { entries: n, keyOffsets: ko, valueOffsets: vo, data } = table;
  const keysEnd = ko[n] as number;
  let prevStart = 0;
  let prevEnd = 0;
  for (let i = 0; i < n; i++) {
    const start = ko[i] as number;
    const end = ko[i + 1] as number;
    const vStart = vo[i] as number;
    const vEnd = vo[i + 1] as number;
    // Offsets ascend through the key area, then the value area (mapTable checked both ends).
    if (end > keysEnd || vEnd > data.length) {
      throw new TableError('bad-offsets', `entry ${i}: offset past the end of its area`, i);
    }
    if (end < start || end - start < 1 || end - start > MAX_KEY_BYTES) {
      throw new TableError('bad-offsets', `entry ${i}: key length ${end - start} is outside 1..${MAX_KEY_BYTES}`, i);
    }
    if (vEnd < vStart || vEnd - vStart < 1 || vEnd - vStart > MAX_VALUE_BYTES) {
      throw new TableError(
        'bad-offsets',
        `entry ${i}: value length ${vEnd - vStart} is outside 1..${MAX_VALUE_BYTES}`,
        i,
      );
    }
    for (let a = start; a < end; a++) {
      if (!isKeyByte(data[a] as number)) throw new TableError('bad-entry', `entry ${i}: key byte ${data[a]}`, i);
    }
    for (let a = vStart; a < vEnd; a++) {
      if (!isValueByte(data[a] as number)) throw new TableError('bad-entry', `entry ${i}: value byte ${data[a]}`, i);
    }
    if (i > 0 && compareRanges(data, prevStart, prevEnd, start, end) >= 0) {
      throw new TableError('unsorted', `entry ${i}: key is not after entry ${i - 1}'s key`, i);
    }
    prevStart = start;
    prevEnd = end;
  }
  return { entries: n, keyBytes: ko[n] as number, valueBytes: (vo[n] as number) - (vo[0] as number) };
}

function compareRanges(data: Uint8Array, aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  for (let a = aStart, b = bStart; a < aEnd && b < bEnd; a++, b++) {
    const d = (data[a] as number) - (data[b] as number);
    if (d !== 0) return d;
  }
  return aEnd - aStart - (bEnd - bStart);
}

/**
 * Binary search for `word`; -1 when absent. Compares UTF-16 code units with
 * the ASCII bytes in place: no encoding, no allocation on the key path. A word
 * with a non-ASCII character simply never matches.
 */
export function findEntry(table: PackedTable, word: string): number {
  const { keyOffsets: ko, data } = table;
  let lo = 0;
  let hi = table.entries;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    let a = ko[mid] as number;
    const end = ko[mid + 1] as number;
    let i = 0;
    let c = 0;
    for (; a < end && i < word.length; a++, i++) {
      c = (data[a] as number) - word.charCodeAt(i);
      if (c !== 0) break;
    }
    if (c === 0) c = end - a - (word.length - i);
    if (c === 0) return mid;
    if (c < 0) lo = mid + 1;
    else hi = mid;
  }
  return -1;
}

/** The value for `word`, or undefined. */
export function lookup(table: PackedTable, word: string): string | undefined {
  const i = findEntry(table, word);
  return i < 0 ? undefined : valueAt(table, i);
}

export function keyAt(table: PackedTable, i: number): string {
  return ascii(table.data, table.keyOffsets[i] as number, table.keyOffsets[i + 1] as number);
}

export function valueAt(table: PackedTable, i: number): string {
  return ascii(table.data, table.valueOffsets[i] as number, table.valueOffsets[i + 1] as number);
}

function ascii(data: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let a = start; a < end; a++) s += String.fromCharCode(data[a] as number);
  return s;
}

/**
 * Writes a table. Entries are sorted by key bytes; a duplicate key, an empty
 * or over-long key or value, or a non-ASCII character is refused, so every
 * table this writes passes `validateTable`.
 */
export function encodeTable(entries: Iterable<readonly [string, string]>): Uint8Array {
  const rows = [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  let keyBytes = 0;
  let valueBytes = 0;
  for (let i = 0; i < rows.length; i++) {
    const [key, value] = rows[i] as readonly [string, string];
    checkText(key, 'key', isKeyByte, MAX_KEY_BYTES);
    checkText(value, `value of "${key}"`, isValueByte, MAX_VALUE_BYTES);
    if (i > 0 && (rows[i - 1] as readonly [string, string])[0] === key) {
      throw new TableError('bad-input', `duplicate key "${key}"`);
    }
    keyBytes += key.length;
    valueBytes += value.length;
  }
  const n = rows.length;
  const dataOffset = HEADER_BYTES + 8 * (n + 1);
  const out = new Uint8Array(dataOffset + keyBytes + valueBytes);
  const view = new DataView(out.buffer);
  const words = [TABLE_MAGIC, n, dataOffset, keyBytes + valueBytes, 0, 0, 0, 0];
  words.forEach((w, i) => {
    view.setUint32(i * 4, w, true);
  });
  let at = 0;
  for (let i = 0; i < n; i++) {
    view.setUint32(HEADER_BYTES + 4 * i, at, true);
    at = put(out, dataOffset + at, (rows[i] as readonly [string, string])[0]) - dataOffset;
  }
  view.setUint32(HEADER_BYTES + 4 * n, at, true);
  const values = HEADER_BYTES + 4 * (n + 1);
  for (let i = 0; i < n; i++) {
    view.setUint32(values + 4 * i, at, true);
    at = put(out, dataOffset + at, (rows[i] as readonly [string, string])[1]) - dataOffset;
  }
  view.setUint32(values + 4 * n, at, true);
  return out;
}

function checkText(text: string, what: string, allowed: (b: number) => boolean, max: number): void {
  if (text.length < 1 || text.length > max) throw new TableError('bad-input', `${what} length ${text.length}`);
  for (let i = 0; i < text.length; i++) {
    if (!allowed(text.charCodeAt(i))) throw new TableError('bad-input', `${what} has character ${text.charCodeAt(i)}`);
  }
}

function put(out: Uint8Array, at: number, text: string): number {
  for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  return at + text.length;
}
