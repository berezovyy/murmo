// Python's `random.Random` (CPython 3.12+: MT19937, init_by_array seeding,
// getrandbits-based randbelow), for the parts round 6's slip generator used:
// random(), randrange(n), choice() and choices(weights). Integer and IEEE
// double arithmetic only, so a seed replays exactly the stream Python made.
// That lets the round-6 evaluation stream (seed 6002) be regenerated instead
// of committing its 400,000 events.

const N = 624;
const M = 397;

export class PythonRandom {
  private readonly mt = new Uint32Array(N);
  private index = N + 1;

  /** `random.Random(seed)` for a non-negative integer seed below 2^53. */
  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed must be a non-negative safe integer');
    // CPython splits abs(seed) into 32-bit words, least significant first.
    const key: number[] = [];
    for (let s = seed; s > 0; s = Math.floor(s / 2 ** 32)) key.push(s % 2 ** 32);
    if (key.length === 0) key.push(0);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] as number;
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  private initByArray(key: readonly number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1] as number;
      mt[i] = ((mt[i] as number) ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + (key[j] as number) + j;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] as number;
      mt[i] = ((mt[i] as number) ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private uint32(): number {
    const mt = this.mt;
    if (this.index >= N) {
      for (let k = 0; k < N; k++) {
        const y = ((mt[k] as number) & 0x80000000) | ((mt[(k + 1) % N] as number) & 0x7fffffff);
        mt[k] = (mt[(k + M) % N] as number) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = mt[this.index++] as number;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** A double in [0, 1) with 53 random bits, as `random.random()`. */
  random(): number {
    const a = this.uint32() >>> 5;
    const b = this.uint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** `getrandbits(k)` for 1 ≤ k ≤ 32: the top k bits of one output. */
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 1 || k > 32) throw new Error(`getrandbits(${k}) is out of range`);
    return this.uint32() >>> (32 - k);
  }

  /** `_randbelow(n)`: rejection sampling on n's bit length. */
  randbelow(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n >= 2 ** 32) throw new Error(`randbelow(${n}) is out of range`);
    const k = 32 - Math.clz32(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randrange(n: number): number {
    return this.randbelow(n);
  }

  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('choice from an empty list');
    return items[this.randbelow(items.length)] as T;
  }

  /** `choices(population, weights, k=k)`: cumulative weights and a right bisection per draw. */
  choices<T>(population: readonly T[], weights: readonly number[], k: number): T[] {
    if (population.length !== weights.length || population.length === 0) throw new Error('choices: bad weights');
    const cumulative: number[] = [];
    let total = 0;
    for (const w of weights) {
      total += w;
      cumulative.push(total);
    }
    const out: T[] = [];
    const hi = population.length - 1;
    for (let draw = 0; draw < k; draw++) {
      const x = this.random() * total;
      let lo = 0;
      let top = hi;
      while (lo < top) {
        const mid = (lo + top) >>> 1;
        if (x < (cumulative[mid] as number)) top = mid;
        else lo = mid + 1;
      }
      out.push(population[lo] as T);
    }
    return out;
  }
}
