// Claude's `$.fs` `{as:'bytes'}` returns base64. Prefer the host's native
// decoder (measured 5.7 ms load, E10); fall back for tests.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const TABLE = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) TABLE[ALPHABET.charCodeAt(i)] = i;

export function decodeBase64(source: string): Uint8Array {
  const native = (Uint8Array as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (typeof native === 'function') return native(source);
  const pad = source.endsWith('==') ? 2 : source.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((source.length / 4) * 3 - pad);
  let acc = 0;
  let bits = 0;
  let n = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    const value = code < 128 ? TABLE[code] : -1;
    if (value === undefined || value < 0) continue;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (n < out.length) out[n++] = (acc >> bits) & 255;
    }
  }
  return out;
}

export function bytesOf(read: string | { readonly base64: string }): Uint8Array {
  if (typeof read === 'string') return decodeBase64(read);
  return decodeBase64(read.base64);
}

export function textOf(read: string | { readonly base64: string }): string {
  if (typeof read === 'string') return read;
  const bytes = decodeBase64(read.base64);
  let out = '';
  const chunk: number[] = [];
  const flush = () => {
    out += String.fromCharCode.apply(null, chunk);
    chunk.length = 0;
  };
  for (let i = 0; i < bytes.length; ) {
    if (chunk.length >= 4096) flush();
    const b = bytes[i] as number;
    if (b < 0x80) {
      chunk.push(b);
      i++;
      continue;
    }
    if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      chunk.push(((b & 0x1f) << 6) | ((bytes[i + 1] as number) & 0x3f));
      i += 2;
      continue;
    }
    if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      const cp = ((b & 0x0f) << 12) | (((bytes[i + 1] as number) & 0x3f) << 6) | ((bytes[i + 2] as number) & 0x3f);
      if (cp >= 0x10000) {
        const u = cp - 0x10000;
        chunk.push(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
      } else chunk.push(cp);
      i += 3;
      continue;
    }
    if (b >= 0xf0 && i + 3 < bytes.length) {
      const cp =
        ((b & 7) << 18) |
        (((bytes[i + 1] as number) & 0x3f) << 12) |
        (((bytes[i + 2] as number) & 0x3f) << 6) |
        ((bytes[i + 3] as number) & 0x3f);
      const u = cp - 0x10000;
      chunk.push(0xd800 + (u >> 10), 0xdc00 + (u & 0x3ff));
      i += 4;
      continue;
    }
    chunk.push(0xfffd);
    i++;
  }
  if (chunk.length) flush();
  return out;
}
