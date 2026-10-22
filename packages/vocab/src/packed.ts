// Packed names-v1 index: the r13 on-disk format (lesson 69). Uncompressed u32
// postings, not delta varints — native search was measured on this layout.
// Magic 0x4d55524d ("MURM"). Never stores source lines.

import { utf8Decode, utf8Encode } from '@murmo/store';
import { wordKey } from './match.ts';

export const NAMES_MAGIC = 0x4d55524d;
export const NAMES_HEADER_BYTES = 48;
export const NAMES_DIR = 'names-v1';
export const NAMES_BIN = 'names.bin';
export const NAMES_META = 'meta.json';
export const NAMES_FILES = 'files.json';
export const NAMES_CURRENT = 'CURRENT';
export const INDEXER_VERSION = 3;

export interface PackedEntry {
  readonly name: string;
  readonly key: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly refs: number;
  readonly locations: number;
  readonly member: string;
  readonly source: number;
}

export interface PackedIndex {
  readonly n: number;
  readonly bytes: Uint8Array;
  entry(id: number): PackedEntry;
  findName(name: string): boolean;
  retrieve(key: string, limit?: number): number[];
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8) | ((bytes[at + 2] ?? 0) << 16) | ((bytes[at + 3] ?? 0) << 24);
}

function writeU32(view: DataView, at: number, value: number): void {
  view.setUint32(at, value >>> 0, true);
}

/** UTF-16 trigram codes, matching the native helper (r13 names.rs). */
export function gramCodes(s: string): number[] {
  const padded = `^${s}$`;
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i + 2 < padded.length; i++) {
    const g =
      Math.imul(Math.imul(padded.charCodeAt(i), 65599) + padded.charCodeAt(i + 1), 65599) + padded.charCodeAt(i + 2);
    const code = g >>> 0;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export function bloomHashes(s: string): [number, number] {
  let a = 2166136261;
  let b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 16777619) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(i), 2246822519) >>> 0;
  }
  return [a, b | 1];
}

export function bloomCreate(names: readonly string[]): Uint8Array {
  const bits = new Uint8Array(Math.max(1, Math.ceil((names.length * 12) / 8)));
  for (const s of names) {
    const [a, b] = bloomHashes(s);
    for (let i = 0; i < 7; i++) {
      const n = (a + Math.imul(i, b)) >>> 0;
      const bit = n % (bits.length * 8);
      const at = bit >>> 3;
      bits[at] = (bits[at] ?? 0) | (1 << (bit & 7));
    }
  }
  return bits;
}

export function bloomHas(bits: Uint8Array, s: string): boolean {
  if (bits.length === 0) return false;
  const [a, b] = bloomHashes(s);
  for (let i = 0; i < 7; i++) {
    const n = (a + Math.imul(i, b)) >>> 0;
    const bit = n % (bits.length * 8);
    if (!((bits[bit >>> 3] ?? 0) & (1 << (bit & 7)))) return false;
  }
  return true;
}

function memberOf(name: string): string {
  if (!name.includes('::')) return '';
  const parts = name.split('::');
  return wordKey(parts[parts.length - 1] ?? '');
}

export const SOURCE_USER = 1;
export const SOURCE_MANIFEST = 2;
export const SOURCE_TAGS = 4;
export const SOURCE_LSP = 8;
export const SOURCE_DOCS = 16;

export interface BuildRecord {
  readonly name: string;
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly refs: number;
  readonly locations?: number;
  readonly owner?: string;
  readonly source?: number;
  readonly key?: string;
}

/** Build a names.bin buffer from records. Does not store source text. */
export function buildPacked(records: readonly BuildRecord[]): Uint8Array {
  const entries = records.map((r) => ({
    name: r.name,
    key: r.key && r.key.length > 0 ? r.key : wordKey(r.name),
    kind: r.kind,
    file: r.file,
    line: r.line >>> 0,
    refs: r.refs >>> 0,
    locations: (r.locations ?? 1) >>> 0,
    member: r.owner ? wordKey(r.owner.split(/::|\./).pop() ?? r.owner) : memberOf(r.name),
    source: (r.source ?? SOURCE_TAGS) >>> 0,
  }));
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const bloom = bloomCreate(entries.map((e) => e.name));
  const parts: Uint8Array[] = [];
  const offsets = [0];
  const refs: number[] = [];
  const lines: number[] = [];
  const count: number[] = [];
  const grams = new Map<number, number[]>();
  entries.forEach((e, id) => {
    const part = utf8Encode([e.name, e.key, e.kind, e.file, e.member, String(e.source)].join('\0'));
    parts.push(part);
    offsets.push((offsets[offsets.length - 1] ?? 0) + part.length);
    refs.push(e.refs);
    lines.push(e.line);
    count.push(e.locations);
    for (const g of gramCodes(e.key)) {
      const list = grams.get(g);
      if (list) list.push(id);
      else grams.set(g, [id]);
    }
  });
  const keys = [...grams.keys()].sort((a, b) => a - b);
  const po = [0];
  const posts: number[] = [];
  for (const g of keys) {
    const list = grams.get(g) ?? [];
    posts.push(...list);
    po.push(posts.length);
  }
  let stringsLen = 0;
  for (const p of parts) stringsLen += p.length;
  const header = new ArrayBuffer(NAMES_HEADER_BYTES);
  const hv = new DataView(header);
  writeU32(hv, 0, NAMES_MAGIC);
  writeU32(hv, 4, entries.length);
  writeU32(hv, 8, keys.length);
  writeU32(hv, 12, posts.length);
  writeU32(hv, 16, stringsLen);
  writeU32(hv, 20, bloom.length);
  const u32s = [...offsets, ...refs, ...lines, ...count, ...keys, ...po, ...posts];
  const tables = new ArrayBuffer(u32s.length * 4);
  const tv = new DataView(tables);
  for (let i = 0; i < u32s.length; i++) writeU32(tv, i * 4, u32s[i] ?? 0);
  const out = new Uint8Array(NAMES_HEADER_BYTES + tables.byteLength + stringsLen + bloom.length);
  out.set(new Uint8Array(header), 0);
  out.set(new Uint8Array(tables), NAMES_HEADER_BYTES);
  let at = NAMES_HEADER_BYTES + tables.byteLength;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  out.set(bloom, at);
  return out;
}

export function loadPacked(buffer: Uint8Array): PackedIndex {
  if (buffer.byteLength < NAMES_HEADER_BYTES) throw new Error('names index too small');
  if (u32(buffer, 0) !== NAMES_MAGIC) throw new Error('bad names index magic');
  const n = u32(buffer, 4);
  const g = u32(buffer, 8);
  const np = u32(buffer, 12);
  const stringsLen = u32(buffer, 16);
  const bloomLen = u32(buffer, 20);
  let pos = NAMES_HEADER_BYTES;
  const take = (count: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      out.push(u32(buffer, pos));
      pos += 4;
    }
    return out;
  };
  const offsets = take(n + 1);
  const refs = take(n);
  const lines = take(n);
  const count = take(n);
  const grams = take(g);
  const postOffsets = take(g + 1);
  const posts = take(np);
  const strings = buffer.subarray(pos, pos + stringsLen);
  const bloom = buffer.subarray(pos + stringsLen, pos + stringsLen + bloomLen);
  const entry = (id: number): PackedEntry => {
    const start = offsets[id] ?? 0;
    const end = offsets[id + 1] ?? start;
    const fields = (utf8Decode(strings.subarray(start, end)) ?? '').split('\0');
    return {
      name: fields[0] ?? '',
      key: fields[1] ?? '',
      kind: fields[2] ?? '',
      file: fields[3] ?? '',
      member: fields[4] ?? '',
      source: Number.parseInt(fields[5] ?? '', 10) || SOURCE_TAGS,
      refs: refs[id] ?? 0,
      line: lines[id] ?? 0,
      locations: count[id] ?? 1,
    };
  };
  const posting = (gram: number): number[] => {
    let lo = 0;
    let hi = g;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if ((grams[m] ?? 0) < gram) lo = m + 1;
      else hi = m;
    }
    if (lo >= g || grams[lo] !== gram) return [];
    return posts.slice(postOffsets[lo] ?? 0, postOffsets[lo + 1] ?? 0);
  };
  const counts = new Uint16Array(n);
  const touched = new Uint32Array(n);
  return {
    n,
    bytes: buffer,
    entry,
    findName: (name) => bloomHas(bloom, name),
    retrieve(key: string, limit = 96): number[] {
      let used = 0;
      let max = 0;
      for (const gram of gramCodes(key)) {
        for (const id of posting(gram)) {
          if (!counts[id]) touched[used++] = id;
          const next = (counts[id] ?? 0) + 1;
          counts[id] = next;
          if (next > max) max = next;
        }
      }
      const ids: number[] = [];
      for (let score = max; score > 0 && ids.length < limit; score--) {
        for (let i = 0; i < used && ids.length < limit; i++) {
          const id = touched[i] ?? 0;
          if (counts[id] === score) ids.push(id);
        }
      }
      for (let i = 0; i < used; i++) counts[touched[i] ?? 0] = 0;
      return ids;
    },
  };
}

export function candidatesFrom(index: PackedIndex, ids: readonly number[]): import('./match.ts').NameCandidate[] {
  return ids.map((id) => {
    const e = index.entry(id);
    return {
      id,
      name: e.name,
      key: e.key,
      refs: e.refs,
      location: { kind: e.kind, file: e.file, line: e.line },
      locations: e.locations,
      member: e.member,
      source: e.source,
    };
  });
}
