// Packed history snapshot: texts (4 MiB chunks), meta, events, hashes,
// delta-varint postings, prefix top-ten cache. No trigrams (E2). Builder uses
// interned word ids plus a growable pair array instead of Map<word, id[]> so
// a 100k merge stays well under r9's 295 MiB RSS (E6).

import { CHUNK_BYTES, sha256Hex, utf8Decode, utf8Encode } from '@murmo/store';
import {
  type HistoryRecord,
  HOSTS,
  insertTop,
  prefixQuality,
  type RankedHit,
  recencyCount,
  SCOPE_BOOST,
  TOP,
} from './rank.ts';
import { tokens } from './tokens.ts';

export const HISTORY_FORMAT = 'murmo-history-v1';
export const INDEX_MAGIC = 0x48535431;
const HEADER_BYTES = 32;
const META_STRIDE = 20;
const WORD_OFF_STRIDE = 12;
const PREFIX_TOP_STRIDE = 51;
const HASH_STRIDE = 36;
const EVENT_STRIDE = 16;
const PROJECT_STRIDE = 64;
/** Leave room for the snapshot header so each file stays under 4 MiB. */
export const TEXT_CHUNK = CHUNK_BYTES - 65_536;

export interface PackedFiles {
  readonly files: Readonly<Record<string, Uint8Array>>;
  readonly n: number;
  readonly bytes: number;
}

export interface PackedIndex {
  readonly index: Uint8Array;
  readonly texts: readonly Uint8Array[];
  readonly events: Uint8Array;
  readonly hashes: Uint8Array;
  readonly projects: Uint8Array;
  readonly n: number;
  readonly nWords: number;
  readonly nPrefixes: number;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function aligned(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset % 4 === 0) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function setU32(bytes: Uint8Array, offset: number, value: number): void {
  viewOf(bytes).setUint32(offset, value >>> 0, true);
}

function getU32(bytes: Uint8Array, offset: number): number {
  return viewOf(bytes).getUint32(offset, true);
}

function writeVarint(out: number[], value: number): void {
  let v = value >>> 0;
  while (v >= 128) {
    out.push((v & 127) | 128);
    v >>>= 7;
  }
  out.push(v);
}

function internWord(map: Map<string, number>, list: string[], word: string): number {
  let id = map.get(word);
  if (id === undefined) {
    id = list.length;
    map.set(word, id);
    list.push(word);
  }
  return id;
}

function sortPairs(w: Uint32Array, d: Uint32Array, n: number): void {
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => {
    const dw = (w[a] as number) - (w[b] as number);
    if (dw !== 0) return dw;
    return (d[a] as number) - (d[b] as number);
  });
  const nw = new Uint32Array(n);
  const nd = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const j = idx[i] as number;
    nw[i] = w[j] as number;
    nd[i] = d[j] as number;
  }
  w.set(nw);
  d.set(nd);
}

function hex64(project: string): string {
  if (project.length >= 64) return project.slice(0, 64);
  return project.padEnd(64, '0');
}

/**
 * Build the snapshot file bodies (not yet wrapped in MURMOSN1). Bounded
 * memory: interned words + a pair array, no per-word posting Maps.
 */
export function buildPacked(records: readonly HistoryRecord[], nowMs: number): PackedFiles {
  const n = records.length;
  const wordMap = new Map<string, number>();
  const wordList: string[] = [];
  let pairW = new Uint32Array(Math.max(1024, n * 4));
  let pairD = new Uint32Array(pairW.length);
  let pairN = 0;
  const addPair = (w: number, d: number) => {
    if (pairN === pairW.length) {
      const nw = new Uint32Array(pairW.length * 2);
      nw.set(pairW);
      pairW = nw;
      const nd = new Uint32Array(pairD.length * 2);
      nd.set(pairD);
      pairD = nd;
    }
    pairW[pairN] = w;
    pairD[pairN] = d;
    pairN++;
  };

  const textChunks: Uint8Array[] = [];
  let chunk: number[] = [];
  const meta = new Uint8Array(n * META_STRIDE);
  const scores = new Float32Array(n);
  const hashes = new Uint8Array(n * HASH_STRIDE);
  const projectIndex = new Map<string, number>();
  const projectList: string[] = [];
  const internProject = (p: string): number => {
    const key = hex64(p);
    let id = projectIndex.get(key);
    if (id === undefined) {
      id = projectList.length;
      projectIndex.set(key, id);
      projectList.push(key);
    }
    return id;
  };
  let eventCount = 0;
  for (const r of records) eventCount += r.events.length;
  const events = new Uint8Array(eventCount * EVENT_STRIDE);
  let eventAt = 0;
  let chunkOff = 0;

  const flushChunk = () => {
    if (chunk.length === 0) return;
    textChunks.push(Uint8Array.from(chunk));
    chunk = [];
    chunkOff = 0;
  };

  for (let id = 0; id < n; id++) {
    const r = records[id] as HistoryRecord;
    const bytes = utf8Encode(r.text);
    if (chunkOff + bytes.length > TEXT_CHUNK && chunkOff > 0) flushChunk();
    const chunkId = textChunks.length;
    const off = chunkOff;
    for (let i = 0; i < bytes.length; i++) chunk.push(bytes[i] as number);
    chunkOff += bytes.length;
    const base = id * META_STRIDE;
    setU32(meta, base, chunkId);
    setU32(meta, base + 4, off);
    setU32(meta, base + 8, bytes.length);
    setU32(meta, base + 12, r.count);
    setU32(meta, base + 16, Math.floor(r.lastAt / 1000) >>> 0);
    scores[id] = recencyCount(r.count, r.lastAt, nowMs);
    const digest = sha256Hex(bytes);
    for (let i = 0; i < 32; i++) hashes[id * HASH_STRIDE + i] = Number.parseInt(digest.slice(i * 2, i * 2 + 2), 16);
    setU32(hashes, id * HASH_STRIDE + 32, id);
    const seenWord = new Set<number>();
    for (const word of tokens(r.text)) {
      const wi = internWord(wordMap, wordList, word);
      if (seenWord.has(wi)) continue;
      seenWord.add(wi);
      addPair(wi, id);
    }
    const seenHost = new Set<string>();
    for (const ev of r.events) {
      const pi = internProject(ev.project);
      const hi = hostIndexSafe(ev.host);
      const eb = eventAt * EVENT_STRIDE;
      setU32(events, eb, id);
      events[eb + 4] = hi;
      events[eb + 5] = 0;
      viewOf(events).setUint16(eb + 6, pi, true);
      setU32(events, eb + 8, Math.floor(ev.at / 1000) >>> 0);
      eventAt++;
      seenHost.add(ev.host);
    }
  }
  flushChunk();

  sortPairs(pairW, pairD, pairN);
  const wordOrder = [...wordList.keys()].sort((a, b) => {
    const aa = utf8Encode(wordList[a] as string);
    const bb = utf8Encode(wordList[b] as string);
    const len = Math.min(aa.length, bb.length);
    for (let i = 0; i < len; i++) {
      const d = (aa[i] as number) - (bb[i] as number);
      if (d) return d;
    }
    return aa.length - bb.length;
  });
  const remap = new Uint32Array(wordList.length);
  for (let i = 0; i < wordOrder.length; i++) remap[wordOrder[i] as number] = i;
  for (let i = 0; i < pairN; i++) pairW[i] = remap[pairW[i] as number] as number;
  sortPairs(pairW, pairD, pairN);

  const posts: number[] = [];
  const offsets = new Uint8Array((wordList.length + 1) * WORD_OFF_STRIDE);
  const dictParts: Uint8Array[] = [];
  let doff = 0;
  let poff = 0;
  let pi = 0;
  for (let wi = 0; wi < wordList.length; wi++) {
    const word = wordList[wordOrder[wi] as number] as string;
    const wb = utf8Encode(word);
    dictParts.push(wb);
    setU32(offsets, wi * WORD_OFF_STRIDE, doff);
    setU32(offsets, wi * WORD_OFF_STRIDE + 4, poff);
    let prev = 0;
    let count = 0;
    let lastDoc = 0xffffffff;
    while (pi < pairN && pairW[pi] === wi) {
      const doc = pairD[pi] as number;
      pi++;
      if (doc === lastDoc) continue;
      lastDoc = doc;
      writeVarint(posts, doc - prev);
      prev = doc;
      count++;
      poff = posts.length;
    }
    setU32(offsets, wi * WORD_OFF_STRIDE + 8, count);
    doff += wb.length;
  }
  setU32(offsets, wordList.length * WORD_OFF_STRIDE, doff);
  setU32(offsets, wordList.length * WORD_OFF_STRIDE + 4, poff);
  const wordsBlob = concat(dictParts);
  const postings = Uint8Array.from(posts);

  const prefixTop = new Map<string, RankedHit[]>();
  for (let id = 0; id < n; id++) {
    const r = records[id] as HistoryRecord;
    const qualities = new Map<string, number>();
    for (const word of tokens(r.text)) {
      const max = Math.min(2, word.length);
      for (let len = 1; len <= max; len++) {
        const prefix = word.slice(0, len);
        const quality = prefixQuality(len, word.length);
        qualities.set(prefix, Math.max(qualities.get(prefix) ?? 0, quality));
      }
    }
    const base = scores[id] as number;
    for (const [prefix, quality] of qualities) {
      let top = prefixTop.get(prefix);
      if (!top) {
        top = [];
        prefixTop.set(prefix, top);
      }
      insertTop(top, { id, score: (quality / 100) * base, text: '' }, TOP);
    }
  }
  const prefixes = [...prefixTop.keys()].sort();
  const prefixParts: Uint8Array[] = [];
  const prefixOff = new Uint8Array((prefixes.length + 1) * 4);
  const prefixTopBytes = new Uint8Array(prefixes.length * PREFIX_TOP_STRIDE);
  let pbytes = 0;
  for (let i = 0; i < prefixes.length; i++) {
    const prefix = prefixes[i] as string;
    const b = utf8Encode(prefix);
    setU32(prefixOff, i * 4, pbytes);
    prefixParts.push(b);
    pbytes += b.length;
    const top = prefixTop.get(prefix) ?? [];
    prefixTopBytes[i * PREFIX_TOP_STRIDE] = top.length;
    for (let j = 0; j < top.length; j++) {
      const hit = top[j] as RankedHit;
      const rec = records[hit.id] as HistoryRecord;
      const wordLen = bestWordLen(rec.text, prefix);
      const quality = prefixQuality(prefix.length, wordLen);
      setU32(prefixTopBytes, i * PREFIX_TOP_STRIDE + 1 + j * 5, hit.id);
      prefixTopBytes[i * PREFIX_TOP_STRIDE + 5 + j * 5] = quality;
    }
  }
  setU32(prefixOff, prefixes.length * 4, pbytes);
  const prefixWords = concat(prefixParts);

  const index = new Uint8Array(
    HEADER_BYTES +
      meta.length +
      scores.byteLength +
      wordsBlob.length +
      offsets.length +
      postings.length +
      prefixWords.length +
      prefixOff.length +
      prefixTopBytes.length,
  );
  setU32(index, 0, INDEX_MAGIC);
  setU32(index, 4, n);
  setU32(index, 8, wordList.length);
  setU32(index, 12, prefixes.length);
  setU32(index, 16, wordsBlob.length);
  setU32(index, 20, postings.length);
  setU32(index, 24, prefixWords.length);
  let at = HEADER_BYTES;
  index.set(meta, at);
  at += meta.length;
  index.set(new Uint8Array(scores.buffer, scores.byteOffset, scores.byteLength), at);
  at += scores.byteLength;
  index.set(wordsBlob, at);
  at += wordsBlob.length;
  index.set(offsets, at);
  at += offsets.length;
  index.set(postings, at);
  at += postings.length;
  index.set(prefixWords, at);
  at += prefixWords.length;
  index.set(prefixOff, at);
  at += prefixOff.length;
  index.set(prefixTopBytes, at);

  const hashRows = Array.from({ length: n }, (_, id) => ({
    digest: hashes.subarray(id * HASH_STRIDE, id * HASH_STRIDE + 32),
    id,
  }));
  hashRows.sort((a, b) => cmpBytes(a.digest, b.digest));
  const sortedHashes = new Uint8Array(n * HASH_STRIDE);
  for (let i = 0; i < n; i++) {
    const row = hashRows[i] as { digest: Uint8Array; id: number };
    sortedHashes.set(row.digest, i * HASH_STRIDE);
    setU32(sortedHashes, i * HASH_STRIDE + 32, row.id);
  }

  const projects = new Uint8Array(projectList.length * PROJECT_STRIDE);
  for (let i = 0; i < projectList.length; i++) {
    const hex = utf8Encode(projectList[i] as string);
    projects.set(hex.subarray(0, Math.min(hex.length, PROJECT_STRIDE)), i * PROJECT_STRIDE);
  }

  const files: Record<string, Uint8Array> = {
    index,
    events,
    hashes: sortedHashes,
    projects,
  };
  for (let i = 0; i < textChunks.length; i++) files[`texts-${i}`] = textChunks[i] as Uint8Array;
  if (textChunks.length === 0) files['texts-0'] = new Uint8Array(0);
  let bytes = 0;
  for (const body of Object.values(files)) bytes += body.length;
  return { files, n, bytes };
}

function hostIndexSafe(host: string): number {
  const i = (HOSTS as readonly string[]).indexOf(host);
  return i < 0 ? HOSTS.length - 1 : i;
}

function bestWordLen(text: string, prefix: string): number {
  let best = prefix.length;
  for (const word of tokens(text)) {
    if (word.startsWith(prefix) && word.length > best) best = word.length;
  }
  return best;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d) return d;
  }
  return a.length - b.length;
}

export function mapPacked(files: Readonly<Record<string, Uint8Array>>): PackedIndex | null {
  const index = files.index;
  if (!index || index.length < HEADER_BYTES) return null;
  const body = aligned(index);
  if (getU32(body, 0) !== INDEX_MAGIC) return null;
  const n = getU32(body, 4);
  const texts: Uint8Array[] = [];
  for (let i = 0; files[`texts-${i}`]; i++) texts.push(files[`texts-${i}`] as Uint8Array);
  return {
    index: body,
    texts,
    events: files.events ?? new Uint8Array(0),
    hashes: files.hashes ?? new Uint8Array(0),
    projects: files.projects ?? new Uint8Array(0),
    n,
    nWords: getU32(body, 8),
    nPrefixes: getU32(body, 12),
  };
}

function layout(index: PackedIndex) {
  const n = index.n;
  const nWords = index.nWords;
  const nPrefixes = index.nPrefixes;
  const wordsBytes = getU32(index.index, 16);
  const postingsBytes = getU32(index.index, 20);
  const prefixWordsBytes = getU32(index.index, 24);
  let at = HEADER_BYTES;
  const meta = at;
  at += n * META_STRIDE;
  const scores = at;
  at += n * 4;
  const words = at;
  at += wordsBytes;
  const wordOff = at;
  at += (nWords + 1) * WORD_OFF_STRIDE;
  const postings = at;
  at += postingsBytes;
  const prefixWords = at;
  at += prefixWordsBytes;
  const prefixOff = at;
  at += (nPrefixes + 1) * 4;
  const prefixTop = at;
  return { meta, scores, words, wordOff, postings, prefixWords, prefixOff, prefixTop, nWords, nPrefixes };
}

function wordCompare(index: PackedIndex, lay: ReturnType<typeof layout>, wi: number, q: Uint8Array): number {
  const a = getU32(index.index, lay.wordOff + wi * WORD_OFF_STRIDE);
  const end = getU32(index.index, lay.wordOff + (wi + 1) * WORD_OFF_STRIDE);
  let i = 0;
  let at = lay.words + a;
  const last = lay.words + end;
  while (at < last && i < q.length) {
    const d = (index.index[at] as number) - (q[i] as number);
    if (d) return d;
    at++;
    i++;
  }
  return i === q.length ? 0 : -1;
}

function postingCount(index: PackedIndex, lay: ReturnType<typeof layout>, q: Uint8Array): number {
  let n = 0;
  for (let wi = lowerBound(index, lay, q); wi < lay.nWords && wordCompare(index, lay, wi, q) === 0; wi++) {
    n += getU32(index.index, lay.wordOff + wi * WORD_OFF_STRIDE + 8);
  }
  return n;
}

function lowerBound(index: PackedIndex, lay: ReturnType<typeof layout>, q: Uint8Array): number {
  let lo = 0;
  let hi = lay.nWords;
  while (lo < hi) {
    const m = (lo + hi) >>> 1;
    if (wordCompare(index, lay, m, q) < 0) lo = m + 1;
    else hi = m;
  }
  return lo;
}

function readVarint(bytes: Uint8Array, pos: { i: number }): number {
  let d = 0;
  let shift = 0;
  let b = 0;
  do {
    b = bytes[pos.i] as number;
    pos.i++;
    d |= (b & 127) << shift;
    shift += 7;
  } while (b & 128);
  return d >>> 0;
}

function textOf(index: PackedIndex, id: number): string {
  const lay = layout(index);
  const base = lay.meta + id * META_STRIDE;
  const chunk = getU32(index.index, base);
  const off = getU32(index.index, base + 4);
  const len = getU32(index.index, base + 8);
  const buf = index.texts[chunk];
  if (!buf) return '';
  return utf8Decode(buf.subarray(off, off + len)) ?? '';
}

function scoreOf(index: PackedIndex, id: number, quality: number): number {
  const lay = layout(index);
  const base = viewOf(index.index).getFloat32(lay.scores + id * 4, true);
  return quality * base;
}

function cached(index: PackedIndex, q: Uint8Array): RankedHit[] | null {
  const lay = layout(index);
  let lo = 0;
  let hi = lay.nPrefixes;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const start = getU32(index.index, lay.prefixOff + mid * 4);
    const end = getU32(index.index, lay.prefixOff + (mid + 1) * 4);
    const slice = index.index.subarray(lay.prefixWords + start, lay.prefixWords + end);
    const cmp = cmpBytes(slice, q);
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= lay.nPrefixes) return null;
  const start = getU32(index.index, lay.prefixOff + lo * 4);
  const end = getU32(index.index, lay.prefixOff + (lo + 1) * 4);
  const slice = index.index.subarray(lay.prefixWords + start, lay.prefixWords + end);
  if (cmpBytes(slice, q) !== 0) return null;
  const row = lay.prefixTop + lo * PREFIX_TOP_STRIDE;
  const count = index.index[row] as number;
  const out: RankedHit[] = [];
  for (let j = 0; j < count; j++) {
    const id = getU32(index.index, row + 1 + j * 5);
    const quality = index.index[row + 5 + j * 5] as number;
    out.push({ id, score: scoreOf(index, id, quality / 100), text: '' });
  }
  return out;
}

function docProjects(index: PackedIndex, id: number, project?: string): boolean {
  if (project === undefined) return false;
  const want = hex64(project);
  const nProj = Math.floor(index.projects.length / PROJECT_STRIDE);
  let wantIdx = -1;
  for (let i = 0; i < nProj; i++) {
    const hex = utf8Decode(index.projects.subarray(i * PROJECT_STRIDE, (i + 1) * PROJECT_STRIDE));
    if (hex === want) {
      wantIdx = i;
      break;
    }
  }
  if (wantIdx < 0) return false;
  const n = Math.floor(index.events.length / EVENT_STRIDE);
  for (let i = 0; i < n; i++) {
    const eb = i * EVENT_STRIDE;
    if (getU32(index.events, eb) !== id) continue;
    if (viewOf(index.events).getUint16(eb + 6, true) === wantIdx) return true;
  }
  return false;
}

export function searchPacked(
  index: PackedIndex,
  query: string,
  opts: { readonly now: number; readonly project?: string } = { now: 0 },
): RankedHit[] {
  const qs = tokens(query);
  if (!qs.length || qs.length > 32) return [];
  const project = opts.project;
  const withText = (hits: RankedHit[]): RankedHit[] => hits.map((h) => ({ ...h, text: textOf(index, h.id) }));
  if (qs.length === 1 && (qs[0] as string).length <= 2) {
    const cachedHits = cached(index, utf8Encode(qs[0] as string));
    if (cachedHits) {
      const boosted =
        opts.project === undefined
          ? cachedHits
          : cachedHits.map((h) =>
              docProjects(index, h.id, opts.project) ? { ...h, score: h.score + SCOPE_BOOST } : h,
            );
      return withText(boosted);
    }
  }
  const lay = layout(index);
  const scoresF = new Float32Array(index.index.buffer, index.index.byteOffset + lay.scores, index.n);
  const scoreAt = (id: number, qlt: number) => qlt * (scoresF[id] as number);
  if (qs.length === 1) {
    const q = utf8Encode(qs[0] as string);
    const bestOne: RankedHit[] = [];
    for (let wi = lowerBound(index, lay, q); wi < lay.nWords && wordCompare(index, lay, wi, q) === 0; wi++) {
      const wStart = getU32(index.index, lay.wordOff + wi * WORD_OFF_STRIDE);
      const wEnd = getU32(index.index, lay.wordOff + (wi + 1) * WORD_OFF_STRIDE);
      const qlt = prefixQuality(q.length, wEnd - wStart) / 100;
      const pos = { i: lay.postings + getU32(index.index, lay.wordOff + wi * WORD_OFF_STRIDE + 4) };
      const count = getU32(index.index, lay.wordOff + wi * WORD_OFF_STRIDE + 8);
      let id = 0;
      for (let j = 0; j < count; j++) {
        id += readVarint(index.index, pos);
        let score = scoreAt(id, qlt);
        if (project !== undefined && docProjects(index, id, project)) score += SCOPE_BOOST;
        insertTop(bestOne, { id, score, text: '' });
      }
    }
    return withText(bestOne);
  }
  const matches = new Uint8Array(index.n);
  const quality = new Uint16Array(index.n);
  const seen = new Uint16Array(index.n);
  const tokenQuality = new Uint8Array(index.n);
  const ordered = [...qs].sort(
    (a, b) => postingCount(index, lay, utf8Encode(a)) - postingCount(index, lay, utf8Encode(b)),
  );
  let epoch = 1;
  let termIndex = 0;
  for (const token of ordered) {
    const q = utf8Encode(token);
    epoch++;
    if (epoch >= 65535) {
      seen.fill(0);
      epoch = 1;
    }
    for (let wi = lowerBound(index, lay, q); wi < lay.nWords && wordCompare(index, lay, wi, q) === 0; wi++) {
      const wStart = getU32(index.index, lay.wordOff + wi * WORD_OFF_STRIDE);
      const wEnd = getU32(index.index, lay.wordOff + (wi + 1) * WORD_OFF_STRIDE);
      const qlt = prefixQuality(q.length, wEnd - wStart);
      const pos = { i: lay.postings + getU32(index.index, lay.wordOff + wi * WORD_OFF_STRIDE + 4) };
      const count = getU32(index.index, lay.wordOff + wi * WORD_OFF_STRIDE + 8);
      let id = 0;
      for (let j = 0; j < count; j++) {
        id += readVarint(index.index, pos);
        if ((matches[id] ?? 0) < termIndex) continue;
        if (seen[id] !== epoch) {
          seen[id] = epoch;
          matches[id] = (matches[id] as number) + 1;
          quality[id] = (quality[id] as number) + qlt;
          tokenQuality[id] = qlt;
        } else if (qlt > (tokenQuality[id] as number)) {
          quality[id] = (quality[id] as number) + qlt - (tokenQuality[id] as number);
          tokenQuality[id] = qlt;
        }
      }
    }
    termIndex++;
  }
  const best: RankedHit[] = [];
  for (let id = 0; id < index.n; id++) {
    if (matches[id] !== qs.length) continue;
    let score = scoreOf(index, id, (quality[id] as number) / (100 * qs.length));
    if (project !== undefined && docProjects(index, id, project)) score += SCOPE_BOOST;
    insertTop(best, { id, score, text: '' });
  }
  return withText(best);
}

export function loadText(index: PackedIndex, id: number): string {
  return textOf(index, id);
}

export function packedBytes(index: PackedIndex): { index: number; texts: number; total: number } {
  let texts = 0;
  for (const t of index.texts) texts += t.length;
  const meta = index.index.length + index.events.length + index.hashes.length + index.projects.length;
  return { index: meta, texts, total: meta + texts };
}
