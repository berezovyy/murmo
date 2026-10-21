// The pinned build inputs (inputs/sources.json). Every input is read through
// here and checked against its SHA-256 first, so a build can't silently use a
// changed word list, and nothing outside inputs/ is ever read: not the system
// dictionary, not a vocabulary cache, not the network (docs/plan/12, E3).

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { SourcePin } from '@murmo/lang';
import { readTar } from './tar.ts';

export const packageDir = fileURLToPath(new URL('..', import.meta.url));
export const defaultInputsDir = join(packageDir, 'inputs');
export const sourcesFile = 'sources.json';

export interface InputPin {
  readonly name: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  /** For compressed inputs, the SHA-256 of the decompressed bytes. */
  readonly contentSha256?: string;
  readonly version: string;
  readonly url?: string;
  readonly license: string;
  readonly notice?: string;
  readonly role: SourcePin['role'];
  readonly use: string;
}

export interface SourcesFile {
  readonly about: string;
  readonly inputs: readonly InputPin[];
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/** Every input, checked, with text inputs decoded. */
export interface Inputs {
  readonly dir: string;
  readonly pins: readonly InputPin[];
  /** SCOWL `final/` lists by file name (`american-words.10`, ...), latin-1 decoded, one entry per line. */
  readonly scowlLists: ReadonlyMap<string, readonly string[]>;
  readonly scowlCopyright: Uint8Array;
  readonly scowlRoot: string;
  readonly web2: readonly string[];
  readonly projectTerms: readonly string[];
  readonly programmingTerms: readonly string[];
  readonly baseVetoes: Readonly<Record<string, string>>;
  readonly authored: readonly string[];
  readonly authoredReview: AuthoredReview;
  readonly casePolicyBytes: Uint8Array;
  readonly inlineOverrides: readonly string[];
}

export interface AuthoredReview {
  /** Authored keys rejected by hand review, with the reason. */
  readonly rejected: Readonly<Record<string, string>>;
  /** Corrections allowed although no word list contains them (programming words). */
  readonly programmingTargets: readonly string[];
  /** Why each deliberate exception is kept, for the reviewers. */
  readonly exceptionNotes: Readonly<Record<string, string>>;
}

export function readSources(dir = defaultInputsDir): SourcesFile {
  return JSON.parse(readFileSync(join(dir, sourcesFile), 'utf8')) as SourcesFile;
}

/** Reads one pinned input, refusing it unless size and SHA-256 match (and the content hash, when compressed). */
function readPinned(dir: string, pin: InputPin): Uint8Array {
  const bytes = readFileSync(join(dir, pin.file));
  const digest = sha256(bytes);
  if (bytes.length !== pin.bytes || digest !== pin.sha256) {
    throw new InputError(
      `input ${pin.file} is ${bytes.length} bytes with SHA-256 ${digest}; sources.json pins ${pin.bytes} bytes, ${pin.sha256}. ` +
        'If the change is intended, run `murmo-lang-en pin` and review the diff.',
    );
  }
  if (pin.contentSha256 === undefined) return bytes;
  const content = gunzipSync(bytes);
  if (sha256(content) !== pin.contentSha256)
    throw new InputError(`input ${pin.file}: decompressed content does not match`);
  return content;
}

// Python's str.splitlines() also breaks at these; round 7's line numbers count
// only LF, so an input holding any of them is refused rather than renumbered.
const otherBreaks = new Set([0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029]);

/** Splits text into lines as Python's `str.splitlines()` does for LF-only text. */
export function lines(text: string, what: string): string[] {
  for (let i = 0; i < text.length; i++) {
    if (otherBreaks.has(text.charCodeAt(i))) throw new InputError(`${what} has a line separator other than LF at ${i}`);
  }
  const out = text.split('\n');
  if (out[out.length - 1] === '') out.pop();
  return out;
}

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
const utf8 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');

export function loadInputs(dir = defaultInputsDir): Inputs {
  const sources = readSources(dir);
  const byName = new Map(sources.inputs.map((p) => [p.name, p]));
  const need = (name: string): Uint8Array => {
    const pin = byName.get(name);
    if (!pin) throw new InputError(`sources.json has no input "${name}"`);
    return readPinned(dir, pin);
  };

  const scowl = readTar(gunzipSync(need('scowl')));
  const scowlPin = byName.get('scowl') as InputPin;
  const scowlRoot = `scowl-${scowlPin.version}`;
  const scowlLists = new Map<string, string[]>();
  for (const [path, bytes] of scowl) {
    const name = path.slice(`${scowlRoot}/final/`.length);
    if (!path.startsWith(`${scowlRoot}/final/`) || name.includes('/') || name === '') continue;
    scowlLists.set(name, lines(latin1(bytes), path));
  }
  const scowlCopyright = scowl.get(`${scowlRoot}/Copyright`);
  if (!scowlCopyright) throw new InputError(`the SCOWL archive has no ${scowlRoot}/Copyright`);
  if (scowlLists.size === 0) throw new InputError(`the SCOWL archive has no ${scowlRoot}/final/ lists`);

  return {
    dir,
    pins: sources.inputs,
    scowlLists,
    scowlCopyright,
    scowlRoot,
    web2: lines(utf8(need('web2')), 'web2'),
    projectTerms: lines(utf8(need('project-terms')), 'project-terms'),
    programmingTerms: lines(utf8(need('programming-terms')), 'programming-terms'),
    baseVetoes: JSON.parse(utf8(need('base-vetoes'))) as Record<string, string>,
    authored: lines(utf8(need('authored')), 'authored.txt'),
    authoredReview: JSON.parse(utf8(need('authored-review'))) as AuthoredReview,
    casePolicyBytes: need('case-policy'),
    inlineOverrides: lines(utf8(need('inline-overrides')), 'inline-overrides.txt'),
  };
}

/** Re-pins every input to its current bytes. Maintainers run this after a reviewed input change. */
export function pinInputs(dir = defaultInputsDir): SourcesFile {
  const sources = readSources(dir);
  const inputs = sources.inputs.map((pin): InputPin => {
    const bytes = readFileSync(join(dir, pin.file));
    const pinned: InputPin = { ...pin, bytes: bytes.length, sha256: sha256(bytes) };
    return pin.contentSha256 === undefined ? pinned : { ...pinned, contentSha256: sha256(gunzipSync(bytes)) };
  });
  const updated = { ...sources, inputs };
  writeFileSync(join(dir, sourcesFile), `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}
