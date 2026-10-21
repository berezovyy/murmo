// Guest entry for tools/lang-load.mjs: session start (openPack, no per-entry
// validation and no hash, as in a realm without native crypto) and lookup
// latency on the real pack, measured inside each runtime. Built as the quickjs
// IIFE bundle and run unchanged in Node, Bun, QuickJS-wasm and rquickjs.

import { lookup, openPack } from '../src/index.ts';

export interface CostInput {
  /** Base64 of each file, so every runtime gets the same bytes through JSON. */
  readonly manifest: string;
  readonly table: string;
  readonly casePolicy: string;
  readonly record: string;
  readonly mtimeMs: { readonly manifest: number; readonly table: number; readonly casePolicy: number };
  /** Words looked up one at a time, each timed: table keys and misses. */
  readonly words: readonly string[];
  readonly opens: number;
}

export interface CostResult {
  readonly entries: number;
  readonly integrity: string;
  /** The first open in a fresh realm, then the median of the rest, in ms. */
  readonly openColdMs: number;
  readonly openMedianMs: number;
  readonly lookupP50Us: number;
  readonly lookupP99Us: number;
  readonly lookupMaxUs: number;
  readonly hits: number;
}

declare const performance: { now(): number } | undefined;

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Allocates one ArrayBuffer per file, as a host read would: the table's views need offset 0. */
function fromBase64(text: string): Uint8Array {
  const codes = new Uint8Array(128);
  for (let i = 0; i < alphabet.length; i++) codes[alphabet.charCodeAt(i)] = i;
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      ((codes[text.charCodeAt(i)] as number) << 18) |
      ((codes[text.charCodeAt(i + 1)] as number) << 12) |
      ((codes[text.charCodeAt(i + 2)] as number) << 6) |
      (codes[text.charCodeAt(i + 3)] as number);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

const quantile = (sorted: readonly number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;

export function run(input: CostInput): CostResult {
  if (typeof performance === 'undefined') throw new Error('the host must provide performance.now()');
  const clock = performance;
  const files = {
    manifest: { bytes: fromBase64(input.manifest), mtimeMs: input.mtimeMs.manifest },
    table: { bytes: fromBase64(input.table), mtimeMs: input.mtimeMs.table },
    casePolicy: { bytes: fromBase64(input.casePolicy), mtimeMs: input.mtimeMs.casePolicy },
    record: fromBase64(input.record),
  };
  const opens: number[] = [];
  let opened: ReturnType<typeof openPack> | undefined;
  for (let i = 0; i < input.opens; i++) {
    const start = clock.now();
    opened = openPack(files);
    opens.push(clock.now() - start);
  }
  if (!opened) throw new Error('no opens were asked for');
  if (!opened.ok) throw new Error(`pack did not open: ${opened.reason}`);
  const table = opened.pack.table;
  const times: number[] = [];
  let hits = 0;
  for (const word of input.words) {
    const start = clock.now();
    const fix = lookup(table, word);
    times.push((clock.now() - start) * 1000);
    if (fix !== undefined) hits++;
  }
  times.sort((a, b) => a - b);
  const rest = opens.slice(1).sort((a, b) => a - b);
  return {
    entries: table.entries,
    integrity: opened.integrity,
    openColdMs: opens[0] as number,
    openMedianMs: rest.length ? quantile(rest, 0.5) : (opens[0] as number),
    lookupP50Us: quantile(times, 0.5),
    lookupP99Us: quantile(times, 0.99),
    lookupMaxUs: times[times.length - 1] as number,
    hits,
  };
}
