// Reads the regular files out of an uncompressed tar archive (ustar, with GNU
// long names and pax path records), so the build can use the SCOWL release
// archive exactly as pinned instead of an unpacked copy that could drift.

const BLOCK = 512;

export class TarError extends Error {
  constructor(message: string) {
    super(`tar: ${message}`);
    this.name = 'TarError';
  }
}

function field(block: Uint8Array, start: number, length: number): string {
  let end = start;
  while (end < start + length && block[end] !== 0) end++;
  return String.fromCharCode(...block.subarray(start, end));
}

function octal(block: Uint8Array, start: number, length: number, what: string): number {
  const text = field(block, start, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new TarError(`bad ${what} "${text}"`);
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function checksumOk(block: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (block[i] as number);
  return sum === octal(block, 148, 8, 'checksum');
}

/** Path → contents for every regular file. Directories, links and devices are skipped. */
export function readTar(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let longName: string | undefined;
  for (let at = 0; at + BLOCK <= archive.length; ) {
    const header = archive.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) break;
    if (!checksumOk(header)) throw new TarError(`header checksum mismatch at byte ${at}`);
    const size = octal(header, 124, 12, 'size');
    const type = String.fromCharCode(header[156] as number);
    const body = archive.subarray(at + BLOCK, at + BLOCK + size);
    if (body.length !== size) throw new TarError(`truncated entry at byte ${at}`);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = field(body, 0, body.length);
      continue;
    }
    if (type === 'x') {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(body));
      if (path) longName = path[1];
      continue;
    }
    // Only POSIX ustar has a name prefix; old GNU headers keep times there.
    const posix = field(header, 257, 6) === 'ustar' && header[262] === 0;
    const prefix = posix ? field(header, 345, 155) : '';
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type === '0' || type === '\0') files.set(name, body);
  }
  return files;
}
