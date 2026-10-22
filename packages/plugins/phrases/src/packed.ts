// Scored packed index: sorted keys, values, uint32 scores, 256-entry block
// top-5 summaries. Layout matches experiments/vocab/lib.mjs (E1, E30). No
// Buffer, TextEncoder or Node APIs.

import { utf8Decode, utf8Encode } from '@murmo/store';

const MAGIC = 0x4d55524d;
const HEADER_INTS = 8;
const HEADER_BYTES = HEADER_INTS * 4;
const BLOCK = 256;
const TOP = 5;
const MISSING = 0xffffffff;

export const PHRASES_FORMAT = 'murmo-phrases-v1';

export interface PackedIndex {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly n: number;
  readonly blockSize: number;
  readonly blob: Uint8Array;
  readonly offsets: Uint32Array;
  readonly scores: Uint32Array;
}

export interface PackedRow {
  readonly key: string;
  readonly value: string;
  readonly score: number;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  viewOf(bytes).setUint32(offset, value >>> 0, true);
}

function alignedCopy(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset % 4 === 0) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function cmpKey(index: PackedIndex, id: number, query: Uint8Array, prefix: boolean): number {
  const start = index.offsets[id] as number;
  const end = index.offsets[id + 1] as number;
  const a = index.blob.subarray(start, end);
  const len = Math.min(a.length, query.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] as number) - (query[i] as number);
    if (d !== 0) return d;
  }
  if (prefix && len === query.length) return 0;
  return a.length - query.length;
}

function bound(index: PackedIndex, query: Uint8Array, lo: number, hi: number, upper: boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = cmpKey(index, mid, query, true);
    if (c < 0 || (upper && c === 0)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function scoreAt(index: PackedIndex, id: number): number {
  return index.scores[id] ?? 0;
}

function insertTop(top: number[], index: PackedIndex, id: number): void {
  let at = 0;
  while (
    at < top.length &&
    (scoreAt(index, top[at] as number) > scoreAt(index, id) ||
      (scoreAt(index, top[at] as number) === scoreAt(index, id) && (top[at] as number) < id))
  ) {
    at++;
  }
  if (at < TOP) {
    top.splice(at, 0, id);
    if (top.length > TOP) top.pop();
  }
}

function topRange(index: PackedIndex, lo: number, hi: number): number[] {
  const top: number[] = [];
  const size = index.blockSize;
  const n = index.n;
  if (size <= 0 || hi <= lo) {
    for (let i = lo; i < hi; i++) insertTop(top, index, i);
    return top;
  }
  const blocksOff = index.view.getUint32(24, true);
  let i = lo;
  for (; i < hi && i % size !== 0; i++) insertTop(top, index, i);
  for (; i + size <= hi; i += size) {
    const b = (i / size) * TOP;
    for (let j = 0; j < TOP; j++) {
      const id = index.view.getUint32(blocksOff + (b + j) * 4, true);
      if (id !== MISSING && id < n) insertTop(top, index, id);
    }
  }
  for (; i < hi; i++) insertTop(top, index, i);
  return top;
}

/** Builds a scored packed body from rows. Keys are sorted as UTF-8 bytes. */
export function buildPacked(rows: readonly PackedRow[]): Uint8Array {
  const sorted = [...rows].sort((a, b) => {
    const ka = utf8Encode(a.key);
    const kb = utf8Encode(b.key);
    const n = Math.min(ka.length, kb.length);
    for (let i = 0; i < n; i++) {
      const d = (ka[i] as number) - (kb[i] as number);
      if (d !== 0) return d;
    }
    return ka.length - kb.length;
  });
  const n = sorted.length;
  const keys = sorted.map((r) => utf8Encode(r.key));
  const values = sorted.map((r) => utf8Encode(r.value));
  let blobLen = 0;
  for (const k of keys) blobLen += k.length;
  for (const v of values) blobLen += v.length;
  const base = HEADER_BYTES + 8 * (n + 1) + 4 * n;
  const end = (base + blobLen + 3) & ~3;
  const nb = n === 0 ? 0 : Math.ceil(n / BLOCK);
  const out = new Uint8Array(end + nb * (TOP * 4));
  setU32(out, 0, MAGIC);
  setU32(out, 4, n);
  setU32(out, 8, base);
  setU32(out, 12, blobLen);
  setU32(out, 16, 0);
  setU32(out, 20, 0);
  setU32(out, 24, n === 0 ? 0 : end);
  setU32(out, 28, n === 0 ? 0 : BLOCK);
  let off = 0;
  for (let i = 0; i < n; i++) {
    setU32(out, HEADER_BYTES + i * 4, off);
    off += (keys[i] as Uint8Array).length;
  }
  setU32(out, HEADER_BYTES + n * 4, off);
  const valueOff = HEADER_BYTES + 4 * (n + 1);
  for (let i = 0; i < n; i++) {
    setU32(out, valueOff + i * 4, off);
    off += (values[i] as Uint8Array).length;
  }
  setU32(out, valueOff + n * 4, off);
  const scoresOff = HEADER_BYTES + 8 * (n + 1);
  for (let i = 0; i < n; i++) setU32(out, scoresOff + i * 4, sorted[i]?.score ?? 0);
  let at = base;
  for (const k of keys) {
    out.set(k, at);
    at += k.length;
  }
  for (const v of values) {
    out.set(v, at);
    at += v.length;
  }
  const index = mapPacked(out);
  if (index && nb > 0) {
    for (let block = 0; block < nb; block++) {
      const lo = block * BLOCK;
      const hi = Math.min(n, lo + BLOCK);
      const ids = Array.from({ length: hi - lo }, (_, i) => lo + i).sort(
        (a, b) => scoreAt(index, b) - scoreAt(index, a) || a - b,
      );
      for (let j = 0; j < TOP; j++) {
        setU32(out, end + (block * TOP + j) * 4, ids[j] ?? MISSING);
      }
    }
  }
  return out;
}

export function mapPacked(bytes: Uint8Array): PackedIndex | null {
  const aligned = alignedCopy(bytes);
  if (aligned.byteLength < HEADER_BYTES) return null;
  const view = viewOf(aligned);
  if (view.getUint32(0, true) !== MAGIC) return null;
  const n = view.getUint32(4, true);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  const base = view.getUint32(8, true);
  const blobLen = view.getUint32(12, true);
  const offsets = new Uint32Array(aligned.buffer, aligned.byteOffset + HEADER_BYTES, n + 1);
  const scoresOff = HEADER_BYTES + 8 * (n + 1);
  const scores = n === 0 ? new Uint32Array(0) : new Uint32Array(aligned.buffer, aligned.byteOffset + scoresOff, n);
  return {
    bytes: aligned,
    view,
    n,
    blockSize: view.getUint32(28, true) || BLOCK,
    blob: aligned.subarray(base, base + blobLen),
    offsets,
    scores,
  };
}

export function keyAt(index: PackedIndex, id: number): string {
  const start = index.offsets[id] as number;
  const end = index.offsets[id + 1] as number;
  return utf8Decode(index.blob.subarray(start, end)) ?? '';
}

export function valueAt(index: PackedIndex, id: number): string {
  const n = index.n;
  const valueOff = HEADER_BYTES + 4 * (n + 1);
  const start = index.view.getUint32(valueOff + id * 4, true);
  const end = index.view.getUint32(valueOff + (id + 1) * 4, true);
  return utf8Decode(index.blob.subarray(start, end)) ?? '';
}

/** Prefix top-5 over the sorted range, using block summaries when the range is wide. */
export function blockPrefix(index: PackedIndex, prefix: string): number[] {
  const q = utf8Encode(prefix);
  const lo = bound(index, q, 0, index.n, false);
  const hi = bound(index, q, lo, index.n, true);
  if (index.blockSize > 0 && index.view.getUint32(24, true) !== 0) return topRange(index, lo, hi);
  const top: number[] = [];
  for (let i = lo; i < hi; i++) insertTop(top, index, i);
  return top;
}

export function prefixRange(index: PackedIndex, prefix: string): { readonly lo: number; readonly hi: number } {
  const q = utf8Encode(prefix);
  const lo = bound(index, q, 0, index.n, false);
  const hi = bound(index, q, lo, index.n, true);
  return { lo, hi };
}

/** Fresh block query per key, never a queued continuation (E2). */
export class Completion {
  previous = '';
  lo = 0;
  hi: number;
  readonly index: PackedIndex;
  constructor(index: PackedIndex) {
    this.index = index;
    this.hi = index.n;
  }
  reset(): void {
    this.previous = '';
    this.lo = 0;
    this.hi = this.index.n;
  }
  search(prefix: string): number[] {
    const q = utf8Encode(prefix);
    const extendsPrevious = prefix.startsWith(this.previous);
    const lo = extendsPrevious ? this.lo : 0;
    const hi = extendsPrevious ? this.hi : this.index.n;
    this.lo = bound(this.index, q, lo, hi, false);
    this.hi = bound(this.index, q, this.lo, hi, true);
    this.previous = prefix;
    return topRange(this.index, this.lo, this.hi);
  }
  fresh(prefix: string): number[] {
    return blockPrefix(this.index, prefix);
  }
}

/** Adapters invalidate this token on every input/cursor/mode/draft change (E31). */
export class RevisionGate {
  current = 0;
  invalidate(): number {
    return ++this.current;
  }
  accepts(token: number): boolean {
    return token === this.current;
  }
}
