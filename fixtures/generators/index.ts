import type { EditorCase, GeneratorName, PureCase } from '../format.ts';
import { burst } from './burst.ts';
import { provenance } from './provenance.ts';
import { Sha256 } from './sha256.ts';
import { addCounts, type Generator } from './types.ts';
import { unicode } from './unicode.ts';

export { type BurstPart, type BurstSpec, burst, reviewedPairs } from './burst.ts';
export { type Random, xorshift32 } from './prng.ts';
export { type ProvenanceOp, type ProvenanceSpec, provenance, provenanceGraphemes } from './provenance.ts';
export { Sha256, sha256 } from './sha256.ts';
export { addCounts, type Generated, type Generator } from './types.ts';
export { cursorsPerDraft, type UnicodeSpec, unicode, unicodeChunks } from './unicode.ts';

// biome-ignore lint/suspicious/noExplicitAny: each generator has its own spec type.
export const generators: Record<GeneratorName, Generator<any, EditorCase | PureCase>> = { burst, unicode, provenance };

export function generatorOf(name: string): Generator<unknown, EditorCase | PureCase> {
  const generator = (generators as Record<string, Generator<unknown, EditorCase | PureCase> | undefined>)[name];
  if (!generator) throw new Error(`unknown generator "${name}"`);
  return generator;
}

export interface Summary {
  generator: string;
  seed: number;
  size: number;
  counts: Record<string, number>;
  /** SHA-256 over every generated case as one JSON line: identical on every runtime, or the seed can't be replayed. */
  streamHash: string;
}

export function summarize(name: string, seed: number, size: number): Summary {
  const generator = generatorOf(name);
  const counts: Record<string, number> = {};
  const hash = new Sha256();
  for (const generated of generator.generate(seed, size)) {
    addCounts(counts, generated.counts);
    hash.update(JSON.stringify(generated.case)).update('\n');
  }
  return { generator: name, seed, size, counts, streamHash: hash.digest() };
}
