// xorshift32, exactly as the prototypes ran it (experiments/platform/core/fuzz.mjs
// seed 0x11c0ffee; devkit/regression/burst-fuzz.mjs seed 1306637). Every
// generator draws from it, so a seed replays the same stream on every runtime.

export interface Random {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
}

export function xorshift32(seed: number): Random {
  if (!Number.isInteger(seed) || seed === 0)
    throw new RangeError(`xorshift32 needs a nonzero integer seed, got ${seed}`);
  // `state` stays a signed 32-bit integer after each shift, as in the prototypes.
  let state = seed | 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    pick<T>(items: readonly T[]): T {
      const item = items[int(items.length)];
      if (item === undefined) throw new RangeError('pick from an empty list');
      return item;
    },
  };
}
