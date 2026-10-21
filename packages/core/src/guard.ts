// Fail open (02-architecture § Fail open; lessons 15, 23): a bug in Murmo must
// never eat a key or take the host down. Pi exits on an uncaught throw; Claude
// skips a handler that throws or runs past 50 ms. Every callback the adapter
// calls goes through `wrap`, which returns the safe answer on a throw, and
// every session task reports its errors here. After `limit` errors in one
// session the guard trips once: the session turns itself off with one notice.

export const FAILURE_LIMIT = 3;

export class FailOpen {
  readonly #limit: number;
  readonly #trip: (error: unknown) => void;
  #failures = 0;
  #tripped = false;

  constructor(trip: (error: unknown) => void, limit = FAILURE_LIMIT) {
    this.#trip = trip;
    this.#limit = limit;
  }

  get failures(): number {
    return this.#failures;
  }

  get tripped(): boolean {
    return this.#tripped;
  }

  /** Records one failure; the `limit`-th trips the guard, exactly once. */
  record(error: unknown): void {
    this.#failures++;
    if (this.#tripped || this.#failures < this.#limit) return;
    this.#tripped = true;
    try {
      this.#trip(error);
    } catch {
      // Turning off must not throw into the host either.
    }
  }

  /** `fn`, except that a throw returns `safe` and is recorded. Never throws. */
  wrap<A extends unknown[], R>(fn: (...args: A) => R, safe: R): (...args: A) => R {
    return (...args: A): R => {
      try {
        return fn(...args);
      } catch (error) {
        this.record(error);
        return safe;
      }
    };
  }
}
