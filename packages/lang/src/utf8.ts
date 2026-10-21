// Strict UTF-8 decoding for the pack's small JSON files. Portable code has no
// TextDecoder (QuickJS lacks it), and a manifest with invalid bytes must be
// refused, not repaired with U+FFFD. Code units are collected and turned into
// a string in chunks: one `+=` per character cost about 2 ms per session start
// in QuickJS for the manifest and install record.

const CHUNK = 4096;

export function decodeUtf8(bytes: Uint8Array): string {
  const parts: string[] = [];
  let units: number[] = [];
  const flush = () => {
    parts.push(String.fromCharCode.apply(null, units));
    units = [];
  };
  for (let i = 0; i < bytes.length; ) {
    if (units.length >= CHUNK) flush();
    const b = bytes[i] as number;
    if (b < 0x80) {
      units.push(b);
      i++;
      continue;
    }
    let cp: number;
    let extra: number;
    if (b >= 0xc2 && b < 0xe0) {
      cp = b & 0x1f;
      extra = 1;
    } else if (b >= 0xe0 && b < 0xf0) {
      cp = b & 0x0f;
      extra = 2;
    } else if (b >= 0xf0 && b < 0xf5) {
      cp = b & 0x07;
      extra = 3;
    } else throw new Error(`invalid UTF-8 byte ${b} at ${i}`);
    for (let k = 1; k <= extra; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) throw new Error(`invalid UTF-8 continuation at ${i + k}`);
      cp = (cp << 6) | (c & 0x3f);
    }
    // Overlong forms, surrogates and code points past U+10FFFF are not UTF-8.
    if (
      (extra === 2 && cp < 0x800) ||
      (extra === 3 && (cp < 0x10000 || cp > 0x10ffff)) ||
      (cp >= 0xd800 && cp < 0xe000)
    ) {
      throw new Error(`invalid UTF-8 sequence at ${i}`);
    }
    if (cp >= 0x10000) units.push(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
    else units.push(cp);
    i += extra + 1;
  }
  flush();
  return parts.join('');
}
